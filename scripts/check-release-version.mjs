import { readFile } from 'node:fs/promises';

const tag = process.env.RELEASE_TAG ?? process.argv[2];
if (!tag?.startsWith('v')) throw new Error('release tag must use v<version>');
const expected = tag.slice(1);
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const pyproject = await readFile(new URL('../python/pyproject.toml', import.meta.url), 'utf8');
const pythonInit = await readFile(new URL('../python/agilabs_arena/__init__.py', import.meta.url), 'utf8');
const pythonVersion = pyproject.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pythonRuntimeVersion = pythonInit.match(/^__version__\s*=\s*"([^"]+)"/m)?.[1];
if (
  packageJson.version !== expected
  || pythonVersion !== expected
  || pythonRuntimeVersion !== expected
) {
  throw new Error(
    `release ${tag} does not match package versions `
    + `(npm=${packageJson.version}, python=${pythonVersion ?? 'missing'}, `
    + `python runtime=${pythonRuntimeVersion ?? 'missing'})`,
  );
}
