# Spec 06 — GitHub Device-Flow Login → Copilot-Backed LLM Calls

**Status:** Draft for review
**Owner:** Platform / Infrastructure
**Related:** `testo/model-api-connector/`, `interfaces/web/` (mockups removed from the tree; recoverable from the Stitch project)
**Date:** 2026-07-02

---

## 1. Goal

Let a user log in to the Testing Harness web app, authenticate their GitHub
account via the **OAuth 2.0 Device Authorization Grant** ("device flow"), and
have the harness use the resulting GitHub token to make LLM calls on that
user's behalf — deployed on a GCP VM.

This slots into the existing `model-api-connector` as a new provider
(`github-copilot`) alongside `minimax`, so callers keep using
`getClient(provider).chat({...})` unchanged.

---

## 2. Read this first — Terms-of-Service caveat

The device flow itself is a fully supported, standard GitHub feature. The
sensitive part is **what the token is used for**.

A GitHub OAuth/Copilot token issued to a user is intended for use by the
approved client (VS Code, the `gh` CLI, JetBrains, etc.). Using that token to
drive **arbitrary LLM completions from your own harness** against Copilot's
internal completion endpoints is **outside GitHub's published API surface and
very likely violates the GitHub Copilot / Additional Product Terms.** GitHub
can and does rotate these internal endpoints and can suspend accounts for
programmatic abuse.

Two clean, supported alternatives exist and should be weighed before building
this:

1. **GitHub Models API** — GitHub's *officially supported* inference API
   (`https://models.github.ai/...`), authenticated with a GitHub token /
   fine-grained PAT with the `models` permission. This is the sanctioned way
   to "make LLM calls with a GitHub identity." If the intent is "authenticate
   with GitHub, then call an LLM," this is almost certainly what you want.
2. **Bring-your-own-key providers** — the harness already supports MiniMax and
   has env slots for OpenAI/Anthropic. A user could paste their own key
   instead of doing a Copilot handshake.

The rest of this doc describes the device-flow mechanics generically (they are
identical whether the token then targets GitHub Models, the REST API, or
Copilot). Section 9 calls out exactly where the ToS risk lives so the decision
is explicit.

> Recommendation: implement the device flow as designed below, but point the
> LLM calls at the **GitHub Models API**, not Copilot's private endpoints.

---

## 3. High-level flow

```
Browser (user)        Harness backend (GCP VM)            GitHub
     │                        │                              │
     │  1. click "Connect     │                              │
     │     GitHub"            │                              │
     │───────────────────────▶│                              │
     │                        │  2. POST /login/device/code  │
     │                        │     (client_id, scope)       │
     │                        │─────────────────────────────▶│
     │                        │  user_code, device_code,     │
     │                        │  verification_uri, interval  │
     │                        │◀─────────────────────────────│
     │  3. show user_code +   │                              │
     │     "go to             │                              │
     │     github.com/login/  │                              │
     │     device"            │                              │
     │◀───────────────────────│                              │
     │                        │  4. poll POST /login/oauth/  │
     │                        │     access_token every       │
     │                        │     `interval`s              │
     │                        │─────────────────────────────▶│
     │  5. user opens browser,│     (authorization_pending…) │
     │     enters user_code,  │                              │
     │     approves + SSO     │                              │
     │═══════════════════════════════════════════════════════▶ (github.com)
     │                        │  6. access_token returned    │
     │                        │◀─────────────────────────────│
     │                        │  7. store token (encrypted), │
     │                        │     bound to harness session │
     │  8. "GitHub connected" │                              │
     │◀───────────────────────│                              │
     │                        │                              │
     │  9. user runs a test → harness calls LLM with token   │
     │                        │─────────────────────────────▶│ (Models API)
```

Key point: **the harness backend is the OAuth client, not the browser.** The
browser only ever shows the `user_code` and a link. The token never touches
front-end JavaScript.

---

## 4. Step-by-step (endpoints & payloads)

Verified against GitHub's current OAuth device-flow documentation
(docs.github.com, retrieved 2026-07-02).

### Step 1 — Request device & user codes

```
POST https://github.com/login/device/code
Accept: application/json
Content-Type: application/x-www-form-urlencoded

client_id=<APP_CLIENT_ID>&scope=<space-delimited-scopes>
```

Response:

