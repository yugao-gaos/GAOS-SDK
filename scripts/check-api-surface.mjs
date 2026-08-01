import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor';

const projectFolder = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(
  resolve(projectFolder, 'package.json'),
  'utf8',
));
const reportFolder = resolve(projectFolder, 'etc/api');
const reportTempFolder = resolve(projectFolder, 'temp/api');
const update = process.argv.includes('--update');

await mkdir(reportFolder, { recursive: true });
await mkdir(reportTempFolder, { recursive: true });

const entryPoints = Object.entries(packageJson.exports)
  .flatMap(([subpath, target]) => {
    if (typeof target === 'string' || !target.types) return [];
    const name = subpath === '.'
      ? 'root'
      : subpath.slice(2).replaceAll('/', '-');
    return [{ name, types: target.types }];
  });

let failed = false;
for (const entry of entryPoints) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder,
      mainEntryPointFilePath: resolve(projectFolder, entry.types),
      compiler: {
        tsconfigFilePath: resolve(projectFolder, 'tsconfig.build.json'),
        skipLibCheck: true,
      },
      apiReport: {
        enabled: true,
        includeForgottenExports: true,
        reportFileName: entry.name,
        reportFolder,
        reportTempFolder,
      },
      dtsRollup: { enabled: false },
      docModel: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: 'lf',
      messages: {
        compilerMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Error },
        },
        extractorMessageReporting: {
          default: { logLevel: ExtractorLogLevel.None },
        },
        tsdocMessageReporting: {
          default: { logLevel: ExtractorLogLevel.None },
        },
      },
    },
    configObjectFullPath: undefined,
    packageJson,
    packageJsonFullPath: resolve(projectFolder, 'package.json'),
  });
  const result = Extractor.invoke(config, {
    localBuild: update,
    printApiReportDiff: !update,
    typescriptCompilerFolder: resolve(projectFolder, 'node_modules/typescript'),
  });
  if (!result.succeeded || (!update && result.apiReportChanged)) {
    failed = true;
    console.error(`api surface changed: ${entry.name}`);
  } else {
    console.log(`api surface ${update ? 'updated' : 'verified'}: ${entry.name}`);
  }
}

if (failed) {
  console.error('Run `npm run api:update` to accept intentional public API changes.');
  process.exitCode = 1;
}
