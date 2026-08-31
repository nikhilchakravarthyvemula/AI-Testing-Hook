# Spec 20 — The feature map: grouping, hierarchy, edges, and test paths

_Target when built: a new edge emitter `context-layer/feature-extractor/lib/edges.mjs`; a rewritten
assignment ladder under `lib/assign/`; a committed `.testo/feature-lock.json` emitted as an
OpenAPI 3.2 tag tree; three new delegation kinds in `byo-llm-poc/ctx.mjs`
(`feature-propose` / `feature-assign` / `feature-causation`); scenario generation in
`generation-layer/feature-slice/`; and a crawler capture patch for link container signatures.
**No new Python, no new runtime dependency, no embeddings service.**_

> **TL;DR** — A **feature** is a user-facing capability (Login, Search, Cart, Checkout, Orders);
> many entities collapse into one (`/orders`, `/orders/{id}`, `/orders/past` → **Orders**). The
> **feature map** is a graph whose *nodes are features* and whose *edges are transitions between
> them*, and a **test case is a path through it**. Assignment is overwhelmingly **deterministic
> rules** — clustering is one rung, and the LLM is a bounded last resort that emits *rules, not
> per-entity labels*. Two blockers stand in the way today and they are independent: **nothing
> anywhere emits a feature-to-feature edge**, and **the crawl is empty because a login wall was
> detected and then ignored**. Fixing the crawl alone still yields zero edges. §10 lists every gap;
> about twelve are one-liners against data already on disk.

---

## 0. What we are building, and why the current output is wrong

Today `output/features/features.json` contains a three-way partition — `Graph`, `Https`, `Oidc`,
`_unassigned` — and **no `edges` array**. Its keys are `[config, features, generatedAt, source,
stats, target]`. That is a bucket list, not a map.

Worse, the buckets are wrong in instructive ways. `Https` is a URL *scheme* promoted to a feature.
`Graph` swallowed links to `/audit-log`, `/downloads`, `/endpoints`, `/extensions`, `/insights` —
**the entire feature list of the application, filed under one feature** — because interactions are
keyed on the first path segment of the page they *fire from*, and anchor text is never read.

The target application's real taxonomy is already sitting unread in `output/crawler/data/pages.json`:

```
Asset Graph · Remediation · Policies · Sessions · Insights · Endpoints · Audit Log · Downloads · Extensions
```

**Deriving the map is mostly a matter of reading data we already collect.**

---

## 1. The identity model (read this before §3)

**Assignment is not a global partition.** In the van Zelst et al. (2021) event-abstraction taxonomy,
fixed class-level n:1 mapping is 8 of 21 classified techniques and is framed as the restrictive
early approach the field moved away from; n:m is 13 of 21. The same endpoint legitimately belongs to
different capabilities depending on context — `GET /api/users/{id}` is **Addresses** inside a
checkout page-load and **Admin/Users** inside a settings page-load.

What *is* near-universal (21 of 21) is **n:1 at the instance level**: every observed occurrence is
assigned to exactly one feature occurrence.

> **So build `α(entity, context) → feature`, not a global template→feature lookup table.**
> `context` is the page-load, which the crawler already records — every row in
> `output/crawler/raw/requests.ndjson` carries `pageUrl` and `ts`.

This is what keeps the coverage rollup and `UNIQUE(scan_id, feature_id)` well-formed, and it is why
a class-level lookup would mislabel exactly the cross-feature edges the map exists to produce.

Determinism comes from a **deterministic output** (emit a definite label, not a distribution) and
from pinning a **stored vocabulary** (§6) — not from the mapping's cardinality.

---

## 2. Classification or clustering? Mostly neither

| Rung | Mechanism | Kind |
|---|---|---|
| R0 normalize · R1 declared · R2 nav-hub · R3 gazetteer · R5 shape-hash | deterministic rules | **not ML** |
| R4 co-access | co-occurrence graph | **clustering** |
| R6 lexical | LLR/MI ranking | scoring |
| R7 scan 1 | open-set grouping + naming | **unstructured** |
| R7 scan 2+ | closed-set assignment vs the lockfile | **structured classification** |

