// The channel guides: one per channel, language and register, saying who reads, in what shape the
// message reaches them and how it sounds (a canonical sample), instead of a list of things to avoid.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_GENRES, Channel, LANGS, channelFor, validateRefs, type RefsData } from '../src/index.ts';

const FOLDER = join(import.meta.dirname, '..');
const json = (file: string): unknown => JSON.parse(readFileSync(join(FOLDER, file), 'utf8'));
const onDisk = (): Record<string, unknown> =>
  existsSync(join(FOLDER, 'channels'))
    ? Object.fromEntries(
        readdirSync(join(FOLDER, 'channels'))
          .filter((f) => f.endsWith('.json'))
          .map((f) => [`channels/${f}`, json(`channels/${f}`)]),
      )
    : {};

const empty: RefsData = { sources: [], principles: {}, excerpts: {}, examples: {} };
const channel = {
  id: 'en-email-neutral',
  genre: 'email',
  lang: 'en',
  register: 'neutral',
  persona: 'You write as a professional talking to a peer: direct, warm and brief.',
  reader: 'A busy person reads it on a phone between two other things and decides in a few seconds whether to answer.',
  shape: { words: { min: 60, max: 160 }, paragraphs: { max: 4, maxSentences: 3 }, opening: 'The first sentence says why you write to this reader.', closing: 'End on one easy next step.' },
  canonical: 'I saw you are hiring for support. I have done that job for three years, and the part I like is making the queue smaller. If that is useful, I can tell you how.',
  fictional: true,
};
const messages = (d: RefsData): string[] => validateRefs(d).map((p) => `${p.file} ${p.path}: ${p.message}`);

describe('the channel guides on disk', () => {
  const files = onDisk();
  const channels = Object.values(files).flatMap((v) => (v as unknown[]).map((c) => Channel.parse(c)));

  it('pass the validator', () => {
    expect(messages({ ...empty, channels: files })).toEqual([]);
  });

  it('cover email, follow-up and WhatsApp in both languages, and the Spanish ones in rioplatense', () => {
    expect(Object.keys(files).sort()).toEqual(['channels/en.json', 'channels/es.json']);
    for (const lang of LANGS) {
      for (const genre of CHANNEL_GENRES) {
        expect(channels.filter((c) => c.lang === lang && c.genre === genre).length, `${genre} ${lang}`).toBeGreaterThanOrEqual(1);
      }
    }
    for (const c of channels.filter((x) => x.lang === 'es')) expect(c.variety, c.id).toBe('rioplatense');
  });

  it('keep a WhatsApp message shorter than an email', () => {
    for (const lang of LANGS) {
      const chat = channels.find((c) => c.lang === lang && c.genre === 'whatsapp');
      const mail = channels.find((c) => c.lang === lang && c.genre === 'email');
      expect(chat?.shape.words.max ?? Infinity, lang).toBeLessThan(mail?.shape.words.max ?? 0);
    }
  });
});

describe('validateRefs on channels', () => {
  it('accepts a guide in the file of its language', () => {
    expect(messages({ ...empty, channels: { 'channels/en.json': [channel] } })).toEqual([]);
  });

  it('refuses a guide that is not fictional, sits in the wrong file or names no variety in Spanish', () => {
    expect(messages({ ...empty, channels: { 'channels/en.json': [{ ...channel, fictional: false }] } })).toHaveLength(1);
    expect(messages({ ...empty, channels: { 'channels/es.json': [channel] } })).toEqual(['channels/es.json 0.lang: lang en in the es file']);
    expect(messages({ ...empty, channels: { 'channels/es.json': [{ ...channel, id: 'es-email-neutral', lang: 'es' }] } })).toEqual([
      'channels/es.json 0.variety: a Spanish channel guide names its variety, so the treatment it shows is the one asked for',
    ]);
  });

  it('wants the persona in one sentence, a word range that holds, and a canonical sample of two to five sentences', () => {
    const bad = { ...channel, persona: 'You are direct. You are warm.', shape: { ...channel.shape, words: { min: 200, max: 100 } }, canonical: 'Too short.' };
    expect(messages({ ...empty, channels: { 'channels/en.json': [bad] } })).toEqual([
      'channels/en.json 0.persona: 2 sentences; a persona is one sentence',
      'channels/en.json 0.shape.words: min 200 is above max 100',
      'channels/en.json 0.canonical: 1 sentences; a canonical sample has 2 to 5',
    ]);
  });

  it('refuses two guides for the same channel, language, register and variety, and a file outside channels/', () => {
    expect(messages({ ...empty, channels: { 'channels/en.json': [channel, { ...channel, id: 'en-email-again' }] } })).toEqual([
      'channels/en.json 1.id: en-email-again is a second guide for email, en, neutral',
    ]);
    expect(messages({ ...empty, channels: { 'channels/pt.json': [] } }).map((m) => m.split(':')[0])).toEqual(['channels/pt.json ']);
  });
});

describe('channelFor', () => {
  const es = { ...channel, id: 'es-whatsapp-casual', genre: 'whatsapp', lang: 'es', variety: 'rioplatense', register: 'casual' } as const;
  const all = [Channel.parse(channel), Channel.parse(es)];

  it('finds the guide of a text by channel, language, register and variety', () => {
    expect(channelFor(all, { genre: 'email', lang: 'en', register: 'neutral' })?.id).toBe('en-email-neutral');
    expect(channelFor(all, { genre: 'whatsapp', lang: 'es', register: 'casual', variety: 'rioplatense' })?.id).toBe('es-whatsapp-casual');
  });

  it('returns nothing rather than a guide of another variety or register', () => {
    expect(channelFor(all, { genre: 'whatsapp', lang: 'es', register: 'casual', variety: 'neutral' })).toBeUndefined();
    expect(channelFor(all, { genre: 'whatsapp', lang: 'es', register: 'casual' })).toBeUndefined();
    expect(channelFor(all, { genre: 'email', lang: 'en', register: 'formal' })).toBeUndefined();
  });
});
