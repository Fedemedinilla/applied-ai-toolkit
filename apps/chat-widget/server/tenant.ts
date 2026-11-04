// What a tenant is, as zod schemas. Every tenant is one row of the same tables (sql/schema.sql),
// read through the same code: adding a business adds a row, not a copy of the app. Store reads
// return `unknown` and are parsed here before use, because a database row is an external boundary.

import { z } from 'zod';
import { CONTENT_LIMITS } from './limits.ts';

/** Lowercase slug, 2 to 40 characters. The same rule as the SQL check. */
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,39}$/u;
export const TenantId = z.string().regex(TENANT_ID);

export const TONE_PRESETS = ['friendly', 'formal', 'direct'] as const;
export const TonePreset = z.enum(TONE_PRESETS);
export type TonePreset = z.infer<typeof TonePreset>;

export const PLAN_STATUSES = ['active', 'past_due', 'suspended', 'inactive'] as const;
/** past_due keeps answering (a grace period); suspended and inactive pause the widget. */
export const PAUSED: ReadonlySet<string> = new Set(['suspended', 'inactive']);

/** A host name as it appears in Origin or Referer: lowercase, no scheme, port or path. */
export const DomainName = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u);

/** Stored in either case; published lowercase. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;
/** Letters, digits, space, comma, apostrophe and hyphen: a font name that cannot leave a CSS value. */
const SAFE_FONT = /^[A-Za-z0-9 ,'-]{1,60}$/u;

/** The tenant's full row as the handlers use it. Server-side only. */
export const TenantConfig = z.object({
  tenantId: TenantId,
  /** The tenant's id in the gateway's ledger (its userId): the daily spend cap applies per tenant. */
  accountId: z.guid(),
  botName: z.string().min(1).max(CONTENT_LIMITS.botName),
  header: z.string().min(1).max(CONTENT_LIMITS.header),
  welcome: z.string().min(1).max(CONTENT_LIMITS.welcome),
  placeholder: z.string().min(1).max(CONTENT_LIMITS.placeholder),
  primaryColor: z.string().regex(HEX_COLOR),
  font: z.string().regex(SAFE_FONT),
  suggestedQuestions: z.array(z.string().min(1).max(CONTENT_LIMITS.suggestedQuestionChars)).max(CONTENT_LIMITS.suggestedQuestions),
  tonePreset: TonePreset,
  tone: z.string().max(CONTENT_LIMITS.tone),
  context: z.string().max(CONTENT_LIMITS.context),
  faq: z.string().max(CONTENT_LIMITS.faq),
  /** Hosts the widget may answer on, subdomains included. Empty: it answers nowhere. */
  allowedDomains: z.array(DomainName).max(20),
});
export type TenantConfig = z.infer<typeof TenantConfig>;

export const Plan = z.object({
  status: z.enum(PLAN_STATUSES),
  /** The plan's own monthly turn cap, or null for the deploy's default. */
  monthlyTurns: z.int().positive().nullable(),
});
export type Plan = z.infer<typeof Plan>;

/** A count from the store. Anything else (null, NaN, a string, a negative) is a failed count. */
export const Count = z.int().nonnegative();

/**
 * What GET /widget/config returns: only what the widget paints on screen. Built field by field
 * from an explicit list, so a column added to the tenant row later is not published by accident.
 */
export interface PublicConfig {
  readonly header: string;
  readonly welcome: string;
  readonly placeholder: string;
  readonly primaryColor: string;
  readonly font: string;
  readonly suggestedQuestions: readonly string[];
}

/**
 * The visual subset, with the two values the widget puts into CSS forced into a safe shape. The
 * schema already checks both; this repeats it at the edge, so a store that skips validation (a
 * hand-edited row, a migration that drops a check) still cannot publish a CSS payload.
 */
export function publicConfig(config: TenantConfig): PublicConfig {
  const color = config.primaryColor.toLowerCase();
  const font = config.font.replace(/[^A-Za-z0-9 ,'-]/gu, '').slice(0, 60);
  return {
    header: config.header,
    welcome: config.welcome,
    placeholder: config.placeholder,
    primaryColor: /^#[0-9a-f]{6}$/u.test(color) ? color : DEFAULT_LOOK.primaryColor,
    font: font.trim() === '' ? DEFAULT_LOOK.font : font,
    suggestedQuestions: config.suggestedQuestions.slice(0, CONTENT_LIMITS.suggestedQuestions),
  };
}

/** The look of a new tenant. The interface text is neutral Latin American Spanish. */
export const DEFAULT_LOOK = {
  botName: 'Asistente',
  header: 'Asistente',
  welcome: 'Hola. ¿En qué te puedo ayudar?',
  placeholder: 'Escribe tu mensaje',
  primaryColor: '#1f6f5c',
  font: 'system-ui',
} as const;

/** The fields the tenant edits in the panel. Same limits as TenantConfig, all optional. */
export const ContentPatch = z.strictObject({
  botName: TenantConfig.shape.botName.optional(),
  welcome: TenantConfig.shape.welcome.optional(),
  suggestedQuestions: TenantConfig.shape.suggestedQuestions.optional(),
  tonePreset: TonePreset.optional(),
  tone: TenantConfig.shape.tone.optional(),
  context: TenantConfig.shape.context.optional(),
  faq: TenantConfig.shape.faq.optional(),
});
export type ContentPatch = z.infer<typeof ContentPatch>;

/** A panel owner, as the auth code needs it. */
export const Owner = z.object({
  tenantId: TenantId,
  email: z.email(),
  /** Null until the owner accepts an invite. */
  passwordHash: z.string().nullable(),
  /** The nonce of the one invite that can still set the password, or null. */
  inviteNonce: z.string().nullable(),
});
export type Owner = z.infer<typeof Owner>;
