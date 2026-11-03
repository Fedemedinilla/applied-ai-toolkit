/**
 * Structured outputs from a zod schema: z.toJSONSchema, reduced to what the API accepts, and a
 * validator that runs the same zod schema on the response text.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { RequestError, type OutputProblem } from './errors.ts';

type SchemaNode = { readonly [key: string]: unknown };

/** String formats the structured outputs API accepts. */
const ACCEPTED_FORMATS: ReadonlySet<string> = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/** Kept as they are. */
const KEPT: ReadonlySet<string> = new Set(['type', 'enum', 'const', 'description', 'title', 'default', 'required', '$ref']);

/**
 * Constraints the API does not accept. They move into the description, so the model still reads
 * them, and zod enforces them when the response is validated (a 0 to 100 score, for example).
 */
const TO_DESCRIPTION: ReadonlySet<string> = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'contentEncoding',
  'contentMediaType',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/**
 * Complexity limits of structured outputs, across the whole schema including $defs: at most 24
 * optional properties and 16 unions (anyOf, or a type list, which is how zod writes a nullable).
 * Going over returns a 400 only at call time, so the gateway checks first.
 */
export const MAX_OPTIONAL_PROPERTIES = 24;
export const MAX_UNIONS = 16;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function node(value: unknown, path: string): SchemaNode {
  if (!isNode(value)) throw new RequestError(`Schema: ${path} is not an object`);
  return value;
}

/**
 * Turns the JSON schema zod produces into what the structured outputs API accepts. Written here
 * instead of using the SDK helper because the helper in SDK 1.1.0 (betaZodOutputFormat) strips
 * `enum` and `const` from strings and only mentions them in the description, so the model could
 * return a value outside the enum. This function:
 * - keeps type (also as a list), enum, const, anyOf, allOf, $ref and $defs, required, default, the
 *   accepted formats, and minItems 0 or 1;
 * - turns oneOf into anyOf (zod uses oneOf for discriminated unions; zod checks the discriminator);
 * - sets additionalProperties false on every object, which the API requires;
 * - moves TO_DESCRIPTION constraints into the description, except those that say nothing: the
 *   safe-integer bounds zod puts on every z.int(), and the pattern that duplicates an accepted
 *   format (z.email(), z.uuid());
 * - rejects anything else (z.record, z.tuple, not, if/then) with RequestError, because moving it
 *   into the description would change the output's shape silently;
 * - rejects recursive schemas and schemas over MAX_OPTIONAL_PROPERTIES or MAX_UNIONS, which the
 *   API would reject with a 400 at call time.
 */
export function toApiJsonSchema(input: SchemaNode): Record<string, unknown> {
  const clean = cleanNode(input, '#');
  requireNoRecursion(clean);
  requireComplexityLimits(clean);
  return clean;
}

function cleanNode(input: SchemaNode, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  const map = (value: unknown, sub: string) =>
    Object.fromEntries(Object.entries(node(value, `${path}/${sub}`)).map(([k, s]) => [k, cleanNode(node(s, `${path}/${sub}/${k}`), `${path}/${sub}/${k}`)]));
  const list = (value: unknown, sub: string) => {
    if (!Array.isArray(value)) throw new RequestError(`Schema: ${path}/${sub} is not a list`);
    return value.map((s, i) => cleanNode(node(s, `${path}/${sub}/${i}`), `${path}/${sub}/${i}`));
  };

  for (const [key, value] of Object.entries(input)) {
    if (KEPT.has(key)) {
      out[key] = value;
    } else if (TO_DESCRIPTION.has(key)) {
      constraints[key] = value;
    } else {
      switch (key) {
        case '$schema':
          break;
        case 'additionalProperties':
          // z.looseObject emits {} and z.strictObject false: both end up false. z.record emits a
          // schema, and free-form keys cannot be requested with additionalProperties false.
          if (isNode(value) && Object.keys(value).length > 0) {
            throw new RequestError(`Schema: ${path} has free-form keys (z.record), which the API does not accept`);
          }
          break;
        case 'properties':
        case '$defs':
        case 'definitions':
          out[key] = map(value, key);
          break;
        case 'items':
          out[key] = cleanNode(node(value, `${path}/items`), `${path}/items`);
          break;
        case 'anyOf':
        case 'oneOf':
          out['anyOf'] = list(value, key);
          break;
        case 'allOf':
          out[key] = list(value, key);
          break;
        case 'format':
          if (typeof value === 'string' && ACCEPTED_FORMATS.has(value)) out[key] = value;
          else constraints[key] = value;
          break;
        case 'minItems':
          if (value === 0 || value === 1) out[key] = value;
          else constraints[key] = value;
          break;
        default:
          throw new RequestError(`Schema: ${path} uses "${key}", which structured outputs do not accept`);
      }
    }
  }
  if (constraints['minimum'] === Number.MIN_SAFE_INTEGER) delete constraints['minimum'];
  if (constraints['maximum'] === Number.MAX_SAFE_INTEGER) delete constraints['maximum'];
  if ('format' in out) delete constraints['pattern'];

  const type = out['type'];
  if (type === 'object' || (Array.isArray(type) && type.includes('object'))) out['additionalProperties'] = false;
  if (Object.keys(constraints).length > 0) {
    const previous = typeof out['description'] === 'string' ? `${out['description']}\n\n` : '';
    out['description'] = previous + JSON.stringify(constraints);
  }
  return out;
}

