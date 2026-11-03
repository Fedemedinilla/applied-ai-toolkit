import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RequestError } from '../src/errors.ts';
import { MAX_OPTIONAL_PROPERTIES, MAX_UNIONS, structuredFormat, toApiJsonSchema } from '../src/schema.ts';

const Review = z.object({
  verdict: z.enum(['accept', 'revise', 'reject']),
  // The API accepts neither minimum nor maximum: they move into the description and zod enforces them.
  score: z.int().min(0).max(100),
  findings: z.array(z.object({ claim: z.string(), status: z.enum(['supported', 'partial', 'unsupported']), sourceIds: z.array(z.string()) })),
});

describe('structuredFormat: the schema that is sent', () => {
  it('is the zod JSON schema passed through toApiJsonSchema, and keeps the enums', () => {
    const { format } = structuredFormat(Review);
    expect(format.type).toBe('json_schema');
    expect(format.schema).toEqual({
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['accept', 'revise', 'reject'] },
        score: { type: 'integer', description: '{"minimum":0,"maximum":100}' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              claim: { type: 'string' },
              status: { type: 'string', enum: ['supported', 'partial', 'unsupported'] },
              sourceIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['claim', 'status', 'sourceIds'],
            additionalProperties: false,
          },
        },
      },
      required: ['verdict', 'score', 'findings'],
      additionalProperties: false,
    });
  });

  it('the SDK helper drops the enum and leaves it as text, which is why it is not used', () => {
    const { parse: _parse, ...fromSdk } = betaZodOutputFormat(Review);
    expect(fromSdk.schema).not.toHaveProperty('properties.verdict.enum');
    expect(fromSdk.schema).toHaveProperty('properties.verdict.description', expect.stringContaining('accept'));
    expect(structuredFormat(Review).format.schema).toHaveProperty('properties.verdict.enum', ['accept', 'revise', 'reject']);
  });

  it('a schema the API does not accept fails before calling', () => {
    expect(() => structuredFormat(z.object({ at: z.date() }))).toThrow(RequestError);
    // z.record: free-form keys cannot be requested with additionalProperties false.
    expect(() => structuredFormat(z.object({ free: z.record(z.string(), z.string()) }))).toThrow(RequestError);
    expect(() => toApiJsonSchema({ type: 'object', additionalProperties: { type: 'string' } })).toThrow(/z.record/);
    expect(() => structuredFormat(z.object({ pair: z.tuple([z.string(), z.int()]) }))).toThrow(/prefixItems/);
  });
});

