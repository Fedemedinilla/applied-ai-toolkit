// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { ActionKey, KEY_PATTERN, newKey, type KeyStorage } from '../src/index.ts';

beforeEach(() => {
  localStorage.clear();
});

describe('newKey', () => {
  it('makes a key the SQL functions accept, with or without randomUUID', () => {
    expect(newKey()).toMatch(KEY_PATTERN);
    const noUuid = { getRandomValues: <T extends ArrayBufferView>(a: T) => crypto.getRandomValues(a as never) as T };
    const hex = newKey(noUuid);
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
    const throwing = {
      ...noUuid,
      randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
        throw new Error('not a secure context');
      },
    };
    expect(newKey(throwing)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('ActionKey', () => {
  it('keeps one key for every send of an action, across a reload', () => {
    const first = new ActionKey({ slot: 'checkout', storage: localStorage });
    const k = first.current();
    expect(first.current()).toBe(k);
    const afterReload = new ActionKey({ slot: 'checkout', storage: localStorage });
    expect(afterReload.current()).toBe(k);
  });

  it('starts a new action after clear()', () => {
    const action = new ActionKey({ slot: 'checkout', storage: localStorage });
    const k = action.current();
    action.clear();
    expect(localStorage.getItem('checkout')).toBeNull();
    expect(action.current()).not.toBe(k);
  });

  it('replaces a key older than its lifetime', () => {
    let now = 1_000_000;
    const action = new ActionKey({ slot: 'checkout', storage: localStorage, lifetimeMs: 1000, now: () => now });
    const k = action.current();
    now += 999;
    expect(action.current()).toBe(k);
    now += 1;
    expect(action.current()).not.toBe(k);
  });

  it('keeps the key in memory when storage throws', () => {
    const blocked: KeyStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const action = new ActionKey({ slot: 'checkout', storage: blocked });
    const k = action.current();
    expect(action.current()).toBe(k);
    expect(() => action.clear()).not.toThrow();
  });

  it('ignores a stored value it did not write', () => {
    for (const junk of ['not json', '{"key":"short","createdAt":1}', '{"key":"aaaaaaaaaaaaaaaaaaaa"}', 'null']) {
      localStorage.setItem('checkout', junk);
      const k = new ActionKey({ slot: 'checkout', storage: localStorage }).current();
      expect(k).toMatch(KEY_PATTERN);
      expect(k).not.toBe('aaaaaaaaaaaaaaaaaaaa');
    }
  });
});
