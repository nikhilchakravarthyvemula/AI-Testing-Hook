# perf-test-generator

Scenario → **JMeter load-test plan** (`.jmx`). Deterministic, **no LLM**. Generating the plan
needs **nothing installed**; only `--run` needs Apache JMeter on PATH.

```bash
node generation-layer/perf-test-generator/gen.mjs scenario.json          # generate only
node generation-layer/perf-test-generator/gen.mjs scenario.json --run    # also execute (needs jmeter)
TOKEN=<JWT> bash output/generation/perf-tests/run-perf.sh                 # run later, with auth
```

## What it emits (`output/generation/perf-tests/`)
- `plan.jmx` — Thread Group (`vus`/`rampUpS`/`durationS`), HTTP Header Manager
  (`Authorization: Bearer ${__P(token)}`), one HTTP Sampler per `perf.httpFlow` entry, Summary +
  Aggregate collectors → `results.jtl`. Open it in the JMeter GUI or run headless.
- `run-perf.sh` — `jmeter -n -t plan.jmx -l results.jtl -Jtoken=$TOKEN`.
- `parse-jtl.mjs` — reads `results.jtl` (CSV) → p50/p95/p99 + error-rate.
- `results.json` + `report.md` — plan summary, thresholds, and (if run) pass/fail vs
  `perf.jmeter.thresholds` (p95, error-rate).

The emitted `.jmx` is validated for XML well-formedness before it's handed off.

## Auth (OAuth/PKCE note)
Against SSO targets like superalign, a bearer token can't be auto-minted (Keycloak
authorization-code + PKCE), so the plan parameterises the token as `${__P(token)}`. Pass a JWT
at run time: `TOKEN=<JWT> bash run-perf.sh`. For simpler targets (the typical client scenario),
drop the token in the same way.

## Scenario shape
`perf.httpFlow` (method/path/auth) and `perf.jmeter` (load profile + thresholds) live under
`scenario.json` at the repo root. The httpFlow maps directly to context-layer `apis.json`
(`method`, `path`, `observedAuth`, `avgRequestMs` baseline); the load profile + thresholds are
human SLO choices.

> Standalone Node script (run via `node`). Not yet registered as a skill.
