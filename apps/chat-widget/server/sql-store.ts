// TenantStore and AccountStore over Postgres (sql/schema.sql). It takes a `query` function rather
// than a driver, so it carries no dependency: node-postgres's Pool.query and PGlite's query both fit.
// Every statement filters on the tenant id or the turn id, and each write is a single statement,
// so it is atomic without a transaction.

import type { AccountStore, NewTenant, TenantStore, TurnOutcome, TurnReservation } from './store.ts';
import type { ContentPatch } from './tenant.ts';

export interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

const CONFIG_COLUMNS = `tenant_id as "tenantId", account_id as "accountId", bot_name as "botName", header, welcome, placeholder,
  primary_color as "primaryColor", font, suggested_questions as "suggestedQuestions", tone_preset as "tonePreset", tone, context, faq,
  allowed_domains as "allowedDomains"`;

const OWNER_COLUMNS = `tenant_id as "tenantId", email, password_hash as "passwordHash", invite_nonce as "inviteNonce"`;

/** The panel's fields and their columns. Only names from this map reach the SQL text. */
const CONTENT_COLUMNS: Readonly<Record<keyof ContentPatch, string>> = {
  botName: 'bot_name',
  welcome: 'welcome',
  suggestedQuestions: 'suggested_questions',
  tonePreset: 'tone_preset',
  tone: 'tone',
  context: 'context',
  faq: 'faq',
};

const first = (rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> | null => rows[0] ?? null;

export class SqlStore implements TenantStore, AccountStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
  }

  async getConfig(tenantId: string): Promise<unknown> {
    const { rows } = await this.#sql.query(`select ${CONFIG_COLUMNS} from widget_tenants where tenant_id = $1`, [tenantId]);
    return first(rows);
  }

  async getPlan(tenantId: string): Promise<unknown> {
    const { rows } = await this.#sql.query(`select plan_status as status, monthly_turns as "monthlyTurns" from widget_tenants where tenant_id = $1`, [tenantId]);
    return first(rows);
  }

  async countTurnsSince(tenantId: string, since: Date): Promise<unknown> {
    const { rows } = await this.#sql.query(`select count(*)::integer as n from widget_turns where tenant_id = $1 and created_at >= $2`, [tenantId, since.toISOString()]);
    // Returned as read; the handler rejects anything that is not a non-negative integer.
    return first(rows)?.['n'] ?? null;
  }

  async reserveTurn(turn: TurnReservation): Promise<void> {
    await this.#sql.query(
      `insert into widget_turns (id, tenant_id, session_id, created_at) values ($1, $2, $3, $4) on conflict (id) do nothing`,
      [turn.id, turn.tenantId, turn.sessionId, turn.at.toISOString()],
    );
  }

  async finishTurn(id: string, outcome: TurnOutcome): Promise<void> {
    if (outcome.status === 'answered') {
      await this.#sql.query(
        `update widget_turns set status = 'answered', model = $2, input_tokens = $3, output_tokens = $4, cost_usd = $5 where id = $1 and status = 'reserved'`,
        [id, outcome.model, outcome.inputTokens, outcome.outputTokens, outcome.costUsd],
      );
    } else {
      await this.#sql.query(`update widget_turns set status = 'failed', error_code = $2 where id = $1 and status = 'reserved'`, [id, outcome.errorCode]);
    }
  }

  async dropTurn(id: string): Promise<void> {
    await this.#sql.query(`delete from widget_turns where id = $1 and status = 'reserved'`, [id]);
  }

  async ownerByEmail(email: string): Promise<unknown> {
    const { rows } = await this.#sql.query(`select ${OWNER_COLUMNS} from widget_owners where email = $1`, [email.toLowerCase()]);
    return first(rows);
  }

  async ownerOf(tenantId: string): Promise<unknown> {
    const { rows } = await this.#sql.query(`select ${OWNER_COLUMNS} from widget_owners where tenant_id = $1`, [tenantId]);
    return first(rows);
  }

  async createTenant(tenant: NewTenant): Promise<'created' | 'exists'> {
    // One statement: the tenant is inserted only if the email is free, and the owner with it.
    // A concurrent insert of the same email fails the whole statement on the unique index.
    const { rows } = await this.#sql.query(
      `with t as (
         insert into widget_tenants (tenant_id, account_id, allowed_domains)
         select $1, $2, $3 where not exists (select 1 from widget_owners where email = $4)
         on conflict (tenant_id) do nothing
         returning tenant_id
       )
       insert into widget_owners (tenant_id, email) select tenant_id, $4 from t returning tenant_id`,
      [tenant.tenantId, tenant.accountId, [...tenant.allowedDomains], tenant.email.toLowerCase()],
    );
    return rows.length === 1 ? 'created' : 'exists';
  }

  async setInviteNonce(tenantId: string, nonce: string): Promise<void> {
    await this.#sql.query(`update widget_owners set invite_nonce = $2 where tenant_id = $1`, [tenantId, nonce]);
  }

  async acceptInvite(tenantId: string, nonce: string, passwordHash: string): Promise<boolean> {
    const { rows } = await this.#sql.query(
      `update widget_owners set password_hash = $3, invite_nonce = null where tenant_id = $1 and invite_nonce = $2 returning tenant_id`,
      [tenantId, nonce, passwordHash],
    );
    return rows.length === 1;
  }

  async replacePasswordHash(tenantId: string, previous: string, next: string): Promise<boolean> {
    const { rows } = await this.#sql.query(
      `update widget_owners set password_hash = $3 where tenant_id = $1 and password_hash = $2 returning tenant_id`,
      [tenantId, previous, next],
    );
    return rows.length === 1;
  }

  async saveContent(tenantId: string, patch: ContentPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId];
    for (const [key, column] of Object.entries(CONTENT_COLUMNS) as Array<[keyof ContentPatch, string]>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(Array.isArray(value) ? [...value] : value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) return;
    const { rows } = await this.#sql.query(`update widget_tenants set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 returning tenant_id`, params);
    if (rows.length !== 1) throw new Error('no such tenant');
  }
}
