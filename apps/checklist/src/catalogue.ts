// The catalogue's types and the check that a fetched catalogue.json has that shape.
// data/build-catalogue.ts writes the file from data/source/; the app fetches it at start.
// Browser-safe: no Node built-ins.

export const PLATFORMS = [
  { id: 'wordpress', label: 'WordPress on its own hosting' },
  { id: 'woocommerce', label: 'WooCommerce store' },
  { id: 'joomla-drupal', label: 'Joomla or Drupal' },
  { id: 'hosted', label: 'Hosted builder (Wix, Squarespace, Webflow, Google Sites)' },
  { id: 'hosted-store', label: 'Hosted store (Shopify and similar)' },
  { id: 'static', label: 'Static site on a deploy provider' },
] as const;
export type PlatformId = (typeof PLATFORMS)[number]['id'];

/** Shorthands the source tables use in the Platforms column. */
export const PLATFORM_GROUPS: Readonly<Record<string, readonly PlatformId[]>> = {
  all: PLATFORMS.map((p) => p.id),
  cms: ['wordpress', 'woocommerce', 'joomla-drupal'],
  wp: ['wordpress', 'woocommerce'],
  'hosted-any': ['hosted', 'hosted-store'],
  store: ['woocommerce', 'hosted-store'],
};

export const FEATURES = [
  { id: 'own-mail', label: 'The domain sends and receives its own mail' },
  { id: 'forms', label: 'The site has public forms' },
  { id: 'bilingual', label: 'The site has more than one language' },
  { id: 'hosting-panel', label: 'There is access to a hosting panel (cPanel or similar)' },
  { id: 'elementor', label: 'Built with Elementor' },
  { id: 'avada', label: 'Built with Avada' },
] as const;
export type FeatureId = (typeof FEATURES)[number]['id'];

/** "store" is not a feature the profile ticks: it follows from the platform. */
export type NeedId = FeatureId | 'store';

export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const AREAS = ['security', 'speed', 'visibility'] as const;
export type Area = (typeof AREAS)[number];

export const MODULES = ['EXT', 'VIS', 'INT', 'PLA', 'COM', 'SEG', 'VEL', 'OPE'] as const;
export type Module = (typeof MODULES)[number];

export interface Item {
  readonly id: string;
  readonly module: Module;
  readonly phase: number;
  readonly area: Area;
  readonly title: string;
  readonly question: string;
  readonly where: string;
  readonly pass: string;
  readonly ifFails: string;
  readonly doNotTouch: string | null;
  readonly priority: Priority;
  readonly platforms: readonly PlatformId[];
  readonly needs: readonly FeatureId[];
  readonly access: 'passive' | 'authorized';
}

export interface Phase {
  readonly number: number;
  readonly name: string;
  readonly produces: string;
}

export interface PreChangeRow {
  readonly id: string;
  readonly text: string;
}

export interface MatrixRow {
  readonly id: string;
  readonly what: string;
  readonly how: string;
  readonly pass: string;
  readonly needs: readonly NeedId[];
}

export interface IncidentStep {
  readonly id: string;
  readonly phase: number;
  readonly text: string;
  readonly requires: readonly string[];
}

export interface Catalogue {
  readonly format: 'site-checklist-catalogue';
  readonly version: 1;
  /** First 16 hex digits of a SHA-256 over the content, so a run records what it was filled against. */
  readonly id: string;
  readonly phases: readonly Phase[];
  readonly items: readonly Item[];
  readonly preChange: readonly PreChangeRow[];
  readonly postChange: readonly MatrixRow[];
  readonly incident: {
    readonly phases: readonly { readonly number: number; readonly name: string }[];
    readonly steps: readonly IncidentStep[];
  };
}

const PLATFORM_IDS: readonly string[] = PLATFORMS.map((p) => p.id);
const FEATURE_IDS: readonly string[] = FEATURES.map((f) => f.id);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStringArray = (v: unknown, allowed?: readonly string[]): v is string[] =>
  Array.isArray(v) && v.every((x) => isString(x) && (!allowed || allowed.includes(x)));

function isItem(v: unknown): v is Item {
  if (!isRecord(v)) return false;
  return (
    isString(v.id) &&
    (MODULES as readonly unknown[]).includes(v.module) &&
    Number.isInteger(v.phase) &&
    (AREAS as readonly unknown[]).includes(v.area) &&
    isString(v.title) &&
    isString(v.question) &&
    isString(v.where) &&
    isString(v.pass) &&
    isString(v.ifFails) &&
    (v.doNotTouch === null || isString(v.doNotTouch)) &&
    (PRIORITIES as readonly unknown[]).includes(v.priority) &&
    isStringArray(v.platforms, PLATFORM_IDS) &&
    v.platforms.length > 0 &&
    isStringArray(v.needs, FEATURE_IDS) &&
    (v.access === 'passive' || v.access === 'authorized')
  );
}

/** A hand-written guard: the catalogue is fetched, so it is checked before use. */
export function isCatalogue(v: unknown): v is Catalogue {
  if (!isRecord(v) || v.format !== 'site-checklist-catalogue' || v.version !== 1 || !isString(v.id)) return false;
  const { phases, items, preChange, postChange, incident } = v;
  if (!Array.isArray(phases) || !phases.every((p) => isRecord(p) && Number.isInteger(p.number) && isString(p.name) && isString(p.produces))) return false;
  if (!Array.isArray(items) || items.length === 0 || !items.every(isItem)) return false;
  if (!Array.isArray(preChange) || !preChange.every((r) => isRecord(r) && isString(r.id) && isString(r.text))) return false;
  if (
    !Array.isArray(postChange) ||
    !postChange.every((r) => isRecord(r) && isString(r.id) && isString(r.what) && isString(r.how) && isString(r.pass) && isStringArray(r.needs, [...FEATURE_IDS, 'store']))
  ) {
    return false;
  }
  if (!isRecord(incident) || !Array.isArray(incident.phases) || !Array.isArray(incident.steps)) return false;
  if (!incident.phases.every((p) => isRecord(p) && Number.isInteger(p.number) && isString(p.name))) return false;
  return incident.steps.every((s) => isRecord(s) && isString(s.id) && Number.isInteger(s.phase) && isString(s.text) && isStringArray(s.requires));
}
