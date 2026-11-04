// One suite, two stores: the in-memory one the handlers are tested with, and SqlStore over
// sql/schema.sql in an in-process Postgres (PGlite). If they agree here, the handler tests say
// something about a deploy on Postgres too. The SQL checks are tested at the end.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SqlStore } from '../server/sql-store.ts';
import { MemoryStore, type AccountStore, type TenantStore } from '../server/store.ts';
import { Owner, Plan, TenantConfig } from '../server/tenant.ts';

const SCHEMA = readFileSync(join(import.meta.dirname, '../sql/schema.sql'), 'utf8');
type Store = TenantStore & AccountStore;

const A = { tenantId: 'panaderia-sol', accountId: '11111111-1111-4111-8111-111111111111', email: 'Owner@Panaderia-Sol.example', allowedDomains: ['panaderia-sol.example'] };
const B = { tenantId: 'taller-rueda', accountId: '22222222-2222-4222-8222-222222222222', email: 'owner@taller-rueda.example', allowedDomains: ['taller-rueda.example'] };
const T0 = new Date('2026-11-04T12:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const SESSION = '33333333-3333-4333-8333-333333333333';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** One database per suite; booting PGlite takes about a second, so tests share it and truncate. */
let shared: Promise<PGlite> | null = null;
async function openPg(): Promise<PGlite> {
  shared ??= PGlite.create().then(async (db) => {
    await db.exec(SCHEMA);
    return db;
  });
  const db = await shared;
  await db.exec('truncate widget_turns, widget_owners, widget_tenants cascade');
  return db;
}

function contract(name: string, make: () => Promise<Store>): void {
  describe(name, () => {
    let store: Store;
    beforeEach(async () => {
      store = await make();
      expect(await store.createTenant(A)).toBe('created');
      expect(await store.createTenant(B)).toBe('created');
    });

    it('creates a tenant with a config row that parses, and refuses a taken id or email', async () => {
      const config = TenantConfig.parse(await store.getConfig(A.tenantId));
      expect(config).toMatchObject({ tenantId: A.tenantId, accountId: A.accountId, allowedDomains: A.allowedDomains, tonePreset: 'friendly', context: '' });
      expect(Plan.parse(await store.getPlan(A.tenantId))).toEqual({ status: 'active', monthlyTurns: null });
      expect(await store.createTenant({ ...A, email: 'other@x.example' })).toBe('exists');
      expect(await store.createTenant({ ...A, tenantId: 'otro-negocio', accountId: '44444444-4444-4444-8444-444444444444', email: 'owner@panaderia-sol.example' })).toBe('exists');
      expect(await store.getConfig('otro-negocio')).toBeNull();
      expect(await store.getPlan('otro-negocio')).toBeNull();
    });

    it('counts turns per tenant, from `since` inclusive, in every state', async () => {
      await store.reserveTurn({ id: id(1), tenantId: A.tenantId, sessionId: SESSION, at: at(0) });
      await store.reserveTurn({ id: id(2), tenantId: A.tenantId, sessionId: SESSION, at: at(1000) });
      await store.reserveTurn({ id: id(3), tenantId: A.tenantId, sessionId: SESSION, at: at(2000) });
      await store.reserveTurn({ id: id(4), tenantId: B.tenantId, sessionId: SESSION, at: at(2000) });
      await store.finishTurn(id(2), { status: 'answered', model: 'claude-sonnet-5-5', inputTokens: 1200, outputTokens: 80, costUsd: 0.0032 });
      await store.finishTurn(id(3), { status: 'failed', errorCode: 'overloaded' });
      expect(await store.countTurnsSince(A.tenantId, at(0))).toBe(3);
      expect(await store.countTurnsSince(A.tenantId, at(1000))).toBe(2);
      expect(await store.countTurnsSince(A.tenantId, at(2001))).toBe(0);
      expect(await store.countTurnsSince(B.tenantId, at(0))).toBe(1);
      expect(await store.countTurnsSince('no-such-shop', at(0))).toBe(0);
    });

    it('reserves idempotently, closes once, and drops only reserved turns', async () => {
      const turn = { id: id(1), tenantId: A.tenantId, sessionId: SESSION, at: at(0) };
      await store.reserveTurn(turn);
      await store.reserveTurn(turn);
      expect(await store.countTurnsSince(A.tenantId, at(0))).toBe(1);
      await store.finishTurn(id(1), { status: 'answered', model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5, costUsd: null });
      await store.finishTurn(id(1), { status: 'failed', errorCode: 'late' });
      await store.dropTurn(id(1));
      expect(await store.countTurnsSince(A.tenantId, at(0))).toBe(1);
      await store.reserveTurn({ ...turn, id: id(2) });
      await store.dropTurn(id(2));
      expect(await store.countTurnsSince(A.tenantId, at(0))).toBe(1);
    });

    it('refuses a turn for a tenant that does not exist', async () => {
      await expect(store.reserveTurn({ id: id(9), tenantId: 'no-such-shop', sessionId: SESSION, at: at(0) })).rejects.toThrow();
    });

    it('finds owners by lowercased email and uses an invite nonce once', async () => {
      const owner = Owner.parse(await store.ownerByEmail('OWNER@panaderia-sol.EXAMPLE'));
      expect(owner).toEqual({ tenantId: A.tenantId, email: 'owner@panaderia-sol.example', passwordHash: null, inviteNonce: null });
      expect(await store.acceptInvite(A.tenantId, 'any', 'scrypt$x')).toBe(false);
      await store.setInviteNonce(A.tenantId, 'n1');
      await store.setInviteNonce(A.tenantId, 'n2');
      expect(await store.acceptInvite(A.tenantId, 'n1', 'scrypt$first')).toBe(false);
      expect(await store.acceptInvite(B.tenantId, 'n2', 'scrypt$first')).toBe(false);
      expect(await store.acceptInvite(A.tenantId, 'n2', 'scrypt$first')).toBe(true);
      expect(await store.acceptInvite(A.tenantId, 'n2', 'scrypt$second')).toBe(false);
      expect(Owner.parse(await store.ownerOf(A.tenantId))).toMatchObject({ passwordHash: 'scrypt$first', inviteNonce: null });
      expect(await store.ownerByEmail('nobody@x.example')).toBeNull();
    });

    it('replaces a password hash only if it is still the one read', async () => {
      await store.setInviteNonce(A.tenantId, 'n');
      await store.acceptInvite(A.tenantId, 'n', 'scrypt$old');
      expect(await store.replacePasswordHash(A.tenantId, 'scrypt$stale', 'scrypt$new')).toBe(false);
      expect(await store.replacePasswordHash(A.tenantId, 'scrypt$old', 'scrypt$new')).toBe(true);
      expect(Owner.parse(await store.ownerOf(A.tenantId)).passwordHash).toBe('scrypt$new');
    });

    it('saves content into one tenant row only', async () => {
      await store.saveContent(A.tenantId, { context: 'Abrimos a las 7.', suggestedQuestions: ['¿Abren hoy?'], tonePreset: 'direct' });
      expect(TenantConfig.parse(await store.getConfig(A.tenantId))).toMatchObject({ context: 'Abrimos a las 7.', suggestedQuestions: ['¿Abren hoy?'], tonePreset: 'direct' });
      expect(TenantConfig.parse(await store.getConfig(B.tenantId))).toMatchObject({ context: '', suggestedQuestions: [], tonePreset: 'friendly' });
      await expect(store.saveContent('no-such-shop', { context: 'x' })).rejects.toThrow();
    });
  });
}

contract('MemoryStore', async () => new MemoryStore());
contract('SqlStore on PGlite', async () => new SqlStore(await openPg()));
beforeAll(async () => {
  await openPg();
}, 30_000);

describe('sql/schema.sql checks', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await openPg();
    await new SqlStore(db).createTenant(A);
  });

  const rejects = async (sql: string, constraint: string): Promise<void> => {
    await expect(db.query(sql)).rejects.toThrow(constraint);
  };

  it('keeps CSS out of the two values the widget paints with', async () => {
    await rejects(`update widget_tenants set primary_color = 'red;}' where tenant_id = 'panaderia-sol'`, 'widget_tenants_primary_color');
    await rejects(`update widget_tenants set font = 'Inter;}*{x:y' where tenant_id = 'panaderia-sol'`, 'widget_tenants_font');
    await db.query(`update widget_tenants set primary_color = '#AA5500' where tenant_id = 'panaderia-sol'`);
  });

  it('enforces the content limits and the closed lists', async () => {
    await rejects(`update widget_tenants set context = repeat('x', 20001) where tenant_id = 'panaderia-sol'`, 'widget_tenants_context');
    await rejects(`update widget_tenants set suggested_questions = array['a','b','c','d','e'] where tenant_id = 'panaderia-sol'`, 'widget_tenants_suggested_questions');
    await rejects(`update widget_tenants set tone_preset = 'pirate' where tenant_id = 'panaderia-sol'`, 'widget_tenants_tone_preset');
    await rejects(`update widget_tenants set plan_status = 'free' where tenant_id = 'panaderia-sol'`, 'widget_tenants_plan_status');
    await rejects(`insert into widget_tenants (tenant_id, account_id) values ('Bad Id', gen_random_uuid())`, 'widget_tenants_tenant_id_format');
  });

  it('keeps each turn state consistent', async () => {
    const insert = (extra: string): string =>
      `insert into widget_turns (id, tenant_id, session_id, created_at, status${extra.split('|')[0]}) values (gen_random_uuid(), 'panaderia-sol', '${SESSION}', now(), ${extra.split('|')[1]})`;
    await rejects(insert('|\'failed\''), 'widget_turns_shape');
    await rejects(insert(', model|\'reserved\', \'claude-sonnet-5-5\''), 'widget_turns_shape');
    await rejects(insert(', model, input_tokens, output_tokens|\'answered\', \'m\', -1, 0'), 'widget_turns_shape');
    await db.query(insert(', model, input_tokens, output_tokens, cost_usd|\'answered\', \'m\', 1, 1, null'));
  });

  it('stores emails lowercase and unique', async () => {
    await rejects(`update widget_owners set email = 'Owner@x.example'`, 'widget_owners_email');
    await db.query(`insert into widget_tenants (tenant_id, account_id) values ('taller-rueda', gen_random_uuid())`);
    await rejects(`insert into widget_owners (tenant_id, email) values ('taller-rueda', 'owner@panaderia-sol.example')`, 'widget_owners_email_key');
  });
});
