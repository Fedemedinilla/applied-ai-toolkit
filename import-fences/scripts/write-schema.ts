// Writes schema/config.schema.json from the zod schema in src/config.ts.
// Run it after changing the config format: node import-fences/scripts/write-schema.ts
// test/schema.test.ts fails while the committed file and the zod schema differ.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configJsonSchema } from '../src/config.ts';

const folder = fileURLToPath(new URL('../schema/', import.meta.url));
mkdirSync(folder, { recursive: true });
writeFileSync(`${folder}config.schema.json`, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log('wrote import-fences/schema/config.schema.json');
