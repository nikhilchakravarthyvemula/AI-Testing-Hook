# Orchestration Layer

The orchestrator that wraps the three working layers into one end-to-end run.
Where `context-layer/scan.mjs` sequences sub-components *inside* a layer, this
sequences the **layers themselves**.

```
inputs (--url / --codebase / creds)
  │
  ▼
scan      → context-layer/scan.mjs               crawl + extract + index → knowledge base
  │
  ▼
generate  → generation-layer/api-test-generator  build the runnable suite (execute=false, no side effects)
  │
  ▼
execute   → execution-layer/test-executor/run.mjs  run the suite → output/execution/results.json
```

| File | Role |
|---|---|
| `pipeline.mjs` | Stage runner. Reads its config from env, runs each stage in its own child process, stops on first failure (unless `ORCH_CONTINUE=1`), and writes a run artifact to `output/orchestration/run-<ts>.json`. |

## Run it

```bash
# full run
testo pipeline --url http://localhost:8000 --codebase /path/to/app --user a@b --pass p

# subset / re-run without re-scanning
testo pipeline --url http://localhost:8000 --stages generate,execute --user a@b --pass p

# generate only (inspect the suite, run later with `testo run`)
testo pipeline --url http://localhost:8000 --no-execute
```

## Why generate and execute are separate stages

The generation layer (`api-test-generator`, with `execute=false`) writes a
**self-contained suite** — `curls/*.sh`, `_login.sh`, `config.sh`, `run-all.sh`.
That makes the executor a real, independent seam: `test-executor/run.mjs` just
runs `run-all.sh` (which logs in for a fresh token and loops the curls) and
normalizes its output into `results.json`. The suite is also portable — a user
can download it and run `./run-all.sh` themselves.

## Env contract (set by `interfaces/cli/commands/pipeline.mjs`)

| Var | Meaning |
|---|---|
| `BASE_URL` | live target to crawl + test |
| `TARGET_CODEBASE` | local repo to analyse |
| `LOGIN_EMAIL` / `LOGIN_PASSWORD` | crawler login + API token |
| `ORCH_STAGES` | csv subset/order of `scan,generate,execute` (default: all) |
| `ORCH_EXECUTE` | `0` drops the execute stage (`--no-execute`) |
| `ORCH_MAX_TESTS` | cap APIs the generator turns into tests |
| `ORCH_CONTINUE` | `1` keeps going after a stage fails |
