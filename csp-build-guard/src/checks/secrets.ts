/**
 * Check 3. The value of each named environment variable must not appear in any file under --dir,
 * in plain form or in the encodings a bundler or a serializer produces. Compressed copies (.gz,
 * .br) are searched after decompression. Values are never printed, only variable names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { listFiles } from '../site.ts';
import { type CheckResult, type Context, type Failure, plural } from '../types.ts';

/** The forms of a value worth searching for, each with a label for reports. */
export function needlesFor(value: string): Array<{ form: string; bytes: Buffer }> {
  const forms: Array<[string, string]> = [
    ['plain', value],
    ['JSON-escaped', JSON.stringify(value).slice(1, -1)],
    ['URL-encoded', encodeURIComponent(value)],
    ['base64', Buffer.from(value).toString('base64').replace(/=+$/, '')],
    ['base64url', Buffer.from(value).toString('base64url')],
  ];
  const seen = new Set<string>();
  return forms.filter(([, text]) => !seen.has(text) && seen.add(text)).map(([form, text]) => ({ form, bytes: Buffer.from(text) }));
}

function contentsOf(path: string): Buffer[] {
  const raw = readFileSync(path);
  const out = [raw];
  try {
    if (path.endsWith('.gz')) out.push(gunzipSync(raw));
    else if (path.endsWith('.br')) out.push(brotliDecompressSync(raw));
  } catch {
    // Not actually compressed: the raw bytes were searched.
  }
  return out;
}

export function checkSecrets(ctx: Context): CheckResult {
  const config = ctx.config.secrets;
  if (config === undefined) return { id: 'secrets', status: 'skip', summary: 'no secrets in the config', failures: [] };
  const failures: Failure[] = [];
  const skipped: string[] = [];
  const searched: Array<{ name: string; needles: ReturnType<typeof needlesFor> }> = [];
  for (const name of config.env) {
    const value = ctx.env[name] ?? '';
    if (value.length < config.minLength) {
      const why = value ? `is shorter than ${config.minLength} characters` : 'is not set';
      if (config.missing === 'fail') failures.push({ message: `${name} ${why}: run the guard with the environment the build used` });
      else skipped.push(`${name} (${why})`);
      continue;
    }
    searched.push({ name, needles: needlesFor(value) });
  }
  const files = listFiles(ctx.site.dir);
  for (const file of files) {
    const contents = contentsOf(join(ctx.site.dir, file));
    for (const { name, needles } of searched) {
      const hit = needles.find(({ bytes }) => contents.some((c) => c.includes(bytes)));
      if (hit) failures.push({ message: `the value of ${name} is in ${file}${hit.form === 'plain' ? '' : ` (${hit.form})`}`, file });
    }
  }
  const names = searched.map((s) => s.name).join(', ') || 'none';
  const note = skipped.length ? `; skipped ${skipped.join(', ')}` : '';
  return {
    id: 'secrets',
    status: failures.length ? 'fail' : searched.length ? 'pass' : 'skip',
    summary: failures.length
      ? `${plural(failures.length, 'problem')} in ${plural(files.length, 'file')}${note}`
      : `${plural(files.length, 'file')} searched, no value of ${names}${note}`,
    failures,
  };
}
