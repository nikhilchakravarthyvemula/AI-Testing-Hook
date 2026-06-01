"""Registered framework extractors for the codebase source.

Explicit imports — no plugin discovery. Adding a framework extractor
means dropping the file under `extractors/<area>/<name>.py` and adding
one line here.

Order is dispatch order. Within the codebase source, there's no
deduplication; each extractor produces independently and the runner
aggregates.
"""

from __future__ import annotations

from .extractors.backend.csharp_aspnet import CSharpAspNetExtractor
from .extractors.backend.java_jaxrs import JavaJaxRsExtractor
from .extractors.backend.java_spring import JavaSpringExtractor
from .extractors.backend.python_django import PythonDjangoExtractor
from .extractors.backend.python_fastapi import PythonFastAPIExtractor
from .extractors.backend.python_flask import PythonFlaskExtractor
from .extractors.facts.conventions import ConventionsExtractor
from .extractors.facts.csproj import CsprojFactsExtractor
from .extractors.facts.package_json import PackageJSONFactsExtractor
from .extractors.facts.pom_xml import PomXMLFactsExtractor
from .extractors.facts.pyproject import PyProjectFactsExtractor
from .extractors.frontend.angular_router import AngularRouterExtractor
from .extractors.frontend.astro import AstroExtractor
from .extractors.frontend.ember import EmberExtractor
from .extractors.frontend.nextjs_app import NextJSAppExtractor
from .extractors.frontend.nextjs_pages import NextJSPagesExtractor
from .extractors.frontend.nuxt import NuxtExtractor
from .extractors.frontend.preact_router import PreactRouterExtractor
from .extractors.frontend.qwik import QwikExtractor
from .extractors.frontend.react_router import ReactRouterExtractor
from .extractors.frontend.remix import RemixExtractor
from .extractors.frontend.solidstart import SolidStartExtractor
from .extractors.frontend.sveltekit import SvelteKitExtractor
from .extractors.frontend.vue_router import VueRouterExtractor
from .extractors.specs.markdown_apispec import MarkdownAPISpecExtractor
from .extractors.specs.openapi_file import OpenAPIFileExtractor
from .framework_port import Extractor


def default_framework_extractors() -> list[Extractor]:
    """All framework extractors registered in dispatch order."""
    return [
        # Backend
        JavaSpringExtractor(),
        JavaJaxRsExtractor(),
        CSharpAspNetExtractor(),
        PythonFastAPIExtractor(),
        PythonFlaskExtractor(),
        PythonDjangoExtractor(),
        # Frontend (convention-based first)
        NextJSAppExtractor(),
        NextJSPagesExtractor(),
        SvelteKitExtractor(),
        NuxtExtractor(),
        SolidStartExtractor(),
        AstroExtractor(),
        RemixExtractor(),
        QwikExtractor(),
        # Frontend (declaration-based)
        ReactRouterExtractor(),
        VueRouterExtractor(),
        AngularRouterExtractor(),
        EmberExtractor(),
        PreactRouterExtractor(),
        # Specs
        OpenAPIFileExtractor(),
        MarkdownAPISpecExtractor(),
        # Facts
        PackageJSONFactsExtractor(),
        PyProjectFactsExtractor(),
        PomXMLFactsExtractor(),
        CsprojFactsExtractor(),
        ConventionsExtractor(),
    ]
