"""Auth requirement resolver — endpoint-level auth from annotations / deps.

Reads signals from the four supported backend frameworks and produces
a uniform `(auth_required, security_scheme, required_roles)` triple.

Signals consumed:

  * **FastAPI** — `Depends(...)` in handler signature. Common patterns:
    `Depends(require_admin)`, `Depends(get_current_user)`. We classify
    by function name heuristics: `*admin*` → role, `*user*` → bearer.
  * **Spring** — `@PreAuthorize("hasRole('ADMIN')")` annotation;
    `@Secured({"ADMIN"})`.
  * **JAX-RS** — `@RolesAllowed({"admin"})`.
  * **ASP.NET** — `[Authorize]`, `[Authorize(Roles = "Admin")]`.

Output:
    {
      "auth_required": True,
      "security_scheme": "bearer" | "role" | None,
      "required_roles": ["admin", ...],
    }
"""

from __future__ import annotations

import re
from typing import Any


def fastapi_auth_from_signature(
    handler_params: list[Any],
) -> dict[str, Any]:
    """Look at `HandlerParam` objects with `location='auth_dep'`."""
    deps = [p for p in handler_params if getattr(p, "location", None) == "auth_dep"]
    if not deps:
        return {"auth_required": False, "security_scheme": None, "required_roles": []}

    roles: list[str] = []
    # The dependency type carries the role hint. Best-effort name parse.
    for p in deps:
        type_name = (p.type or "").lower()
        if "admin" in type_name:
            roles.append("admin")
        elif "staff" in type_name:
            roles.append("staff")

    return {
        "auth_required": True,
        "security_scheme": "bearer",  # FastAPI's common pattern
        "required_roles": roles,
    }


_SPRING_ROLE_RE = re.compile(r"""hasRole\(\s*['"]([^'"]+)['"]\s*\)""")
_SPRING_AUTHORITY_RE = re.compile(r"""hasAuthority\(\s*['"]([^'"]+)['"]\s*\)""")


def spring_auth_from_annotations(
    method_annotations: list[dict[str, Any]],
    class_annotations: list[dict[str, Any]],
) -> dict[str, Any]:
    """Merge method-level + class-level Spring Security annotations.

    Method-level annotations win (most-specific).
    """
    roles: list[str] = []
    auth_required = False

    for source in (class_annotations, method_annotations):
        for ann in source:
            name = ann.get("name", "")
            kwargs = ann.get("kwargs", {}) or {}
            value = kwargs.get("value") or kwargs.get("0")
            if name == "PreAuthorize" and isinstance(value, str):
                auth_required = True
                roles.extend(_SPRING_ROLE_RE.findall(value))
                roles.extend(_SPRING_AUTHORITY_RE.findall(value))
            elif name == "Secured" and isinstance(value, (str, list)):
                auth_required = True
                if isinstance(value, list):
                    roles.extend(str(v) for v in value)
                else:
                    roles.append(value)

    return {
        "auth_required": auth_required,
        "security_scheme": "role" if auth_required else None,
        "required_roles": sorted(set(roles)),
    }


def jaxrs_auth_from_annotations(
    method_annotations: list[dict[str, Any]],
    class_annotations: list[dict[str, Any]],
) -> dict[str, Any]:
    """`@RolesAllowed`, `@DenyAll`, `@PermitAll`."""
    roles: list[str] = []
    auth_required = False
    permit_all = False

    for source in (class_annotations, method_annotations):
        for ann in source:
            name = ann.get("name", "")
            kwargs = ann.get("kwargs") or {}
            value = kwargs.get("value")
            if name == "RolesAllowed":
                auth_required = True
                if isinstance(value, list):
                    roles.extend(str(v) for v in value)
                elif isinstance(value, str):
                    roles.append(value)
            elif name == "DenyAll":
                auth_required = True
            elif name == "PermitAll":
                permit_all = True

    if permit_all:
        # PermitAll overrides — even on a secured class, this method allows anonymous.
        return {"auth_required": False, "security_scheme": None, "required_roles": []}

    return {
        "auth_required": auth_required,
        "security_scheme": "role" if auth_required else None,
        "required_roles": sorted(set(roles)),
    }


def aspnet_auth_from_attributes(
    method_attributes: list[dict[str, Any]],
    class_attributes: list[dict[str, Any]],
) -> dict[str, Any]:
    """`[Authorize]`, `[Authorize(Roles = "Admin,Staff")]`, `[AllowAnonymous]`."""
    roles: list[str] = []
    auth_required = False
    allow_anonymous = False

    for source in (class_attributes, method_attributes):
        for attr in source:
            name = attr.get("name", "")
            kwargs = attr.get("kwargs") or {}
            if name == "Authorize":
                auth_required = True
                roles_value = kwargs.get("Roles") or kwargs.get("value")
                if isinstance(roles_value, str):
                    roles.extend(r.strip() for r in roles_value.split(",") if r.strip())
            elif name == "AllowAnonymous":
                allow_anonymous = True

    if allow_anonymous:
        return {"auth_required": False, "security_scheme": None, "required_roles": []}

    return {
        "auth_required": auth_required,
        "security_scheme": "bearer" if auth_required else None,
        "required_roles": sorted(set(roles)),
    }
