"""Response shape reader — status codes + response types from decorators.

FastAPI carries `status_code=` and `response_model=` on the route
decorator. Spring uses `@ResponseStatus` + the method return type.
JAX-RS uses `@Produces` + return type. ASP.NET uses
`[ProducesResponseType(typeof(T), 200)]`.

Output is a list of `ResponseSpec`-shaped dicts so the projection
layer can construct typed responses.
"""

from __future__ import annotations

from typing import Any


def fastapi_responses_from_kwargs(
    decorator_kwargs: dict[str, Any]
) -> list[dict[str, Any]]:
    """`@app.post(..., status_code=201, response_model=UserOut)` →
    `[{"status_code": 201, "schema_ref": "UserOut"}]`. Plus 422 for
    Pydantic validation when `response_model` is present.
    """
    out: list[dict[str, Any]] = []
    status = decorator_kwargs.get("status_code")
    if isinstance(status, str) and status.startswith("status."):
        status = _http_constant_to_int(status)
    if status is None and "response_model" in decorator_kwargs:
        status = 200
    if status is None:
        status = 200

    schema_ref = decorator_kwargs.get("response_model")
    if isinstance(schema_ref, str) and schema_ref in ("None", "True", "False"):
        schema_ref = None

    out.append({
        "status_code": int(status) if str(status).isdigit() else status,
        "schema_ref": schema_ref,
    })

    # FastAPI auto-generates 422 for Pydantic validation errors when a
    # request body model is in play. The body extraction happens in
    # signature_reader; the consumer can decide whether to add a 422.

    return out


_HTTP_CONSTANTS: dict[str, int] = {
    "status.HTTP_200_OK": 200,
    "status.HTTP_201_CREATED": 201,
    "status.HTTP_202_ACCEPTED": 202,
    "status.HTTP_204_NO_CONTENT": 204,
    "status.HTTP_400_BAD_REQUEST": 400,
    "status.HTTP_401_UNAUTHORIZED": 401,
    "status.HTTP_403_FORBIDDEN": 403,
    "status.HTTP_404_NOT_FOUND": 404,
    "status.HTTP_409_CONFLICT": 409,
    "status.HTTP_422_UNPROCESSABLE_ENTITY": 422,
    "status.HTTP_500_INTERNAL_SERVER_ERROR": 500,
}


def _http_constant_to_int(name: str) -> int | None:
    return _HTTP_CONSTANTS.get(name)


def spring_responses_from_method(
    method_annotations: list[dict[str, Any]],
    return_type: str | None,
) -> list[dict[str, Any]]:
    """Spring: look for `@ResponseStatus(HttpStatus.CREATED)` or
    return type wrapped in `ResponseEntity`. Defaults to 200.
    """
    status = 200
    for ann in method_annotations:
        if ann.get("name") == "ResponseStatus":
            value = ann.get("kwargs", {}).get("value") or ann.get("kwargs", {}).get("code")
            if isinstance(value, str):
                status = _spring_http_status_constant(value) or 200

    return [{
        "status_code": status,
        "schema_ref": return_type,
    }]


_SPRING_HTTP_STATUS: dict[str, int] = {
    "HttpStatus.OK": 200,
    "HttpStatus.CREATED": 201,
    "HttpStatus.ACCEPTED": 202,
    "HttpStatus.NO_CONTENT": 204,
    "HttpStatus.BAD_REQUEST": 400,
    "HttpStatus.UNAUTHORIZED": 401,
    "HttpStatus.FORBIDDEN": 403,
    "HttpStatus.NOT_FOUND": 404,
    "HttpStatus.CONFLICT": 409,
    "HttpStatus.INTERNAL_SERVER_ERROR": 500,
}


def _spring_http_status_constant(value: str) -> int | None:
    return _SPRING_HTTP_STATUS.get(value)


def csharp_responses_from_method(
    method_attributes: list[dict[str, Any]],
    return_type: str | None,
) -> list[dict[str, Any]]:
    """`[ProducesResponseType(typeof(UserDto), 200)]` →
    `{status_code: 200, schema_ref: "UserDto"}`.
    """
    out: list[dict[str, Any]] = []
    for attr in method_attributes:
        if attr.get("name") != "ProducesResponseType":
            continue
        kwargs = attr.get("kwargs") or {}
        # The status code may be the 2nd positional or a `StatusCode = …` kwarg.
        # We only see `value` (first positional) and named kwargs from the parser.
        # Type-of() expressions appear as raw text — best-effort.
        status_code = (
            kwargs.get("StatusCode")
            or kwargs.get("Type")  # heuristic — varies by call shape
            or 200
        )
        try:
            status = int(status_code) if isinstance(status_code, (int, str)) and str(status_code).isdigit() else 200
        except (TypeError, ValueError):
            status = 200
        out.append({"status_code": status, "schema_ref": return_type})
    if not out:
        out.append({"status_code": 200, "schema_ref": return_type})
    return out