The bulk is rules — reproducible and unit-testable with no model. **Unstructured discovery happens
exactly once**; the lockfile converts every later scan into closed-set classification.

---

## 3. The assignment ladder

Every rung emits `(entityId, groupKey, rung, evidence)`. **A higher rung may never overwrite a lower
rung's assignment** — it may only claim what is unassigned, or file a merge *proposal* the CLI
adjudicates by rung precedence. Persist the winning rung on every membership row so the dashboard
can show why.

**R0 — NORMALIZE** (prerequisite, not assignment). Drop static assets — **715 of 871 captured
requests are `script`**. Strip scheme/host/query. Template by prefix-tree segment wildcarding with
cardinality thresholds plus explicit UUID/ULID/numeric detectors. Split **context** params (method,
origin, template, container signature) from **data** params (ids, form values). Entity key =
`sha1(method + origin + template)`.

> **Fix `apiPathSegment` before adding any levels.** Stripping the leading scope prefix (`/v1/`,
> `/api/`, date-versions) and `{param}` segments moved V-measure **0.44 → 0.85** on GitHub's 1,222
> real operations *at the same depth*. That is a larger win than any depth setting, and it is pure
> deterministic string work.

**R1 — DECLARED.** OpenAPI `tags` / `x-tagGroups`; code-extractor router/controller tree. Sufficient
alone when ≥70% of endpoints carry a non-`default`, noun-phrase tag.

**R2 — NAV-HUB.** *The rung the current code skips entirely, and the one that does the most work.*
Compute a container signature per anchor from the ancestor tag/role/data-slot chain. An anchor set is
**chrome** iff its `(signature, href-multiset)` recurs on ≥ `max(2, ceil(0.5·pages))` distinct pages;
single-page fallback: `<nav>`, `role=navigation`, or a `sidebar`/`menu` data-slot ancestor. Each
chrome anchor becomes a candidate feature: **label = anchor text, prefix = href path**. Discard
anchors resolving to the current page or no distinct route — that is what kills `Toggle Sidebar`.

> **Chrome does double duty.** The same repeated navigation that would ruin the edge quotient (§5)
> *is* the app's product-authored taxonomy. **Subtract it from the edges; harvest it as the nodes.**
> One detector fixes both halves, deterministically, with no model.

**R3 — GAZETTEER.** Fold the OIDC Discovery vocabulary plus `/login /logout /signin /sso /saml
/oauth /token /revoke /mfa /.well-known/*` into a single `auth` feature *before* any clustering.
The existing 9-entry map is correct in mechanism and fired on nothing this run because the observed
segment is `oidc`, which is absent from it.

**R4 — CO-ACCESS.** Case = one page-load; members = the templated API entities fired during it.
Weighted **undirected** graph, `w(a,b) = |cases containing both| / min(count(a), count(b))`.
**Undirected only** — parallel fetches within a page-load are concurrent, and a directly-follows
graph over concurrent activities manufactures spurious two-cycles. Proposes merges; never forces them.

**R5 — RESPONSE-SHAPE.** Canonicalize each JSON response's top-level key-set to a sorted shape hash;
equal hashes are a hard merge, partial overlap is a proposal. **37 bodies already sit in
`output/crawler/bodies/`.**

**R6 — LEXICAL** (weak — demote it, never lead with it). Score candidate labels with
**log-likelihood-ratio / mutual information** against a whole-corpus background — *not* tf-idf, which
selects what is merely salient rather than what is unique to a cluster. Emit a ranked top-3 shortlist.
Lexical-similarity decomposition over-fragments badly (8 clusters where experts had 3), and URL-text
classification tops out around macro-F 63.

**R7 — BOUNDED HOST-LLM** (§7). Residual only.

