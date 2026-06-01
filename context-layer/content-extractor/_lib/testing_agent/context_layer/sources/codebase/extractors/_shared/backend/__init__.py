"""Shared backend AST readers.

Generic across frameworks — each reader takes an AST node + a framework
hint, returns structured data. Per-framework extractors stitch the
data into APIEndpoint objects.
"""
