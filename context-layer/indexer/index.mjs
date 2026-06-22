#!/usr/bin/env node
// Indexer — third stage of the context layer.
//
// Reads from the three source folders the content-extractor populates:
//   output/crawler/         — live discovery
//   output/graphify/        — semantic code graph
//   output/code-extractors/ — per-framework deterministic facts
//
// Synthesises per-topic indices into:
//   output/indexed_output/<topic>.json
//   output/indexed_output/index.json     ← top-level summary
//
// Each index file is a flat list of items, every item carrying which
// source(s) saw it. Consumers don't need to know which source produced
// what — they read by topic.
//
// Adding a topic = drop a file in topics/ that exports `build(sources)`
// returning IndexedItem[]. Register it in TOPIC_REGISTRY below.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAllSources } from './lib/sources.mjs';

import { build as buildApis }         from './topics/apis.mjs';
import { build as buildRoutes }       from './topics/routes.mjs';
import { build as buildPages }        from './topics/pages.mjs';
import { build as buildModels }       from './topics/models.mjs';
import { build as buildRedirects }    from './topics/redirects.mjs';
import { build as buildTestData }     from './topics/test-data.mjs';
import { build as buildDependencies } from './topics/dependencies.mjs';
import { build as buildInteractions } from './topics/interactions.mjs';
import { build as buildClickGraph }   from './topics/click-graph.mjs';
import { build as buildDbSchema }     from './topics/db-schema.mjs';
import { build as buildMockData }     from './topics/mock-data.mjs';
import { build as buildOpenApi }      from './topics/openapi.mjs';
import { build as buildApiSpec }      from './topics/api-spec.mjs';
import { verifyApiSpec }              from './verify/api-spec-verify.mjs';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'output', 'indexed_output');


// ── topic registry ────────────────────────────────────────────────────────

const TOPIC_REGISTRY = [
  { name: 'apis',         build: buildApis,         description: 'HTTP endpoints (code + live + spec)' },
  { name: 'routes',       build: buildRoutes,       description: 'UI routes declared in frontend frameworks' },
  { name: 'pages',        build: buildPages,        description: 'Live pages crawled (clickables, forms, headings)' },
  { name: 'models',       build: buildModels,       description: 'Data models / classes / DTOs' },
  { name: 'redirects',    build: buildRedirects,    description: 'Server + client navigation redirects' },
  { name: 'test-data',    build: buildTestData,     description: 'Form fields ready for test-data synthesis' },
  { name: 'dependencies', build: buildDependencies, description: 'Manifest deps per ecosystem' },
  { name: 'interactions', build: buildInteractions, description: 'UI actions and their targets' },
  { name: 'click-graph',  build: buildClickGraph,   description: 'Intent-driven graph: pages → intents → APIs (LLM-annotated)' },
  { name: 'db-schema',    build: buildDbSchema,     description: 'SQLAlchemy tables: columns, constraints, foreign keys, relationships' },
  { name: 'mock-data',    build: buildMockData,     description: 'Real request + response samples per endpoint, observed by the crawler' },
  { name: 'openapi',      build: buildOpenApi,      description: 'Live-served OpenAPI/Swagger spec per endpoint (resolved schemas)' },
  { name: 'api-spec',     build: buildApiSpec,      description: 'Per-endpoint test contract: headers + request body + expected responses (crawler-OpenAPI ∪ mock-data ∪ crawler)' },
];


// ── runner ────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('[indexer] loading source bundles from output/…');
  const sources = loadAllSources(REPO_ROOT);

  const sourcesSeen = _summariseSourcesSeen(sources);
  console.log(`[indexer] sources available: ${sourcesSeen.join(', ') || '(none)'}`);

  /** @type {import('./lib/models.mjs').IndexSummary} */
  const summary = {
    generatedAt: new Date().toISOString(),
    target: sources.target,
    topics: {},
  };

  for (const topic of TOPIC_REGISTRY) {
    const startedAt = Date.now();
    let items;
    try {
      items = topic.build(sources);
    } catch (e) {
      console.error(`[indexer] topic '${topic.name}' FAILED: ${e.message}`);
      summary.topics[topic.name] = { file: null, count: 0, sources: [], error: e.message };
      continue;
    }
    const sourcesContributing = _sourcesContributing(items);
    const file = `${topic.name}.json`;
    const outPath = path.join(OUT_DIR, file);
    fs.writeFileSync(outPath, JSON.stringify({
      topic: topic.name,
      description: topic.description,
      generatedAt: summary.generatedAt,
      target: sources.target,
      itemCount: items.length,
      sourcesContributing,
      items,
    }, null, 2));
    summary.topics[topic.name] = {
      file, count: items.length,
      sources: sourcesContributing,
      durationMs: Date.now() - startedAt,
    };
    console.log(
      `[indexer] ${topic.name.padEnd(13)} ${String(items.length).padStart(4)} item(s) ` +
      `← ${sourcesContributing.join(', ') || '(none)'}  (${Date.now() - startedAt}ms)`
    );
  }

  const indexPath = path.join(OUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(summary, null, 2));

  console.log(`\n[indexer] wrote ${path.relative(REPO_ROOT, indexPath)}`);
  console.log(`[indexer] total topics: ${Object.keys(summary.topics).length}`);
  console.log(
    `[indexer] total items: ${Object.values(summary.topics)
      .reduce((acc, t) => acc + (t.count || 0), 0)}`,
  );

  // Post-pass: LLM-assisted authenticity check + body repair on the api-spec
  // contract (removes phantom duplicates, fills request-body gaps). Rewrites
  // api-spec.json in place. Non-fatal — a failure leaves the raw topic intact.
  try {
    console.log('\n[indexer] verifying api-spec (authenticity + bodies)…');
    await verifyApiSpec();
  } catch (e) {
    console.warn(`[indexer] api-spec verification skipped: ${e.message}`);
  }
}


// ── helpers ────────────────────────────────────────────────────────────────

/** Which top-level sources had ANY data? */
function _summariseSourcesSeen(sources) {
  const seen = [];
  if (sources.crawler)            seen.push('crawler');
  if (sources.mockData)           seen.push('mock-data');
  if (sources.openapiSpec)        seen.push('openapi-spec');
  if (sources.graphify)           seen.push('graphify');
  if (sources.graphifyGraph)      seen.push('graphify-graph');
  if (sources.dbSchema)           seen.push('db-schema');
  if (sources.frameworkDetection) seen.push('framework-detection');
  for (const id of Object.keys(sources.codeExtractors)) {
    seen.push(`code-extractors/${id}`);
  }
  return seen;
}

/** Distinct sourceIds that appear across an item list's observations. */
function _sourcesContributing(items) {
  const set = new Set();
  for (const item of items) {
    for (const obs of item.observations ?? []) set.add(obs.sourceId);
  }
  return [...set].sort();
}


main().catch(e => { console.error(`[indexer] failed: ${e.message}`); process.exit(1); });
