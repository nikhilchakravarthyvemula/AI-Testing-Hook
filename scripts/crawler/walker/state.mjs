// walker/state.mjs
//
// Single in-process shared state for the parallel DFS walker.
//
// All mutations are synchronous JavaScript on a single thread (Node JS
// is cooperatively scheduled between awaits). The walker design ensures
// every shared-state read AND its dependent write happen in the SAME
// synchronous block — no await between `set.has(t)` and `set.add(t)` —
// so the `tryClaim` semantics are race-safe without locks.
//
// Two budget gates:
//   - wall-clock: `budgetMs` from construction
//   - page count: `maxPages` distinct URLs visited
// `isBudgetExhausted()` lets workers exit gracefully when either fires.

export class SharedState {
  constructor({ seeds = [], budgetMs = 600_000, maxPages = 200, maxDepth = 5 } = {}) {
    this.startedAt        = Date.now();
    this.budgetMs         = budgetMs;
    this.maxPages         = maxPages;
    this.maxDepth         = maxDepth;

    this.pending          = seeds.slice();  // [{ url, depth, phase?, parentUrl? }]
    this.interactedUrls   = new Set();
    this.navigatedPaths   = new Set();      // `${url}::${stableKey}`
    this.stateNodes       = new Set();      // `${url}#${stableKey}`
    this.discoveredViaClick = new Set();
    this.clickGraph       = [];
    this.interactablesByUrl = {};           // { url: [items] }
    this.issues           = [];             // [{ts, type, workerId?, url?, message}]

    this.activeWorkers    = 0;
  }

  // Push a structured issue (click failed, nav failed, re-auth needed, …)
  // so the pool can summarize them at the end and the saved click-graph.json
  // surfaces what went wrong without us needing to grep logs.
  recordIssue({ type, workerId = null, url = null, message = '' }) {
    if (!type) return;
    this.issues.push({
      ts: Date.now() - this.startedAt,
      type, workerId, url,
      message: String(message).split('\n')[0].slice(0, 200),
    });
  }

  // ── budget ────────────────────────────────────────────────────────────
  isBudgetExhausted() {
    if (Date.now() - this.startedAt > this.budgetMs) return 'time';
    if (this.interactedUrls.size >= this.maxPages)   return 'pages';
    return null;
  }

  // ── queue ─────────────────────────────────────────────────────────────
  enqueue(task) {
    // Skip if already known. The atomic check + push happens here so
    // multiple workers enqueueing the same discovered URL never produce
    // duplicates.
    if (!task || !task.url) return false;
    if (this.interactedUrls.has(task.url)) return false;
    if (this.pending.some(t => t.url === task.url)) return false;
    this.pending.push(task);
    return true;
  }

  tryDequeue() {
    // BFS = shift (FIFO). Workers grab the OLDEST task so all sibling
    // discoveries at depth N are covered before any drill into depth N+1.
    // This matters when budget < time-to-exhaust: with DFS the walker
    // dove into one subtree (e.g. /downloads) and missed siblings
    // (/sessions, /endpoints, /insights) entirely. With BFS the entire
    // sidebar is covered first; details drilled second.
    //
    // Per-page click order is still depth-first (a worker fully drains
    // a page's click list before grabbing the next task), so state-edge
    // capture per page is unaffected.
    while (this.pending.length) {
      const task = this.pending.shift();
      if (this.interactedUrls.has(task.url)) continue;       // already done
      if (task.depth > this.maxDepth) continue;              // depth-cap
      // Reserve atomically — no other worker can also dequeue this URL.
      this.interactedUrls.add(task.url);
      return task;
    }
    return null;
  }

  get queueLength()  { return this.pending.length; }
  get pagesVisited() { return this.interactedUrls.size; }

  // ── per-click transition dedup ────────────────────────────────────────
  // Atomic: no await between has + add, so two workers can't both win.
  tryClaim(transition) {
    if (this.navigatedPaths.has(transition)) return false;
    this.navigatedPaths.add(transition);
    return true;
  }

  // ── recording ─────────────────────────────────────────────────────────
  addEdge(edge)            { this.clickGraph.push(edge); }
  addStateNode(node)       { this.stateNodes.add(node); }
  markDiscovered(url)      { this.discoveredViaClick.add(url); }
  setInteractables(url, items) {
    if (items && items.length) this.interactablesByUrl[url] = items;
  }

  // ── worker accounting ─────────────────────────────────────────────────
  beginWork() { this.activeWorkers += 1; }
  endWork()   { this.activeWorkers -= 1; }

  // True when there's nothing pending AND no worker is mid-task.
  // The grace period in the worker loop guards against premature exit.
  isQuiescent() { return this.pending.length === 0 && this.activeWorkers === 0; }

  // ── serialization (matches existing click-graph.json shape) ───────────
  serialize({ workers = 1, traversal = 'parallel-bfs', complete = true } = {}) {
    const navEdges   = this.clickGraph.filter(e => e.kind === 'nav').length;
    const stateEdges = this.clickGraph.filter(e => e.kind === 'state').length;
    const issueCounts = {};
    for (const i of this.issues) issueCounts[i.type] = (issueCounts[i.type] || 0) + 1;
    return {
      generatedAt: new Date().toISOString(),
      traversal,
      dedup: 'transition',
      workers,
      complete,                            // false for mid-run checkpoints
      wallClockMs: Date.now() - this.startedAt,
      pageCount: this.interactedUrls.size,
      pendingCount: this.pending.length,
      edgeCounts: { total: this.clickGraph.length, nav: navEdges, state: stateEdges },
      issueCounts,
      nodes: [...this.interactedUrls],
      stateNodes: [...this.stateNodes],
      discoveredViaClick: [...this.discoveredViaClick],
      navigatedPaths: [...this.navigatedPaths],
      edges: this.clickGraph,
      interactables: this.interactablesByUrl,
      issues: this.issues,
    };
  }
}