```json
{
  "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

- `user_code` (8 chars, hyphenated) → show to the user.
- `verification_uri` → the URL to send them to.
- `device_code` (40 chars) → **secret**, kept server-side for polling.
- `expires_in` → 900s (15 min) window.
- `interval` → minimum seconds between polls (respect it or get `slow_down`).

### Step 2 — Prompt the user

Display in the web UI: the `user_code` and a button/link to
`https://github.com/login/device`. The user opens it, pastes the code, signs in
(here HSBC's **SAML SSO / Entra ID** redirect + MFA + conditional access
happens), and clicks **Authorize** for each org they want to grant.

### Step 3 — Poll for the token

```
POST https://github.com/login/oauth/access_token
Accept: application/json
Content-Type: application/x-www-form-urlencoded

client_id=<APP_CLIENT_ID>
&device_code=<device_code from step 1>
&grant_type=urn:ietf:params:oauth:grant-type:device_code
```

Poll every `interval` seconds. Handle these responses:

| Response | Meaning | Action |
|---|---|---|
| `authorization_pending` | user hasn't finished yet | keep polling at `interval` |
| `slow_down` | polling too fast | add 5s to interval, continue |
| `expired_token` | 15-min window elapsed | restart at Step 1 |
| `access_denied` | user clicked Cancel | abort, surface error |
| `access_token=...` | success | store token, stop polling |

Success payload:

```json
{
  "access_token": "gho_16C7e42F...",
  "token_type": "bearer",
  "scope": "..."
}
```

Note: `client_secret` is **not** used in the device flow. Device flow must be
explicitly enabled in the app's settings (`device_flow_disabled` error
otherwise).

### Step 4 — Use the token

Every request re-validates identity via `GET https://api.github.com/user`
before trusting the session. Then, for LLM calls, the token is used as
`Authorization: Bearer <token>` against the **GitHub Models API** (recommended)
or whichever inference endpoint the org has sanctioned.

---

## 5. Enterprise SSO reality (the "HSBC" case)

If the target org enforces SAML SSO or uses Enterprise Managed Users (EMU),
nothing changes in *your* code — the SSO dance happens entirely inside GitHub
during Step 2. But three operational facts matter:

- **Token must be SSO-authorized.** With classic SAML orgs, a token isn't
  usable against org resources until the user authorizes it for that org.
  Device flow usually handles this during approval, but a token that predates
  SSO enrollment can silently 403. Surface a clear "authorize this token for
  <org>" message on 403.
- **EMU** accounts are provisioned/deprovisioned by the IdP, so harness access
  should follow the user's lifecycle automatically — good for offboarding.
- **Corporate proxy / TLS inspection.** A bank's egress typically forces
  traffic through a proxy with a private CA. The GCP VM must trust that CA and
  route `github.com` / `api.github.com` (and the Models host) through the
  proxy, or the handshake and polling calls will fail with TLS errors.

You need a **registered GitHub App or OAuth App** (org-approved) with device
flow enabled to get a `client_id`. In an enterprise, that app registration
itself typically needs org-owner approval.

---

## 6. Proposed integration into the harness

### 6.1 New backend module

```
testo/model-api-connector/
├── providers/
│   ├── minimax.mjs
│   └── github-copilot.mjs      ← new: chat() over the GitHub-auth'd endpoint
└── auth/
    └── github-device.mjs       ← new: device-flow state machine
```

`github-device.mjs` exposes:

- `startDeviceLogin({ scope })` → `{ userCode, verificationUri, deviceCode, interval, expiresIn }`
- `pollForToken({ deviceCode, interval })` → resolves with token or rejects with a typed error
- internal: respects `interval`, handles `slow_down` / `expired_token` / `access_denied`

`github-copilot.mjs` implements the same `ModelClient` interface as
`minimax.mjs` (`chat({ messages })` → `{ content, usage }`), reading its bearer
token from the session token store rather than a static env var.

### 6.2 Web endpoints (former `interfaces/web` — mockups removed)

```
POST /api/auth/github/start   → { userCode, verificationUri, expiresIn }
                                 (backend also begins polling, keyed by session)
GET  /api/auth/github/status  → { state: pending|authorized|error }
POST /api/llm/chat            → uses the session's GitHub token
```

The front end shows the code, opens `verification_uri` in a new tab, then
polls `/status` until `authorized`.

### 6.3 Token storage

- One token **per harness user session**, never global.
- Encrypt at rest (see §7). Never log it, never send it to the browser.
- Store: `{ userSessionId, encToken, githubLogin, scopes, obtainedAt, expiresAt }`.
- Refresh: GitHub App user tokens can be short-lived with refresh tokens
  (if enabled); OAuth App tokens historically don't expire. Design the store to
  hold an optional `refreshToken` + expiry so either works.

