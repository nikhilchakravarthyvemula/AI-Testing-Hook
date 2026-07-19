// Load the understand-stage artifacts a run produced.
//
// C3 reads ONLY from the run's own context snapshot (<workspace>/context/),
// which the spine copied out of output/ after the understand stage — never from
// the live output/ dir, and never from a previous run. That's what makes the
// store a faithful record of THIS run (the blank-slate rule).
//
// The three inputs and where the pipeline writes them inside context/:
//   synthesized/facts.json     → CanonicalFact[]  (knowledge-synthesizer)
//   gaps/gaps.json             → Gap[]            (gap-analyzer)
//   features/features.json     → Feature[]        (feature-extractor)

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} contextDir  usually <workspace>/context
 * @returns {{ facts, gaps, features, target, sourceTopics }}
 */
export function loadContext(contextDir) {
  const facts = readEnvelope(path.join(contextDir, 'synthesized', 'facts.json'), 'facts');
  const gaps = readEnvelope(path.join(contextDir, 'gaps', 'gaps.json'), 'gaps');
  const features = readEnvelope(path.join(contextDir, 'features', 'features.json'), 'features');

  return {
    facts: facts.items,
    gaps: gaps.items,
    features: features.items,
    target: facts.envelope.target ?? gaps.envelope.target ?? features.envelope.target ?? null,
    sourceTopics: facts.envelope.sourceTopics ?? [],
  };
}

/**
 * Read `{ ...envelope, [arrayKey]: [...] }`. Absence of the file is a hard error
 * for facts (nothing to store), but tolerated as an empty list for gaps/features
 * — a url-only run with no gaps is valid, and the report should say "0 gaps",
 * not crash.
 */
function readEnvelope(file, arrayKey) {
  if (!fs.existsSync(file)) {
    if (arrayKey === 'facts') {
      throw new Error(`knowledge-store: required input missing: ${file}`);
    }
    return { envelope: {}, items: [] };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`knowledge-store: ${file} is not valid JSON: ${e.message}`);
  }
  const items = Array.isArray(doc[arrayKey]) ? doc[arrayKey] : [];
  return { envelope: doc, items };
}
