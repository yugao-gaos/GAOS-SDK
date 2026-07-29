import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';

const SOURCE_ROOT = new URL('../src/', import.meta.url);
const SCHEMA_ROOT = new URL('../schemas/', import.meta.url);
const CANONICAL_SCHEMA_BASE =
  'https://yugao-gaos.github.io/GAOS-SDK/schemas/';

async function sourceFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      output.push(...await sourceFiles(new URL(`${entry.name}/`, directory), relative));
    } else if (entry.name.endsWith('.ts')) {
      output.push(normalize(relative));
    }
  }
  return output;
}

function relativeImports(source) {
  const imports = [];
  const pattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function resolveImport(importer, specifier, files) {
  if (!specifier.startsWith('.')) return undefined;
  const candidate = normalize(join(
    dirname(importer),
    specifier.replace(/\.js$/, '.ts'),
  ));
  if (files.has(candidate)) return candidate;
  const index = normalize(join(candidate.replace(/\.ts$/, ''), 'index.ts'));
  return files.has(index) ? index : undefined;
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of graph.get(node) ?? []) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dependency)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || graph.get(node)?.includes(node)) {
      components.push(component);
    }
  }

  for (const node of graph.keys()) if (!indexes.has(node)) visit(node);
  return components;
}

function reachableFrom(entry, graph) {
  const visited = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return visited;
}

const sourceList = await sourceFiles(SOURCE_ROOT);
const sourceSet = new Set(sourceList);
const graph = new Map();
const nodeBuiltins = new Map();
const failures = [];

for (const file of sourceList) {
  const source = await readFile(new URL(file, SOURCE_ROOT), 'utf8');
  const imports = relativeImports(source);
  graph.set(
    file,
    imports
      .map((specifier) => resolveImport(file, specifier, sourceSet))
      .filter((dependency) => dependency !== undefined),
  );
  nodeBuiltins.set(file, imports.filter((specifier) => specifier.startsWith('node:')));
  if (
    file !== 'engine/index.ts'
    && imports.some((specifier) => /(?:^|\/)engine\/index\.js$/.test(specifier))
  ) {
    failures.push(`${file} imports the public engine barrel`);
  }
}

for (const cycle of stronglyConnectedComponents(graph)) {
  failures.push(`dependency cycle: ${cycle.join(' -> ')}`);
}

const rootDependencies = reachableFrom('index.ts', graph);
if (rootDependencies.has('arena.ts')) {
  failures.push('the product-neutral root depends on the Arena adapter');
}
for (const entry of ['index.ts']) {
  for (const file of reachableFrom(entry, graph)) {
    for (const builtin of nodeBuiltins.get(file) ?? []) {
      failures.push(`the browser-safe ${entry} reaches ${builtin} through ${file}`);
    }
  }
}

const schemaFiles = (await readdir(SCHEMA_ROOT))
  .filter((file) => file.endsWith('.schema.json'))
  .sort();
for (const file of schemaFiles) {
  const schema = JSON.parse(await readFile(new URL(file, SCHEMA_ROOT), 'utf8'));
  const expected = `${CANONICAL_SCHEMA_BASE}${basename(file)}`;
  if (schema.$id !== expected) {
    failures.push(`${file} must use canonical $id ${expected}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`architecture: ${failure}`);
  process.exitCode = 1;
} else {
  const edgeCount = [...graph.values()]
    .reduce((total, dependencies) => total + dependencies.length, 0);
  console.log(
    `architecture: ${sourceList.length} modules, ${edgeCount} edges, `
    + `${schemaFiles.length} canonical schemas, no forbidden boundaries`,
  );
}