**Then run the UI↔API join.** Features discovered from pages (R2) and from endpoints (R1) live in
separate namespaces. Build the bipartite affinity matrix from the observed page→API relation and
Hungarian-match on Jaccard. The current code mashes both surfaces into one keyspace, which is why an
interaction on `/graph` and an endpoint `/v2/graph` collide into a feature named after a URL segment.

---

## 4. Hierarchy: three levels, and the URL gives you exactly two

**The quotient composes — confirmed.** This is grouping-based graph summarization (Koutra et al.,
CSUR 2018): node → supernode, edge → superedge, associative. Build **one** function
`contract(graph, membership) → graph` and apply it at each level. One edge engine serves every level.

**Depth is empirical, not a matter of taste:**

| Cut | V-measure vs GitHub's authored taxonomy (1,222 ops) |
|---|---|
| scope-stripped depth 1 | **0.85** vs 51 categories |
| depth 2 | **0.92** vs 165 leaves |
| depth 3 | **0.89** — it goes *down* |

Median path carries 2 literal segments. **So depth 1 ≈ feature, depth 2 ≈ sub-feature, and the
DOMAIN level cannot be derived from URLs at all** — take it from OpenAPI `x-tagGroups`, then the nav
chrome taxonomy (free, and it *is* the authored domain list), then one bounded LLM turn assigning
~15–60 feature labels into ~5–25 domains.

**Cap at three levels.** Nothing in the published world ships four, including AWS at ~32,000
operations. Inter-model agreement on taxonomy layers falls from Krippendorff α 0.469 at layer 1 to
0.372 at layer 4 — a fourth level is measurably less reproducible.

**Leaf size is the real invariant.** Median operations per authored tag: GitHub 5, Jira 5, Stripe ~4,
Twilio 2; across a 393-spec sample it drifts only 3.2 → 9.3 as specs grow from 25 to 500 operations.
So: **a leaf holds 3–10 endpoints; add a level when leaf count exceeds what one menu holds (~25).**

