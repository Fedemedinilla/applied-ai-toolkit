// A published CLI is run by its bin name, so its usage line must name the bin, not the
// repository path (`node slop-lint/cli.ts`) a user of the npm package does not have.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

for (const folder of ['slop-lint', 'import-fences', 'csp-build-guard']) {
  const pkg = JSON.parse(readFileSync(`${ROOT}${folder}/package.json`, 'utf8')) as { bin: Record<string, string> };
  const [bin] = Object.keys(pkg.bin);
  describe(`${folder} usage`, () => {
    it(`names the ${bin} bin when an argument is wrong`, () => {
      const r = spawnSync(process.execPath, [`${folder}/cli.ts`, '--no-such-flag'], { cwd: ROOT, encoding: 'utf8' });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`^usage: ${bin} `, 'mu'));
      expect(r.stderr).not.toContain('cli.ts');
    });
  });
}
