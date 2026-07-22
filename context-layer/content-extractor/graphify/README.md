# context-layer/content-extractor/graphify

The **pipeline adapter** for graphify. `run.mjs` auto-discovers this folder as
source id `graphify` (it has `extract.mjs`), gated on `TARGET_CODEBASE`.

`extract.mjs` invokes the `graphifyy` pip tool **directly and
deterministically** — no harness, no LLM:

```bash
_lib/.venv/bin/python -m graphify update <TARGET_CODEBASE> --force   # AST extract + build + cluster + report + graph.html
_lib/.venv/bin/python -m graphify tree --graph … --output … --root … # D3 collapsible tree
```

then writes a normalized source bundle at `output/graphify/bundle.json`
(pointing at the produced `graph.json`) with a freshness guard — a stale
`graph.json` on disk is never reported as a fresh extraction.

## Output redirection

`GRAPHIFY_OUT` (absolute, set by the adapter) makes the tool write everything
into `output/graphify/` directly. The subprocess runs with `cwd=output/` so the
tool's cwd-relative strays also land inside the gitignored output folder.
Override the destination with `GRAPHIFY_OUT_DIR`.

## LLM-semantic pass

Deliberately **disabled** (BYO-LLM architecture: no internal LLM, and no
Python host-routing yet). `graphify update` is the tool's own LLM-free path;
the semantic labeling (`graphify label`) can return once a Python sampling
bridge client exists.

## Interpreter

Runs under the shared venv at `context-layer/content-extractor/_lib/.venv`;
`graphifyy` is declared in `_lib/requirements.txt` (LLM extras not installed).