**Replace the global depth knob with an entity budget over a precomputed dendrogram.**
`FEAT_API_SEGMENT_DEPTH` applies one depth everywhere, which cannot express what API taxonomies
actually look like: they are power-law skewed (GitHub's `actions` holds 195 of 1,222 operations).
Compute the full contraction chain once per scan and store it; the renderer breadth-first-traverses
until a budget is spent (~30 nodes default, ~100 hard cap). That yields an **unbalanced cut** — the
fat bucket stays collapsed, thin branches expand.

**Which nodes expand:** split a node when its entity mass ≥ δ **and** ≥2 children each hold ≥5% of
its mass (TaxoAdapt's density rule; published δ = 40 documents, max_depth 2). Keep δ *fixed*, not
adaptive, so corpus growth is allowed to deepen the tree across scans — which is exactly the
trending behaviour we want.

> **The honest ceiling.** Stripe ships *zero* tags; its 26 sections are editorial invention
> (`Capital`, `Climate`, `Sigma`). GitHub's authored categories agree with the naive first URL
> segment **20.6%** of the time. Derivation yields a structurally faithful tree with plausible
> names — never the product's own words. Make every name overridable in the lockfile.

---

## 5. Edges — seven sources, none of them free

**"The edges come free from a groupBy" is false**, and false in the specific way that produces a
useless map. Quotienting raw navigation yields a near-complete graph because global nav appears on
every page: a 12-page app with a 3-item header manufactures **33 phantom edges**. Meanwhile
intra-feature edges collapse to self-loops and vanish.

| # | Source | Computation | Channel α |
|---|---|---|---|
| **E1** | Contextual nav | page→page anchors with **chrome subtracted**; require `w ≥ 2` or verb-phrase text (`^(view\|go to\|proceed\|continue\|track)\b`) | 0.6 |
| **E3** | Journey DFG | directly-follows over an ordered page-load sequence, segmented into cases by CFG back-edges; filters applied as a **log rewrite, never a graph edit** | 0.4 (×0.5 if synthetic) |
| **E4** | Form submission | page containing form → landing page after submit | 1.0 |
| **E5** | Redirects | split into **`auth-gate`** (a *precondition* — excluded from the DFG, feeds `P_setup`) and **`post-action`** (a genuine causal transition) | 0.8 |
| **E6** | **Write→read causal** | see below | 1.0 |
| **E7** | Spec-declared | OpenAPI `links`, `callbacks`, shared `$ref` | 1.0 `declared` |
| **E8** | Code-call | handler in F calls a service/model owned by G | 0.9 |

*(R4 co-access is an **assignment** signal, deliberately not an edge source — see §3.)*

### E6 — the headline edge

*"Once you do a payment, an order will be placed"* corresponds to **no link, no redirect, and no
navigation.** Nobody clicks from checkout to orders; the order materialises server-side. Directly-
follows misses it; eventually-follows over-reports it. It is recoverable only as a **data-flow join**:

```
POST /api/payments/authorize  →  {paymentIntentId: "pi_8Kd93ba"}        t
POST /api/orders              ←   carries pi_8Kd93ba in its request body t+118ms
                              →  {orderId: "112-3908431-2168247"}
GET  /api/orders?page=1       →   first element's orderId == that value  t+2.4s

        ⟹  Payments ──causal──▶ Orders
```

Harvest ID-like values from a mutation's request **and** response body (UUID/ULID, `^[a-z]+_[A-Za-z0-9]{8,}$`,
keys matching `/(^|_)(id|uuid|ref|number|token)$/i`); look for them in a subsequent GET's URL, query,
or response body within a session window (default 120s). One hard id-match, or ≥2 soft matches, or a
soft match plus an E5 post-action redirect. **Never store the raw joined value — only its key path
and a hash.**

Nothing in the literature does this; it is this design's own construction.

### Combination and filtering

**Never sum raw counts across channels** — the units are incomparable. Min-max normalise *within*
each channel, then `util(F,G) = Σ α_s · norm_s(F,G)`, persisting the full per-channel vector so the
UI can explain any edge in one click.

**Direction:** Heuristics-Miner dependency `d(F,G) = (|F>G| − |G>F|) / (|F>G| + |G>F| + 1)`. The `+1`
caps a single observation at 0.5 — a built-in low-evidence damper. Keep the dominant direction at
`|d| ≥ 0.6`; keep both when both exceed the preserve threshold; drop both at one observation each.

**Filtering:** per-node **local** retention, never a global top-k. Normalise each node's in- and
out-edges separately; an edge survives if either endpoint keeps it.

**Connectivity repair — the step most ports get wrong.** Local retention guarantees no node becomes
*isolated*, but not that the graph stays *connected*: a bridge that is the weakest edge at both
endpoints normalises to 0.0 on both sides and is always dropped. After filtering, compute weakly
connected components and re-add the single highest-`util` edge reconnecting each one. Do **not**
reach for minimal-sound-spanning-subgraph machinery — its NP-hardness comes entirely from a soundness
constraint a feature map does not need. An unreachable feature is a **finding**, not a defect to
repair by inventing an edge.

**Ambient features:** compute entropy over the directly-follows and directly-precedes ratio vectors.
**Do not delete high-entropy nodes** — a legitimate hub (Home, Auth, Search) scores high for the same
reason chrome does. Label them `ambient:true`, render as a band, exclude their edges from the DFG,
and keep them fully in the coverage rollup and in every `P_setup`.

**UI invariant (Disco's, and it matters):** the edge slider operates only over *currently visible*
nodes, so the map is never disconnected — and metrics are always computed on the **full** dataset
even when the view is simplified. Never let the abstraction level change reported coverage.

---

## 6. Stability — the lockfile

`.testo/feature-lock.json`, keyed by **app** (not scan), **committed to the user's repo**, and
emitted as an **OpenAPI 3.2 tag tree** (`name` + `summary` + `parent` + `kind`) so it is standard,
human-diffable in PRs, and round-trips through Redoc/Swagger UI/Scalar for free.

Per feature: `feature_id`, `label`, `label_history[]`, `anchors[]`, `predicate` (≤140 chars),
`birth_scan`, `last_seen_scan`, `status ∈ {active, dormant, retired}`, `llm_provenance`, and the
frozen threshold block.

**Identity is the lockfile, not a hash.** Mint `feature_id = f_<8 hex of sha256(sorted anchor set)>`
at birth, then freeze it forever. **Never derive identity from the label** — labels shift 8–28
percentage points under semantically-equivalent prompt paraphrase alone.

**Matching scan N to N−1**, first match wins, via Hungarian assignment so it is globally optimal and
order-independent:

1. Jaccard ≥ 0.5 over the **anchor set** — members assigned at R1–R3 only.
2. Jaccard ≥ 0.6 over full members.
3. Exact match on normalised label.
4. Otherwise mint new.

> Matching on the **full member set** — the textbook move — breaks precisely when it matters most:
> the first scan that gets past the login wall doubles every feature's members and shatters
> full-member Jaccard, while nav labels and OpenAPI tags are unchanged.

**Minting is density-gated, not creativity-gated.** A new feature is created only when residual
unassigned mass exceeds δ (default `max(8 entities, 5%)`). Below δ, entities sit in `unassigned` and
are reported as **coverage debt** — a first-class dashboard number. **Never regenerate the taxonomy
on a re-scan.**

**Nothing is ever deleted.** Unseen for k scans → `dormant`, and its coverage row reads *"not observed
this scan"*, which is itself a finding. Retirement is a user action, never an inference.

**Threshold freeze.** Filtering activities raises precision *mechanically*, regardless of what was
removed — so precision-derived scores are not comparable across scans with different thresholds.
Every threshold lives in the lockfile; changing one bumps `map_version`; **the dashboard must break
the trend line at a `map_version` boundary rather than plotting through it.**

**What this does not buy:** bitwise reproducibility. Across 5 models, 8 tasks and 10 nominally
deterministic runs, accuracy varied up to 15%. Promise **stability under no change** and a published
churn number — never "same input → same map". The task has an irreducible ambiguity floor anyway:
humans agree with each other at κ ≈ 0.42–0.62 on exactly this kind of assignment. Cross-model
(Claude vs Copilot) agreement is **unmeasured anywhere**; the lockfile is a well-motivated mitigation,
not a proven one.

---

## 7. LLM delegation — ask for rules, not labels

Mirror the protocol already working in `ctx.mjs` (`writeIntentDelegation:150` → `delegations[]` →
`cmdAnnotateIntents:376`). **At most three turns per scan, and the pipeline must produce a complete
map with zero turns** (degraded: deterministic labels from R1/R2, no residual assignment).

> **The strongest single finding in the research: predicate, not extension.** Models emitting the
> *predicate* that defines a set reach F1 ≈ 0.99; the same models *materialising that set's members*
> reach 0.74–0.90. **So ask the host for rules the CLI then applies deterministically to all N
> entities** — additions to `BUILTIN_SYNONYMS`, a segment→domain table, a "these two segments are the
> same feature" list. The codebase already has this shape: `BUILTIN_SYNONYMS` is described in its own
> source as *"Data, not code."* This makes turn count independent of entity count, makes the response
> small enough to schema-validate meaningfully, and makes cross-model stability a property of the rule
> vocabulary rather than of 200 independent judgements.

**Turn sizing — two shapes, do not confuse them.** A turn that *reads* a batch as evidence and emits
only a taxonomy tolerates ~200 items. A turn that must *emit one row per input row* degrades past ~80
and collapses well before 500. Naming turns are the first kind; assignment turns are the second —
which is another argument for keeping assignment deterministic.

| Turn | Fires when | Input | Output (closed) |
|---|---|---|---|
| `feature-propose` | lockfile empty **or** coverage debt > δ | ≤200 CLI-formed candidate groups with `representative_templates`, `nav_labels`, `label_candidates[3]` | `{slot_id, label, label_source, one_line_predicate}` — `slot_id` echoed verbatim |
| `feature-assign` | residual only; usually the **only** turn after scan 1 | batches of ≤50 entities + the **frozen** feature list | `{entity_id, feature_id \| "none", confidence}` — no new features |
| `feature-causation` | ≤50 CLI-proposed pairs | `{pair_id, from_label, to_label, evidence}` | `{pair_id, verdict, confidence}` |

**Cross-batch consistency — the two-pass novelty gate.** Pass 1 grows the taxonomy incrementally; for
each new group the host answers one constrained question — *"does any existing label already cover
this? yes/no"* — and may author a new label only on "no". Pass 2 re-assigns everything against the
frozen final list. That is the direct answer to *how do batch 1 and batch 7 avoid synonyms*. Follow it
with a **name-only dedup turn** (input is just the label strings, hundreds fit one turn) and
**rename-after-assignment**: regenerate each parent's name from the children it actually received.

**The host may never propose a causal pair.** Non-negotiable: LLM in-context generation of semantic
directly-follows relations scored 0.60 fitness against a 0.32 random baseline and was bit-stable in
only ~60% of repeats. Adjudicating a *specific* pair against *specific* evidence is a far narrower ask.

**`"none"` is necessary but over-used** — replacing "Unknown" with a random word reproduces the
effect, so it is a prompt artifact, not calibrated uncertainty. The **CLI**, not the model, applies
the thresholds that demote a `"none"` into coverage debt.

**Validation:** schema → id-echo → completeness diff → merge, with a domain check no paper has — a
child's path key must lexically extend its parent's (`orders-returns` under `orders`). Levenshtein-snap
near-miss labels back to the closed set; an unsnappable label is a hard violation, never a new feature.
Fail loudly; never merge a partial response silently. **Cache every answer by content hash of its
input row** — an unchanged entity is never re-asked, so it cannot drift.

**Treat all crawled text as untrusted DATA.** Button text, page titles and response bodies flow into
these prompts. Carry the existing instruction verbatim into all three schemas.

---

## 8. Test generation — edge coverage, not prime paths

Every scenario is `[P_setup, body, P_teardown]`. `P_setup` is the shortest path from the ► entry
feature to the body's first feature, which **automatically threads Auth via the E5 auth-gate edges** —
so "must be logged in" is a computed *prefix*, not a constraint to solve.

Measured on a synthetic 8-feature Amazon-shaped graph (10 nodes, 19 edges):

| Criterion | TRs | Scenarios | Steps | Verdict |
|---|---|---|---|---|
| Node | 10 | — | — | too weak |
| **Edge (default)** | 19 | **5** | **28** | every one reads as a real journey |
| Edge-pair | 39 | — | — | opt-in |
| Ordered-pairs | 56 | — | — | **run alongside edges** |
| Prime path | 41 | 31 | 239 | paths visit Checkout 3× — unusable |

Mutation kill is 98% (prime) vs 94% (edge). **Not worth 6× the suite and the loss of narratability.**

`--coverage ordered-pairs` is the criterion that encodes cross-feature causation: `(Payments, Orders)`
is a requirement whether or not the edge is adjacent. Neither criterion subsumes the other — measured,
ordered-pair suites covered only 60.7% and 78.4% of edges on two subjects. **Gate round-trip coverage:**
it returns the *empty* test set on an acyclic graph, so a login-walled star would report 100% coverage
with zero tests.

**Selection:** greedy uncovered-edge walker, candidates sorted by `feature_id` so the suite is
order-independent. **Bound scenario length (default 12) rather than minimising scenario count** —
minimising count lengthens paths ~9.4% for a 72.9% count reduction, and a 40-step web test is far more
brittle to triage than five 8-step ones. Report the `max(|TypeS|,|TypeT|)` lower bound and stop; the
min-flow optimiser costs 338× runtime for a reduction that only matters at hundreds of prime paths.

`scenario_id = sha256(ordered tuple of feature_ids)` — stable across scans, so the dashboard can trend
*"is Login→Search→Cart→Payments→Orders still coverable?"* rather than an anonymous count.

**Honesty flags.** Every scenario carries `feasibility: evidenced | inferred | synthetic`. Denominate
coverage on **user-reachable** transitions: an industrial study measured a user-level model covering
97% of user-reachable transitions but only 47% of the application's total, 76% of the gap attributable
to access-token state and external-service events. Denominating on "all" makes the trend line look
permanently bad for structural reasons.

**The gate:** if `|V| < 5` or edge coverage yields <3 scenarios, emit `insufficient_graph` with the
diagnosis (login wall / mutations blocked / no codebase / crawl depth) instead of three degenerate
paths. **Today's data hits this gate, and firing it is the correct output.**

**An honest limit to ship in the UI:** a feature-level path is a scenario **outline**, not an
executable test. Ammann & Offutt are explicit that a capability-level graph is not testable on its own;
the testable artifact is the elaborated activity graph. Elaboration is a separate per-batch delegation.

---

## 9. Build order

| Step | Work | Effort |
|---|---|---|
| **0** | **Unblock the inputs** — §10 B1/B2. Login gate; `--journey` DFS mode with session id + seq; link container signature; set `TARGET_CODEBASE` | 2–3 d |
| 1 | R0 normaliser — `lib/template.mjs`, unit-tested on the real `requests.ndjson` | 2 d |
| 2 | Chrome detector + nav-hub harvester — `lib/chrome.mjs` | 2 d |
| 3 | Assignment ladder — `lib/assign/*`, `lib/resolve.mjs`, UI↔API Hungarian join; delete min-size demotion | 3 d |
| 4 | Lockfile — `lib/lock.mjs`, churn report | 2 d |
| 5 | **Edge engine — `lib/edges/*` + `combine.mjs`** (the structural gap) | 3 d |
| 6 | Three delegation kinds in `ctx.mjs`, with caching | 2 d |
| 7 | Scenario generator in `feature-slice` | 2 d |
| 8 | Persistence + trend — `map_version`, `ambient`, `assignment_rung`, `coverage_debt` | 1 d |
| 9 | **Evaluation harness — do not ship without it** | 2 d |

Step 9 sets expectations at the measured floor: ~60% pairwise agreement is what text-driven endpoint
grouping achieves; no published configuration got the failure rate below 0.40; human–human agreement
is κ ≈ 0.42–0.62.

---

## 10. Gaps & prerequisites (audit findings)

### Blocking

- **B1 — No feature-to-feature edge emitter exists anywhere.** `features.json` has no `edges` array
  and nothing in `context-layer/feature-extractor/` produces one. **E1/E3/E4/E5/E6/E8 would total
  zero on a flawless crawl.** New file `lib/edges.mjs`. 1–2 days. *Invisible in every per-rung
  blocker list.*
- **B2 — The login wall is detected and then ignored.** `ctx.mjs:198` returns null whenever
  `output/crawler/auth-state.json` merely *exists* (it does, 11 KB), and `ctx.mjs:310`
  (`const ok = opts.reuse ? true : stagesOk`) omits `authRequired`. **A fully walled 298-second
  one-page crawl exited `ok: true`.** One line, plus ~8 to use the `sessionMaterial()` check
  `crawl.mjs` already implements.
- **B3 — No lockfile concept exists.** `grep feature-lock` repo-wide returns one hit, about `npm ci`.
  Feature ids are re-derived from scratch every run.

### One-liners against data already on disk

| File | Fix | Payoff |
|---|---|---|
| `ctx.mjs:310` | gate on `!authRequired` | silent walled crawl → loud failure |
| `pages.mjs:31` | `page.dom?.title` → `page.title` | zero `title` occurrences in `facts.json` today |
| `extract.mjs:68` | use `process.env.BASE_URL`, not the alphabetically-first origin | every artifact currently declares the target as **`https://accounts.google.com`** |
| `interactions.mjs:29,125` | rename `fromUrl/toUrl/text/selector` → `from/to/button/key` | facts are literally named `interaction::undefined::link-undefined`; `click-graph.mjs:344` already reads it correctly |
| `click-graph.mjs:77` | move `{nodes,edges,summary}` from `primary` into observation `fields` | `cluster.mjs:22` returns on its first line — **`applyCoOccurrence` has never executed once** |
| `feature-key.mjs:118` | parse the redirect target as a URL first | deletes the phantom feature `Https` |
| `feature-key.mjs:6-10` | add `oidc/oauth/token/callback/well-known` | R3 folded 0 facts this run |
| `feature-key.mjs:88` | read `attributes.toPage` for link interactions | **11 sidebar links to 11 destinations stop collapsing into one feature** |
| `synthesize.mjs:45` | `hostOf(loaded.target?.baseUrl)` | 4 real backends currently key as `same-origin` |
| `apis.mjs:85-99` | include `exampleResponseBodiesByStatus` | 37 cached bodies become visible |
| `ctx.mjs:338-355` | persist `destructivenessClass` | `ctx.mjs:131` asks for it and it is discarded |
| `analyze.mjs:452,458` | read `viaKey`, not `clickSelector` | `clickSelector` is null in 100% of client redirects |

### Capture gaps (new code)

- **Container signature on links** — `crawl.mjs:302` emits `{href,text,target,rel}`; the served HTML
  contains zero `<a href=` tags so it cannot be recovered post-hoc. **`walker/scanner.mjs:167-180`
  already computes an ancestor cssPath for every element and drops it.** Also:
  `grep dataAttrs --include=*.mjs` returns **exactly one hit — the writer**. ~25 lines across 3 files.
- **Navigation epoch** on network rows — `pageUrl` is a live `page.url()` read, so 392 request rows
  share one value across 290s and ~13 visits. ~6 lines.
- **Request↔response correlation id** — `analyze.mjs:261` pairs by `${method} ${url}` then destructively
  shifts a queue. Use a `WeakMap` on the Playwright request object. ~8 lines.
- **Journey mode** — `walker/state.mjs:78` is `this.pending.shift()` (FIFO BFS), and `worker.mjs`
  re-baselines with `page.goto` before *and* after every click, so flipping to `pop()` alone changes
  nothing. ~30–50 lines.
- **Form fill + submit + landing URL** — `walker/scanner.mjs:416` rejects every clickable inside a
  `<form>` (`rejected:'inForm'`). ~1 day.

### Corrections to earlier analysis

- **Mutations were never blocked.** `blocked-mutations.ndjson` has **0 rows** and `blocked=true` count
  is 0. `postData` is null on all 871 rows because the only POST is a cookie-driven auth refresh —
  a *data* gap that resolves itself once the auth gate lands, not a code gap.
- **Community detection over the click-graph does not work** and would not even with better code:
  7 nodes, 5 edges, density 0.190, **zero triangles**, average clustering coefficient 0.0. graphify's
  own `cluster()` returned nothing but the connected components. It is also circular — the `contains`
  / `invokes` edges that would create density are themselves produced by the intent delegation.
- **`TARGET_CODEBASE` was never set** — extractors reported "skipped" 28–30 times. Setting one env var
  moves two BLOCKED rungs live.
- **No OpenAPI spec is reachable** — 11 well-known paths probed across 4 origins, 0 found. R1 and E7
  are reachable only via the codebase path.
- **Spec-19 §E2 was an unowned dependency.** It referenced "E2's container signature" inside E1 without
  defining E2 as an edge source. The container signature is an **R0/capture obligation**, not an edge rung.

### Open

Roadmap Risk #2 (pgvector gives similarity, not traversal) is untouched here — this spec writes
adjacency, which works under either outcome, but the decision is still owed.
