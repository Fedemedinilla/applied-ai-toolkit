// The part of SARIF 2.1.0 that GitHub code scanning reads from an upload, as a zod schema, plus
// the rules this CLI adds on top: relative forward-slash uris, ruleIndex pointing at its rule,
// unique rule ids. Written here so the tests need no network and no copy of the full schema.
import { z } from 'zod';

const text = z.object({ text: z.string().min(1) });
const level = z.enum(['none', 'note', 'warning', 'error']);
const line = z.number().int().min(1);

const uri = z
  .string()
  .min(1)
  .refine((u) => !u.includes('\\'), 'uses a backslash')
  .refine((u) => !u.startsWith('/') && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(u), 'is absolute')
  .refine((u) => !u.startsWith('./'), 'starts with ./');

const region = z
  .object({ startLine: line, startColumn: line, endLine: line, endColumn: line })
  .refine((r) => r.endLine > r.startLine || (r.endLine === r.startLine && r.endColumn >= r.startColumn), 'ends before it starts');

const result = z.object({
  ruleId: z.string().min(1),
  ruleIndex: z.number().int().min(0),
  level,
  message: text,
  locations: z
    .array(z.object({ physicalLocation: z.object({ artifactLocation: z.object({ uri }), region }) }))
    .min(1),
  partialFingerprints: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/u)),
});

const rule = z.object({
  id: z.string().min(1),
  shortDescription: text,
  fullDescription: text,
  help: text,
  helpUri: z.url({ protocol: /^https$/u }).optional(),
  defaultConfiguration: z.object({ level }),
});

export const sarifLog = z
  .object({
    $schema: z.literal('https://json.schemastore.org/sarif-2.1.0.json'),
    version: z.literal('2.1.0'),
    runs: z
      .array(
        z.object({
          tool: z.object({ driver: z.object({ name: z.literal('slop-lint'), informationUri: z.url(), rules: z.array(rule) }) }),
          columnKind: z.literal('unicodeCodePoints'),
          results: z.array(result),
        }),
      )
      .length(1),
  })
  .superRefine((log, ctx) => {
    for (const run of log.runs) {
      const ids = run.tool.driver.rules.map((r) => r.id);
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate rule id' });
      run.results.forEach((r, i) => {
        if (ids[r.ruleIndex] !== r.ruleId) ctx.addIssue({ code: 'custom', message: `result ${i}: ruleIndex ${r.ruleIndex} is not ${r.ruleId}` });
      });
    }
  });

export type ParsedSarif = z.infer<typeof sarifLog>;