describe('toApiJsonSchema', () => {
  it('keeps type lists (nullable), const, default, accepted formats and minItems 0 or 1', () => {
    const schema = z.object({
      vendor: z.string().nullable(),
      kind: z.literal('invoice'),
      currency: z.string().default('USD'),
      issued: z.iso.date(),
      lines: z.array(z.string()).min(1),
    });
    const clean = toApiJsonSchema(z.toJSONSchema(schema, { io: 'input' }));
    expect(clean).toHaveProperty('properties.vendor', { type: ['string', 'null'] });
    expect(clean).toHaveProperty('properties.kind', { type: 'string', const: 'invoice' });
    expect(clean).toHaveProperty('properties.currency', { type: 'string', default: 'USD' });
    // date is an accepted format, and the pattern zod adds says the same thing: not even in the description.
    expect(clean).toHaveProperty('properties.issued', { type: 'string', format: 'date' });
    expect(clean).toHaveProperty('properties.lines.minItems', 1);
    expect(clean).not.toHaveProperty('$schema');
  });

  it('moves unsupported constraints into the description and keeps the existing description', () => {
    const schema = z.object({
      title: z.string().min(1).max(80).describe('The title as written in the source'),
      lines: z.array(z.string()).min(2).max(30),
      link: z.url(),
    });
    const clean = toApiJsonSchema(z.toJSONSchema(schema, { io: 'input' }));
    expect(clean).toHaveProperty('properties.title', { type: 'string', description: 'The title as written in the source\n\n{"minLength":1,"maxLength":80}' });
    expect(clean).toHaveProperty('properties.lines', { type: 'array', items: { type: 'string' }, description: '{"minItems":2,"maxItems":30}' });
    expect(clean).toHaveProperty('properties.link.format', 'uri');
  });

  it('turns discriminated unions (oneOf) into anyOf, with additionalProperties false on each object', () => {
    const schema = z.object({
      input: z.discriminatedUnion('kind', [z.object({ kind: z.literal('invoice'), vendor: z.string() }), z.object({ kind: z.literal('not_an_invoice') })]),
    });
    const clean = toApiJsonSchema(z.toJSONSchema(schema, { io: 'input' }));
    expect(clean).not.toHaveProperty('properties.input.oneOf');
    expect(clean).toHaveProperty('properties.input.anyOf', [
      expect.objectContaining({ additionalProperties: false, required: ['kind', 'vendor'] }),
      expect.objectContaining({ additionalProperties: false, required: ['kind'] }),
    ]);
  });

  it('leaves out what constrains nothing: the safe-integer bounds of z.int() and the regex of an accepted format', () => {
    const schema = z.object({ count: z.int(), fromZero: z.int().min(0), small: z.int32(), email: z.email(), id: z.uuid(), at: z.iso.time() });
    const clean = toApiJsonSchema(z.toJSONSchema(schema, { io: 'input' }));
    expect(clean).toHaveProperty('properties.count', { type: 'integer' });
    expect(clean).toHaveProperty('properties.fromZero', { type: 'integer', description: '{"minimum":0}' });
    // A range that does constrain (int32) stays.
    expect(clean).toHaveProperty('properties.small.description', '{"minimum":-2147483648,"maximum":2147483647}');
    expect(clean).toHaveProperty('properties.email', { type: 'string', format: 'email' });
    expect(clean).toHaveProperty('properties.id', { type: 'string', format: 'uuid' });
    // z.iso.time() has no format: its pattern is the only statement of the shape, so it goes to the description.
    expect(clean).toHaveProperty('properties.at.description', expect.stringContaining('pattern'));
  });

  it('rejects a recursive schema before calling, because the API does not accept one', () => {
    const Node = z.object({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
    });
    // At the root, zod writes it as a $ref to "#".
    expect(() => structuredFormat(Node)).toThrow(/recursive \(\$ref to "#"\)/);
    // Nested, as a $defs entry that names itself.
    expect(() => structuredFormat(z.object({ tree: Node }))).toThrow('#/$defs/__schema0 -> #/$defs/__schema0');
    const A = z.object({
      get b() {
        return B.optional();
      },
    });
    const B = z.object({
      get a() {
        return A.optional();
      },
    });
    expect(() => structuredFormat(z.object({ x: A }))).toThrow(RequestError);
    expect(() =>
      toApiJsonSchema({ type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } }, B: { $ref: '#/$defs/A' } } }),
    ).toThrow('#/$defs/A -> #/$defs/B -> #/$defs/A');
  });

  it('accepts a shared $defs entry without a cycle, and rejects a $ref that is not a $defs entry', () => {
    const Currency = z.enum(['EUR', 'USD']).meta({ id: 'Currency' });
    const clean = toApiJsonSchema(z.toJSONSchema(z.object({ from: Currency, to: Currency }), { io: 'input' }));
    expect(clean).toHaveProperty('properties.from', { $ref: '#/$defs/Currency' });
    expect(clean).toHaveProperty('$defs.Currency.enum', ['EUR', 'USD']);
    expect(() => toApiJsonSchema({ type: 'object', properties: { a: { $ref: '#/$defs/Missing' } } })).toThrow(/does not point to a \$defs entry/);
    expect(() => toApiJsonSchema({ type: 'object', properties: { a: { $ref: '#/properties/b' }, b: { type: 'string' } } })).toThrow(RequestError);
  });

  it('enforces the API complexity limits: optional properties and unions', () => {
    const withOptional = (n: number) => z.object(Object.fromEntries(Array.from({ length: n }, (_, i) => [`field_${i}`, z.string().optional()])));
    expect(() => structuredFormat(withOptional(MAX_OPTIONAL_PROPERTIES))).not.toThrow();
    expect(() => structuredFormat(withOptional(MAX_OPTIONAL_PROPERTIES + 1))).toThrow(`has ${MAX_OPTIONAL_PROPERTIES + 1} optional properties`);
    // A nullable is a union (type list or anyOf), also inside a list.
    const withNullable = (n: number) => z.object(Object.fromEntries(Array.from({ length: n }, (_, i) => [`field_${i}`, z.string().nullable()])));
    expect(() => structuredFormat(withNullable(MAX_UNIONS))).not.toThrow();
    expect(() => structuredFormat(withNullable(MAX_UNIONS + 1))).toThrow(`has ${MAX_UNIONS + 1} unions`);
    const nested = z.object({ a: withNullable(MAX_UNIONS - 1), b: z.array(z.object({ x: z.string() }).nullable()), c: z.string().nullable() });
    expect(() => structuredFormat(nested)).toThrow(`has ${MAX_UNIONS + 1} unions`);
  });

  it('closes z.looseObject: the API requires additionalProperties false', () => {
    expect(toApiJsonSchema(z.toJSONSchema(z.looseObject({ a: z.string() }), { io: 'input' }))['additionalProperties']).toBe(false);
  });

  it('rejects an unknown keyword with its path instead of changing the output shape silently', () => {
    expect(() => toApiJsonSchema({ type: 'object', properties: { a: { not: { type: 'string' } } } })).toThrow('Schema: #/properties/a uses "not", which structured outputs do not accept');
  });
});

describe('structuredFormat: validating what comes back', () => {
  const { validate } = structuredFormat(Review);
  const valid = { verdict: 'revise', score: 72, findings: [] };

  it('returns typed data when the JSON satisfies the schema', () => {
    expect(validate(JSON.stringify(valid))).toEqual({ ok: true, data: valid });
  });

  it('text that is not JSON', () => {
    expect(validate('{"verdict": "rev')).toEqual({ ok: false, problems: [{ path: '', code: 'invalid_json' }] });
  });

  it('zod enforces what the API schema cannot: a score out of range', () => {
    expect(validate(JSON.stringify({ ...valid, score: 150 }))).toEqual({ ok: false, problems: [{ path: 'score', code: 'too_big' }] });
  });

  it('problems carry the zod path and code, never the value that came back', () => {
    const result = validate(JSON.stringify({ ...valid, verdict: 'TEXT FROM THE INPUT', findings: [{ claim: 1 }] }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('TEXT FROM THE INPUT');
    if (!result.ok) {
      expect(result.problems).toContainEqual({ path: 'verdict', code: 'invalid_value' });
      expect(result.problems).toContainEqual({ path: 'findings.0.claim', code: 'invalid_type' });
    }
  });
});