---

## 7. GCP VM deployment

### 7.1 Shape

- Single **Compute Engine VM** (e2-small/medium to start), Node app behind
  **nginx** (TLS termination) or a **GCP HTTPS Load Balancer** + managed cert.
- App runs as a **systemd** service (or a container, once a container-deploy
  component is built — currently unbuilt). No secrets baked into the image.
- Outbound egress must reach `github.com`, `api.github.com`, and the inference
  host. Behind an enterprise proxy, set `HTTPS_PROXY` and the custom CA bundle
  (`NODE_EXTRA_CA_CERTS`).

### 7.2 Secrets

- The **app `client_id`** (and `client_secret` if you register an OAuth App for
  other flows — not needed for device flow) live in **GCP Secret Manager**, not
  `.env`, not the image.
- The **per-user GitHub tokens** are encrypted with a KMS key
  (**Cloud KMS**) — envelope encryption: KMS-wrapped data key, ciphertext in
  the DB. The VM's **service account** gets `roles/cloudkms.cryptoKeyEncrypterDecrypter`
  and `roles/secretmanager.secretAccessor` — nothing broader.
- No user token is ever written to disk in plaintext or to logs.

### 7.3 Hardening checklist

- Firewall: ingress only 443 (and 22 restricted to IAP / bastion).
- Use **IAP** or an LB, don't expose the Node port directly.
- Enable OS Login + shielded VM.
- Structured logs to Cloud Logging with a redaction filter for `gho_`/`ghu_`
  token prefixes.
- Rate-limit `/api/auth/github/start` to avoid device-code abuse.

### 7.4 Sketch

```
Internet ──443──▶ HTTPS LB (managed cert)
                     │
                     ▼
             Compute Engine VM
             ├─ nginx / systemd
             ├─ Node harness backend
             │    ├─ auth/github-device.mjs  ──▶ github.com  (device flow)
             │    └─ providers/github-copilot ──▶ inference host
             ├─ Secret Manager  (client_id)
             ├─ Cloud KMS       (token encryption key)
             └─ Cloud SQL / Firestore (encrypted token store)
```

---

## 8. Failure modes to handle

- `device_flow_disabled` — app config wrong; device flow not enabled.
- `expired_token` — user too slow; auto-restart and show a fresh code.
- `access_denied` — user cancelled; clean error, offer retry.
- `slow_down` — back off polling by +5s.
- 403 on API/LLM call — token not SSO-authorized for the org; prompt user to
  authorize it.
- Proxy/TLS errors on the VM — CA bundle / `HTTPS_PROXY` misconfigured.
- Token revoked mid-session (user or admin revokes) — detect 401, force
  re-login.

---

## 9. Where the ToS risk actually lives (decision point)

| Design choice | Supported? | Notes |
|---|---|---|
| Device flow to obtain a GitHub token | ✅ Yes | Standard OAuth 2.0 device grant. |
| Call `api.github.com` (repos, user) with it | ✅ Yes | Normal REST usage per granted scopes. |
| Call **GitHub Models API** for inference | ✅ Yes | Officially supported; needs `models` permission. |
| Call **Copilot's private completion endpoints** | ⚠️ / ❌ | Undocumented, reserved for approved clients; likely violates Copilot Additional Terms; endpoints/rotation break without notice; account-suspension risk. |

If the business requirement is literally "reuse the user's Copilot seat for our
own harness completions," that should get a **written sign-off / clarification
from GitHub (or your GitHub enterprise account team)** before build. Otherwise,
target GitHub Models and get the same "log in with GitHub, then infer" UX on
fully supported ground.

---

## 10. Open questions

1. Register a **GitHub App** (preferred: fine-grained perms, short-lived tokens,
   refresh) or an **OAuth App** (simpler, long-lived tokens)?
2. Which inference target — GitHub Models (recommended) vs Copilot vs
   bring-your-own-key?
3. Token store backend on GCP — Cloud SQL vs Firestore?
4. Is per-user token isolation enough, or do we also need per-org policy
   enforcement (model allow-list) inside the harness?
5. Does the target enterprise allow the app registration + device flow at all?

---

*Endpoints in §4 verified against docs.github.com "Authorizing OAuth apps →
Device flow" on 2026-07-02.*
