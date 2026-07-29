import { copyFile, mkdir, readdir } from 'node:fs/promises';

const source = new URL('../schemas/', import.meta.url);
const destination = new URL('../docs/public/schemas/', import.meta.url);

await mkdir(destination, { recursive: true });
const schemas = (await readdir(source))
  .filter((file) => file.endsWith('.schema.json'));
await Promise.all(schemas.map((file) => (
  copyFile(new URL(file, source), new URL(file, destination))
)));
console.log(`schemas: published ${schemas.length} files`);
