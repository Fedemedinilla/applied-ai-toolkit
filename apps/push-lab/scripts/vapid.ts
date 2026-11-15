// Prints a fresh VAPID key pair as the three lines server/serve.ts reads:
//
//   node apps/push-lab/scripts/vapid.ts > apps/push-lab/.env     (.env is ignored by git)
//
// Generate the pair once per deployment and keep both halves together. Every subscription is
// bound to the public key it was made with: a new pair means every device subscribes again.
// The subject defaults to a placeholder; set your own mailto: or https: address with --subject
// (as `--subject value` or `--subject=value`). Any other argument stops it with exit 1.

import { checkVapid, ENV, generateVapidPair } from '../server/vapid.ts';

// --subject value or --subject=value, and nothing else: a misspelled or unknown argument would
// otherwise leave the placeholder subject in .env with no warning.
function subjectFrom(args: readonly string[]): string {
  const [first, second, ...rest] = args;
  if (first === undefined) return 'mailto:you@example.test';
  if (first.startsWith('--subject=') && second === undefined) return first.slice('--subject='.length);
  if (first === '--subject' && rest.length === 0) return second ?? '';
  console.error(`usage: node apps/push-lab/scripts/vapid.ts [--subject mailto:you@example.test], got "${args.join(' ')}"`);
  process.exit(1);
}

const subject = subjectFrom(process.argv.slice(2));
const pair = generateVapidPair();
const check = checkVapid({ ...pair, subject });
if (!check.pairMatches) throw new Error('generated pair does not verify');
if (!check.subjectOk) {
  console.error(`--subject must be a mailto: or https: URL, got "${subject}"`);
  process.exit(1);
}
console.log(`${ENV.publicKey}=${pair.publicKey}`);
console.log(`${ENV.privateKey}=${pair.privateKey}`);
console.log(`${ENV.subject}=${subject}`);
