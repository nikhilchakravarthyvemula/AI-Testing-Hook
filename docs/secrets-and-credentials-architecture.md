# Secrets & credentials architecture — pilot state and target state

Status: **agreed direction** (2026-08-19) — pilot half is built (spec-17 §3, Batches 1–2);
target half lands with the hosted service (spec-16 web-app)
Related: spec-17 (knowledge sources), spec-16 (three-service rollout), SDD §2.4/§2.5/TRM-SEC-VLT

> **TL;DR** — Two credential models, chosen by *where the fetch runs*, not by preference.
> **Pilot (now):** fetch runs on the tester's device with the tester's own PAT, stored in the
> OS keystore — the `gh`/`git`/`aws` CLI pattern, already implemented and tested.
> **Target (dashboard era):** configuration and *secret references* live in the dashboard's
> backend; secret *values* live in **Google Secret Manager** (the org's approved secrets store in the GCP landing zone — never our own DB);
> Jira/Confluence sync becomes a **server-side job** under a service account; the scanner pulls
> **data through the authenticated API and never sees a credential**. The two models coexist —
> the SecretStore provider chain makes the migration a config change, not a rewrite.

## 1. The rule that decides everything

**A credential lives with the identity it represents, and custody belongs to a purpose-built
store.**

- The fetch runs *on the user's device, on the user's behalf* → the **user's own PAT**, in the
  **device keystore**. Visibility, attribution and revocation are all user-scoped, which is
  exactly what a per-user fetch needs.
- The fetch runs *server-side, on the system's behalf* (scheduled sync) → a **service-account
  credential**, in **Google Secret Manager** (GSM). Access control shifts to our backend, so the
  identity shifts with it. (If org policy mandates CyberArk for this credential class instead,
  the principle and the integration shape are identical — confirm which store the landing zone
  approves before building.)
- **Nowhere, ever:** secret values in our own application database, in code, in an npm package,
  or in a config file. The backend stores *references* (`gsm://projects/<proj>/secrets/jira-svc-pat`);
  resolution happens at runtime, in memory, audited.

## 2. Pilot state (built, spec-17 §3 / Batches 1–2)

```
Tester ── ctx auth jira ──▶ hidden prompt → validate (/myself) → OS keystore
                              (Keychain · DPAPI · libsecret · JIRA_PAT env override)
Tester/Copilot ── ctx sync jira ──▶ PAT from keystore, in-memory → Jira DC → bundle + corpus
```

- Individual PAT, individually stored, individually revocable. No infra dependency, no
  provisioning lead time — each tester self-onboards through the chat-guided `auth`/`setup` flow.
- This is the industry-standard pattern for developer-device CLIs (`gh auth login`, git
  credential helpers, `aws sso`, docker credsStore all do exactly this). It is also the only
  model the SDD currently permits: *"credentials never leave the device"*.

### Why individual identity here (not a shared/service PAT)

1. **Visibility = authorization.** Jira project visibility is per-user. A service account with
   broader access than the tester would fetch data the tester is not entitled to see — the
   harness would silently bypass Jira's permission model. With the user's own PAT, least
   privilege is automatic.
2. **Attribution.** Jira's own access logs answer "who read what" with zero extra machinery.
   A shared credential forces us to rebuild attribution in our own system and defend it to
   Risk & Audit.
3. **Blast radius.** One leaked individual PAT = one user's read access, one revocation. One
   leaked shared PAT = everything, plus redistribution to every machine.
4. **Consistency.** The harness already requires the developer's own SSO session for crawl and
   execute (SDD §1.1). User identity is not a new requirement Jira adds — it is the model the
   system is built on.

## 3. Target state (dashboard + hosted service era)

```
Dashboard ──▶ backend DB: configuration + secret REFERENCES (never values)
GSM       ──▶ custody of the service-account PAT (KMS at rest, versioned, rotation schedules)
Backend sync job (scheduled / on-demand):
    resolve reference via GSM (workload identity, no key files) → in-memory PAT
    → Jira/Confluence → bundles + corpus
    stored server-side, access-controlled per user/project
Scanner (device) ──▶ authenticated API → pulls DATA (bundles), never credentials
```

Key properties:

- **The credential-distribution problem is eliminated, not solved** — the PAT never travels to
  any device, so there is nothing to serve securely.
- **Server-side sync unlocks scheduling** — the pilot's chat-gated fetch becomes a nightly job.
- **Rotation/revocation is one place** (GSM secret versions), and a revoked credential surfaces to devices
  as the existing `authRequired` envelope on their next pull.
- **Service account is legitimate here** because all four conditions hold: fetch is server-side;
  scope is pinned to configured projects/spaces; the account is read-only browse; and *our*
  backend enforces per-user visibility of the synced data. If any of those conditions breaks,
  fall back to user identity.

### Non-negotiable backend requirements (security review will ask exactly these)

- Secret values only in GSM; DB rows carry references. No exceptions for "temporary" cases.
- Backend→GSM access via **workload identity** (the runtime's attached service account with
  `roles/secretmanager.secretAccessor` bound **per secret**, not project-wide). **Never an
  exported SA key file** — that would just mint a new static secret.
- **Enable Secret Manager Data Access audit logs** — admin-activity logging alone does not
  record `accessSecretVersion` reads. This is the per-read audit trail, with anomaly alerting
  on top.
- Synced Jira/Confluence content is access-controlled per user/project in the API — the backend
  must not become the permission-bypass described in §2.
- Corpus content (ticket text = potential PII) needs the DLP review before it is stored hosted-
  side (spec-17 §13.5 currently keeps it device-local for this reason).
- TLS with corporate trust everywhere (SDD §2.5).

### SDD implications — flag before building

The SDD currently states *"credentials never leave the device"* (§2.4, TRM-SEC-VLT) and scopes
the service account to *publishing runs only* (§2.1). The target state needs both amended:
device-credential language scoped to *user* credentials, and the service account's scope
extended to source ingestion. Raise at the next SDD review alongside the §8.1 "Distribution"
row — do not build the backend half against an unamended SDD.

## 4. Migration path — why this is cheap

The SecretStore is a provider chain (`env → keychain → dpapi → libsecret`), and extractors ask
one interface (`getSecret`) with no knowledge of what sits behind it. Each future step is **one
new provider object, zero caller changes**:

| Step | Change | Callers touched |
|---|---|---|
| Pilot (now) | — (built) | — |
| Hosted service lands | Jira/Confluence extractors also run server-side; device scanner gains a "pull bundle from API" mode | bundle format unchanged → cross-linker/synthesizer untouched |
| GSM integration (server-side) | `gsmProvider` in the chain, resolving `gsm://` references via ADC | none |
| Optional: runtime delivery to devices | `backendProvider` (memory-only fetch over the authenticated API) | none |

The pilot keystore code stays permanently as the fallback for setups without a hosted service —
it is already written and costs nothing to keep.

## 5. What was explicitly rejected

| Option | Why rejected |
|---|---|
| PAT embedded in the npm package | SDD §2.5 "no committed secrets"; package = published secret; secret scanners will flag it; rotation = re-release |
| Secret **values** in our backend DB | Building a homegrown vault next to an org that runs Google Secret Manager — fails security review by default; custody belongs to the purpose-built store |
| Shared PAT distributed to laptops | Distribution surface + broken attribution + full blast radius; keystore then protects a secret that is no longer secret |
| Central config-push of plaintext creds (SCCM/env) | Workable but weaker at rest; SDD-silent scope; acceptable only as a documented fallback, never the design |
| Testers' individual PATs in GSM | A laptop needs a GCP identity just to fetch a personal secret — a second identity layer for no gain; personal creds in a central store also reopen the attribution questions §2 solves. GSM is for machine identities; devices keep the OS keystore |
