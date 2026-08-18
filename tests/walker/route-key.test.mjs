// route-key.test.mjs — canonical route-template identity (whole-app step 1).
//
// Cases come from real scans: the 45 /policies?rule=X variants on
// console-preview, opaque tokens like the GrowthBook SDK key, and the
// hash-routed SPA shape that broke fan-out on HSBC pulseviews.
//
// Run: npm run test:walker (runs alongside crash-recovery)

import assert from 'node:assert/strict';
import { routeKey, templatizePath, templatizeSegment } from '../../testo/src/crawler/lib/route-key.mjs';

const B = 'https://console-preview.superalign.ai';

// ── 1. query-variant collapse: 45 policies URLs → ONE template ──────────────
{
  const rules = ['hooks-disk-wipe', 'ide-perm-allow-critical', 'mcp-auto-approve', 'tasks-reverse-shell'];
  const keys = new Set(rules.map((r) => routeKey(`${B}/policies?rule=${r}`)));
  assert.equal(keys.size, 1, 'all ?rule= variants share one template');
  assert.equal([...keys][0], `${B}/policies?rule=*`);
  assert.notEqual(routeKey(`${B}/policies`), [...keys][0], 'bare /policies is a distinct template (sidebar link never capped away by row links)');
  console.log('PASS  query variants collapse; bare route stays distinct');
}

// ── 2. path-segment IDs: numeric, hex, uuid, opaque token ───────────────────
{
  assert.equal(routeKey(`${B}/inventory/12345`), `${B}/inventory/{id}`);
  assert.equal(routeKey(`${B}/inventory/8f3ab129e4`), `${B}/inventory/{id}`);
  assert.equal(routeKey(`${B}/case/6b2f9e1c-91d4-4a1b-b7f0-aa11bb22cc33`), `${B}/case/{id}`);
  assert.equal(routeKey(`${B}/api/features/sdk-gIwyr3jR5GjHi6HA`), `${B}/api/features/{id}`,
    'mixed alnum token (digit-bearing, ≥8 chars) is an id');
  const many = new Set(Array.from({ length: 20 }, (_, i) => routeKey(`${B}/inventory/asset-${1000 + i}`)));
  assert.equal(many.size, 1, '20 detail URLs = 1 template');
  console.log('PASS  id-like path segments templatized');
}

// ── 3. real words survive ────────────────────────────────────────────────────
{
  for (const p of ['/v2/rules', '/audit-log', '/oauth2/start', '/remediation']) {
    assert.equal(routeKey(`${B}${p}`), `${B}${p}`, `${p} unchanged`);
  }
  assert.equal(routeKey(`${B}/v2/rules/findings-summary`), `${B}/v2/rules/findings-summary`);
  console.log('PASS  version segments and words survive (v2, audit-log, oauth2)');
}

// ── 4. hash-routed SPA: route lives in the fragment ─────────────────────────
{
  const a = routeKey(`${B}/app#/case/123?tab=notes`);
  const b = routeKey(`${B}/app#/case/456?tab=history`);
  const c = routeKey(`${B}/app#/dashboard`);
  assert.equal(a, `${B}/app#/case/{id}?tab=*`);
  assert.equal(a, b, 'two hash-routed case views share a template');
  assert.notEqual(a, c, 'different hash routes are different templates — no pathname collapse');
  console.log('PASS  hash-SPA routes distinguished (pulseviews fan-out shape)');
}

// ── 5. OAuth callback hash stripped; query names sorted; origins distinct ───
{
  assert.equal(
    routeKey(`${B}/insights#state=abc&session_state=def&code=xyz`),
    `${B}/insights`, 'OAuth hash is not identity');
  assert.equal(routeKey(`${B}/x?b=2&a=1`), routeKey(`${B}/x?a=9&b=8`), 'param order/values irrelevant');
  assert.notEqual(routeKey('https://other.app/x'), routeKey(`${B}/x`), 'origin is part of identity');
  assert.equal(routeKey('relative/path', `${B}/root/`), `${B}/root/relative/path`, 'relative hrefs resolve');
  assert.equal(routeKey('not a url ::'), 'not a url ::', 'unparseable falls back to raw');
  console.log('PASS  OAuth-hash strip, param sorting, origin identity, fallbacks');
}

// ── 6. templatizePath still behaves for feature-slice callers ───────────────
{
  assert.equal(templatizePath('/users/123/roles'), '/users/{id}/roles');
  assert.equal(templatizePath('/users/'), '/users');
  assert.equal(templatizeSegment('v2'), 'v2');
  console.log('PASS  templatizePath/segment exports for feature-slice');
}

console.log('\nAll route-key cases passed.');
