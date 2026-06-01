// Topic: dependencies — manifest-declared packages per ecosystem.
//
// Sources:
//   * package-json   — npm
//   * pyproject      — Python (PEP 621 / Poetry)
//   * pom-xml        — Maven
//   * csproj         — NuGet
//
// Dedup key: `${ecosystem}:${packageName}`.

import { indexedItem, observation } from '../lib/models.mjs';


const MANIFEST_SOURCES = {
  'package-json': 'npm',
  'pyproject':    'pip',
  'pom-xml':      'maven',
  'csproj':       'nuget',
};


/** @param {import('../lib/sources.mjs').LoadedSources} sources */
export function build(sources) {
  /** @type {Map<string, {primary: Object, observations: import('../lib/models.mjs').Observation[]}>} */
  const byKey = new Map();

  for (const [id, ecosystem] of Object.entries(MANIFEST_SOURCES)) {
    const bundle = sources.codeExtractors[id];
    if (!bundle?.frameworkFacts?.length) continue;

    for (const fact of bundle.frameworkFacts) {
      // Each fact represents a manifest claim. Accept anything that
      // looks dep-shaped — manifest extractors use a variety of `kind`
      // labels (dependency, dev_dependency, framework_dep,
      // frontend_framework, test_framework, build_tool, ...). Skip
      // non-dep kinds explicitly when we can recognise them.
      if (_isNonDepFact(fact)) continue;
      const pkgName = _packageNameFromFact(fact);
      if (!pkgName) continue;
      const key = `${ecosystem}:${pkgName}`;
      const fields = {
        name: pkgName,
        ecosystem,
        version: fact.value ?? null,
        kind: fact.kind ?? 'dependency',
        manifestFile: (fact.related_files ?? [])[0] ?? null,
        display: fact.display ?? null,
      };
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = {
          primary: { name: pkgName, ecosystem, version: fields.version, kind: fields.kind },
          observations: [],
        };
        byKey.set(key, bucket);
      }
      bucket.observations.push(observation({
        sourceId: id, discoveryTier: 'ast', fields,
        sourceFile: fields.manifestFile,
      }));
    }
  }

  return [...byKey.entries()].map(([key, { primary, observations }]) =>
    indexedItem('dependencies', key, primary, observations)
  );
}


// Kinds that are NOT package dependencies (scripts, build config, etc.)
const _NON_DEP_KINDS = new Set([
  'script', 'npm_script', 'pnpm_script', 'yarn_script',
  'config', 'engine', 'python_version', 'java_version',
  'workspace', 'monorepo_layout',
]);

function _isNonDepFact(fact) {
  return _NON_DEP_KINDS.has(fact.kind);
}

function _packageNameFromFact(fact) {
  if (fact.key?.startsWith('dep:')) return fact.key.slice(4);
  // Most manifest extractors put the package name directly in `key`.
  if (fact.key) return fact.key;
  if (fact.display && typeof fact.display === 'string') {
    // display often looks like "fastapi >=0.100,<1" — take the head.
    return fact.display.split(/[\s<>=!~]/)[0].trim() || null;
  }
  return null;
}
