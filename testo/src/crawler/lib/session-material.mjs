// Session-material accounting for Playwright storageState captures.
//
// One definition, three call sites (crawl.mjs persistSession/onAuthWarmed,
// harvest-token.mjs save guard, ensure-fresh.mjs) — previously each carried
// its own inline copy with subtly different counting rules, which is how the
// harvest guard ended up URL-only and persistSession ignored IndexedDB.
//
// Two measures, because they answer different questions:
//   sessionMaterial(st)  — STORAGE-side records only (localStorage +
//                          IndexedDB records). "Does this capture carry an
//                          actual session?" A hollow capture (login shell,
//                          IdP iframe cookies) scores 0 here even when it
//                          has cookies.
//   totalMaterial(st)    — cookies + storage. "Is this capture empty?"
//                          Cookie-session apps legitimately score 0 on
//                          sessionMaterial, so emptiness checks must include
//                          the cookie jar.
export function sessionMaterial(st) {
  return (st?.origins || []).reduce((n, o) =>
    n + (o.localStorage?.length || 0) +
    (o.indexedDB || []).reduce((m, db) =>
      m + (db.stores || []).reduce((k, s) => k + (s.records?.length || 0), 0), 0), 0);
}

export function totalMaterial(st) {
  return (st?.cookies?.length || 0) + sessionMaterial(st);
}

// The standard save guard: overwrite `prior` with `fresh` only when doing so
// can't replace a real session with a hollow one. Returns { ok, reason }.
export function shouldPersist(fresh, prior) {
  if (totalMaterial(fresh) === 0) {
    return { ok: false, reason: 'capture is empty (no cookies, no storage records)' };
  }
  if (sessionMaterial(fresh) === 0 && sessionMaterial(prior) > 0) {
    return { ok: false, reason: 'capture carries no storage-side session material but the saved state does' };
  }
  return { ok: true, reason: null };
}
