// The command line. This is the only file in the folder that reads the environment: the key goes
// to the gateway's client as an argument, so the SDK never looks it up on its own.
//
//   node content-forge/cli.ts validate
//   ANTHROPIC_API_KEY=sk-ant-... node content-forge/cli.ts generate --entity card --count 5
//   node content-forge/cli.ts promote --entity card --all
//   node content-forge/cli.ts stats
//
// generate without the key exits 3 before any call; the other commands never need it.

import { runCli } from './src/commands.ts';

const key = process.env['ANTHROPIC_API_KEY']?.trim() ?? '';

process.exitCode = await runCli(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  apiKey: key === '' ? null : key,
});
