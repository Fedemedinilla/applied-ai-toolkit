// Every threshold the public endpoints apply, in one object. The defaults are deliberately low, so
// a copy of this folder deployed as is errs toward refusing. A deploy passes its own numbers to
// createApp.

export interface Limits {
  /** Turns one tenant may start in `burstWindowMs`, across all its visitors. */
  readonly tenantBurstTurns: number;
  readonly burstWindowMs: number;
  /** Turns one tenant may start per calendar month. A plan can lower it, never raise it. */
  readonly tenantMonthlyTurns: number;
  /** Turns one IP (an IPv6 /64) may start in `ipWindowMs`, across all tenants, per process. */
  readonly ipTurns: number;
  readonly ipWindowMs: number;
  /** Panel login attempts, and failed operator logins, per IP in `ipWindowMs`, per process. */
  readonly loginAttempts: number;
  /** Messages kept from the end of the conversation the widget sends. */
  readonly maxMessages: number;
  /** Characters per visitor message. A longer one is refused, not cut. */
  readonly maxMessageChars: number;
  /**
   * Characters kept of each earlier assistant turn the widget sends back. Longer turns are cut,
   * not refused. A reply of MAX_TOKENS (1,200) tokens is about 5,000 characters of Spanish.
   */
  readonly maxReplyChars: number;
  /** Chat request body, read before parsing. 8 visitor turns at the limit and 8 replies at theirs fit with room to spare. */
  readonly maxBodyBytes: number;
  /** A store call slower than this counts as failed, and the turn is refused. */
  readonly storeTimeoutMs: number;
  /** max-age of a GET /widget/config answer. */
  readonly configCacheSeconds: number;
  /** IANA zone where the month starts, for the turn cap and the gateway's spend windows. */
  readonly timeZone: string;
}

export const DEFAULT_LIMITS: Limits = {
  tenantBurstTurns: 8,
  burstWindowMs: 60_000,
  tenantMonthlyTurns: 1500,
  ipTurns: 6,
  ipWindowMs: 60_000,
  loginAttempts: 5,
  maxMessages: 16,
  maxMessageChars: 1000,
  maxReplyChars: 6000,
  maxBodyBytes: 128 * 1024,
  storeTimeoutMs: 2000,
  configCacheSeconds: 60,
  timeZone: 'UTC',
};

/** Content the panel can save. Checked by zod in the panel API and by check constraints in sql/schema.sql. */
export const CONTENT_LIMITS = {
  botName: 60,
  header: 60,
  welcome: 300,
  placeholder: 80,
  suggestedQuestions: 4,
  suggestedQuestionChars: 80,
  tone: 1000,
  context: 20_000,
  faq: 10_000,
} as const;
