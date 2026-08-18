// Push a captured storageState into a LIVE BrowserContext.
//
// Playwright only injects storageState at context CREATION
// (browser.newContext({ storageState })). Mid-crawl session refresh needs the
// opposite: the keeper context just rotated the session, and every live
// worker context must adopt the new cookies + localStorage + IndexedDB
// records WITHOUT being torn down (recreation invalidates the worker's page
// mid-task). Cookies go through the CDP-backed addCookies; storage goes
// through page.evaluate against the worker's current origin.
//
// Best-effort by design: IndexedDB injection writes into EXISTING databases/
// stores (the app created them at bootstrap; we only refresh the records —
// e.g. the Firebase user record in firebaseLocalStorageDb). A db or store
// that doesn't exist yet is skipped, not created: guessing keyPaths/indexes
// wrong would corrupt the app's own schema. If injection can't land, the
// fallback is context recreation (worker 'recreate-context' path).
export async function broadcastSessionToContext(ctx, storageState, { log = () => {} } = {}) {
  if (!storageState) return false;
  let ok = true;
  try { await ctx.addCookies(storageState.cookies || []); }
  catch (e) { log(`cookie broadcast failed: ${e.message}`); ok = false; }

  for (const page of ctx.pages()) {
    try { await injectOriginStorage(page, storageState); }
    catch (e) { log(`storage broadcast failed on ${page.url().slice(0, 80)}: ${e.message}`); ok = false; }
  }
  return ok;
}

export async function injectOriginStorage(page, storageState) {
  let origin;
  try { origin = new URL(page.url()).origin; } catch { return; }
  if (!/^https?:/.test(origin)) return;   // about:blank / chrome-error pages
  const o = (storageState.origins || []).find((x) => x.origin === origin);
  if (!o) return;

  await page.evaluate(async ({ ls, idb }) => {
    for (const { name, value } of (ls || [])) {
      try { window.localStorage.setItem(name, value); } catch {}
    }
    for (const db of (idb || [])) {
      try {
        await new Promise((resolve) => {
          // Open WITHOUT a version: never trigger upgradeneeded — we refresh
          // records in the app's existing schema, we don't define schemas.
          const req = indexedDB.open(db.name);
          const done = (conn) => { try { conn?.close(); } catch {} resolve(); };
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
          req.onsuccess = () => {
            const conn = req.result;
            try {
              const names = (db.stores || [])
                .map((s) => s.name)
                .filter((n) => conn.objectStoreNames.contains(n));
              if (!names.length) return done(conn);
              const tx = conn.transaction(names, 'readwrite');
              for (const store of db.stores || []) {
                if (!conn.objectStoreNames.contains(store.name)) continue;
                const os = tx.objectStore(store.name);
                for (const rec of store.records || []) {
                  try {
                    if (os.keyPath == null && rec.key !== undefined) os.put(rec.value, rec.key);
                    else os.put(rec.value);
                  } catch {}
                }
              }
              tx.oncomplete = () => done(conn);
              tx.onabort = () => done(conn);
              tx.onerror = () => done(conn);
            } catch { done(conn); }
          };
        });
      } catch {}
    }
  }, { ls: o.localStorage || [], idb: o.indexedDB || [] });
}
