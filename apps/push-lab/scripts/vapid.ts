// Prints a fresh VAPID key pair as the three lines server/serve.ts reads:
//
//   node apps/push-lab/scripts/vapid.ts > apps/push-lab/.env     (.env is ignored by git)
//
// Generate the pair once per deployment and keep both halves together. Every subscription is
// bound to the public key it was made with: a new pair means every device subscribes again.
// The subject defaults to a placeholder; set your own mailto: or https: address with --subject.

import { checkVapid, ENV, generateVapidPair } from '../server/vapid.ts';

const flag = process.argv.indexOf('--subject');
const subject = flag === -1 ? 'mailto:you@example.test' : (process.argv[flag + 1] ?? '');
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