/** Subschemas of a cleaned node, optionally without the root's $defs. */
function children(n: SchemaNode, withDefs: boolean): SchemaNode[] {
  const found: SchemaNode[] = [];
  for (const key of withDefs ? ['properties', '$defs', 'definitions'] : ['properties']) {
    const value = n[key];
    if (isNode(value)) found.push(...Object.values(value).filter(isNode));
  }
  if (isNode(n['items'])) found.push(n['items']);
  for (const key of ['anyOf', 'allOf']) {
    const value = n[key];
    if (Array.isArray(value)) found.push(...value.filter(isNode));
  }
  return found;
}

/** The $refs in a subtree. At the root it skips $defs, which are visited one by one. */
function refs(n: SchemaNode, isRoot: boolean): string[] {
  const own = typeof n['$ref'] === 'string' ? [n['$ref']] : [];
  return [...own, ...children(n, !isRoot).flatMap((c) => refs(c, false))];
}

const REF_TO_DEFS = /^#\/(\$defs|definitions)\/([^/]+)$/;

/** Rejects a $ref to "#", a cycle among $defs entries, and a $ref that is not a $defs entry. */
function requireNoRecursion(root: SchemaNode): void {
  const defs = new Map<string, SchemaNode>();
  for (const key of ['$defs', 'definitions']) {
    const value = root[key];
    if (isNode(value)) for (const [name, def] of Object.entries(value)) if (isNode(def)) defs.set(`#/${key}/${name}`, def);
  }
  const target = (ref: string): string => {
    if (ref === '#') throw new RequestError('Schema: recursive ($ref to "#"), and structured outputs do not accept recursive schemas');
    if (!REF_TO_DEFS.test(ref) || !defs.has(ref)) throw new RequestError(`Schema: $ref "${ref}" does not point to a $defs entry`);
    return ref;
  };
  const done = new Set<string>();
  const visit = (ref: string, trail: readonly string[]): void => {
    if (trail.includes(ref)) {
      throw new RequestError(`Schema: recursive (${[...trail, ref].join(' -> ')}), and structured outputs do not accept recursive schemas`);
    }
    if (done.has(ref)) return;
    const def = defs.get(ref);
    if (def) for (const next of refs(def, false).map(target)) visit(next, [...trail, ref]);
    done.add(ref);
  };
  for (const ref of refs(root, true).map(target)) visit(ref, []);
  for (const ref of defs.keys()) visit(ref, []);
}

function requireComplexityLimits(root: SchemaNode): void {
  let optional = 0;
  let unions = 0;
  const count = (n: SchemaNode): void => {
    const properties = n['properties'];
    if (isNode(properties)) {
      const required = new Set<unknown>(Array.isArray(n['required']) ? n['required'] : []);
      optional += Object.keys(properties).filter((key) => !required.has(key)).length;
    }
    if (Array.isArray(n['anyOf']) || Array.isArray(n['type'])) unions += 1;
    for (const c of children(n, true)) count(c);
  };
  count(root);
  if (optional > MAX_OPTIONAL_PROPERTIES) {
    throw new RequestError(`Schema: has ${optional} optional properties and the API accepts up to ${MAX_OPTIONAL_PROPERTIES}`);
  }
  if (unions > MAX_UNIONS) throw new RequestError(`Schema: has ${unions} unions (anyOf or nullable) and the API accepts up to ${MAX_UNIONS}`);
}

export type Validation<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problems: readonly OutputProblem[] };

export interface StructuredFormat<T> {
  readonly format: Anthropic.Beta.BetaJSONOutputFormat;
  /** Validates the response text. Returns the data or the problems; never throws. */
  readonly validate: (text: string) => Validation<T>;
}

/**
 * The output_config.format and a zod validator. Neither parse() nor the SDK helpers are used: with
 * a format that carries `parse`, the SDK validates as soon as the message ends and throws on a
 * refusal or a max_tokens stop, before the gateway reads stop_reason, and the response is lost
 * together with its usage. io 'input': the model's JSON is what goes into zod.
 */
export function structuredFormat<S extends z.ZodType>(schema: S): StructuredFormat<z.output<S>> {
  let raw: unknown;
  try {
    raw = z.toJSONSchema(schema, { io: 'input' });
  } catch (error) {
    // z.date, z.bigint, z.map, a transform without an input type: zod cannot write them as JSON schema.
    throw new RequestError('Schema: zod cannot convert it to JSON schema', { cause: error });
  }
  const format: Anthropic.Beta.BetaJSONOutputFormat = { type: 'json_schema', schema: toApiJsonSchema(node(raw, '#')) };
  const validate = (text: string): Validation<z.output<S>> => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // The SyntaxError message quotes part of the text, so it goes nowhere.
      return { ok: false, problems: [{ path: '', code: 'invalid_json' }] };
    }
    const result = schema.safeParse(json);
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, problems: result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code })) };
  };
  return { format, validate };
}
