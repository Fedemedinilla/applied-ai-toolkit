/**
 * The fictional salon behind the assistant. One source of truth: the context the model reads is
 * built from the same tables decide() and the money guard check against, so the two cannot drift.
 * The context holds no fact the code cannot back up; a price that varies by hair length, a deposit
 * or a conditional discount were left out instead of half-modelled.
 */
import { joinEn, parity, pesosEn, pesosEs, time12, type Lang } from './lang.ts';

export const SALON = {
  name: 'Peluquería Los Pelados',
  area: 'Villa Crespo, CABA',
  since: 2014,
  /** Where the assistant sends people for facts it does not have. Plain text, never a link. */
  site: 'peluqueria-los-pelados.example',
} as const;

export const toMin = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const toHHMM = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;
export const DAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const dayEs = (d: number): string => DAY_NAMES[d] ?? '';
const dayEn = (d: number): string => DAY_NAMES_EN[d] ?? '';

export interface DayHours {
  readonly day: number;
  readonly from: string;
  readonly to: string;
}

/** A weekday missing from the table is a closed day. */
export const SALON_HOURS: readonly DayHours[] = [
  { day: 2, from: '09:00', to: '20:00' },
  { day: 3, from: '09:00', to: '20:00' },
  { day: 4, from: '09:00', to: '20:00' },
  { day: 5, from: '09:00', to: '20:00' },
  { day: 6, from: '09:00', to: '18:00' },
];
const CLOSED_DAY_NUMBERS = [1, 0];

export const hoursOn = (weekday: number): DayHours | null => SALON_HOURS.find((h) => h.day === weekday) ?? null;

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly minutes: number;
  /** Every skill here has to be on the same person. */
  readonly needs: readonly string[];
  readonly group: 'Barbería y hombre' | 'Mujer, color y peinado' | 'Combos';
}

/** In words: with "(up to age 12)" right before a price the model mixed the two numbers up more often. */
const KID_MAX_AGE = { es: 'doce', en: 'twelve' };

export const SALON_SERVICES: readonly Service[] = [
  { id: 'corte-hombre', name: 'Corte de hombre (máquina y tijera)', price: 16_000, minutes: 30, needs: ['corte-hombre'], group: 'Barbería y hombre' },
  { id: 'corte-ras', name: 'Corte al ras, una sola guía', price: 11_000, minutes: 20, needs: ['corte-hombre'], group: 'Barbería y hombre' },
  { id: 'barba', name: 'Perfilado de barba', price: 9_000, minutes: 20, needs: ['barba'], group: 'Barbería y hombre' },
  { id: 'barba-toalla', name: 'Barba completa con toalla caliente', price: 12_000, minutes: 30, needs: ['barba'], group: 'Barbería y hombre' },
  { id: 'navaja', name: 'Afeitado completo a navaja', price: 13_000, minutes: 30, needs: ['navaja'], group: 'Barbería y hombre' },
  { id: 'corte-nene', name: `Corte de nene (hasta ${KID_MAX_AGE.es} años)`, price: 12_000, minutes: 30, needs: ['corte-nene'], group: 'Barbería y hombre' },
  { id: 'trenzas', name: 'Trenzas o peinado de nena', price: 14_000, minutes: 30, needs: ['peinado-nena'], group: 'Barbería y hombre' },
  { id: 'cejas', name: 'Perfilado de cejas con navaja', price: 5_000, minutes: 10, needs: ['cejas'], group: 'Barbería y hombre' },
  { id: 'corte-mujer', name: 'Corte de mujer (lavado, corte y secado)', price: 24_000, minutes: 60, needs: ['corte-mujer'], group: 'Mujer, color y peinado' },
  { id: 'brushing', name: 'Lavado y brushing', price: 15_000, minutes: 40, needs: ['brushing'], group: 'Mujer, color y peinado' },
  { id: 'color-raiz', name: 'Color de raíz, un solo tono', price: 38_000, minutes: 90, needs: ['color'], group: 'Mujer, color y peinado' },
  { id: 'color-full', name: 'Color completo', price: 52_000, minutes: 120, needs: ['color'], group: 'Mujer, color y peinado' },
  { id: 'matizado', name: 'Matizado (nutrición y tono)', price: 18_000, minutes: 30, needs: ['color'], group: 'Mujer, color y peinado' },
  { id: 'mechas', name: 'Mechas o babylights, medio casco', price: 65_000, minutes: 150, needs: ['color'], group: 'Mujer, color y peinado' },
  { id: 'balayage', name: 'Balayage', price: 78_000, minutes: 180, needs: ['color'], group: 'Mujer, color y peinado' },
  { id: 'alisado', name: 'Alisado sin formol', price: 70_000, minutes: 150, needs: ['color'], group: 'Mujer, color y peinado' },
  { id: 'peinado', name: 'Peinado de evento o recogido', price: 30_000, minutes: 60, needs: ['peinado'], group: 'Mujer, color y peinado' },
  { id: 'combo-barba', name: 'Corte + barba', price: 23_000, minutes: 50, needs: ['corte-hombre', 'barba'], group: 'Combos' },
  { id: 'combo-padre', name: 'Papá e hijo', price: 25_000, minutes: 60, needs: ['corte-hombre', 'corte-nene'], group: 'Combos' },
];

export const SERVICE_GROUPS = [...new Set(SALON_SERVICES.map((s) => s.group))];

/** Every amount the assistant may say, as bare digits, so "$16.000" and "$16,000" are one number. */
export const ALLOWED_MONEY: ReadonlySet<number> = new Set(SALON_SERVICES.map((s) => s.price));

export interface Shift {
  readonly day: number;
  readonly from: string;
  readonly to: string;
}

export interface Stylist {
  readonly name: string;
  readonly role: string;
  readonly skills: readonly string[];
  readonly shifts: readonly Shift[];
}

export const SALON_STAFF: readonly Stylist[] = [
  {
    name: 'Rubén',
    role: 'dueño · corte clásico, barba y navaja',
    skills: ['corte-hombre', 'barba', 'navaja', 'corte-nene', 'cejas'],
    shifts: [2, 3, 4, 5, 6].map((day) => ({ day, from: '09:00', to: '15:00' })),
  },
  {
    name: 'Damián',
    role: 'degradé, fade y diseños con máquina',
    skills: ['corte-hombre', 'barba', 'navaja', 'cejas'],
    shifts: [...[2, 3, 4, 5].map((day) => ({ day, from: '13:00', to: '20:00' })), { day: 6, from: '09:00', to: '18:00' }],
  },
  {
    name: 'Carla',
    role: 'color, mechas y corte de mujer',
    skills: ['corte-mujer', 'brushing', 'color', 'peinado'],
    shifts: [...[3, 4, 5].map((day) => ({ day, from: '10:00', to: '19:00' })), { day: 6, from: '09:00', to: '15:00' }],
  },
  {
    name: 'Vanina',
    role: 'chicos, trenzas y brushing',
    skills: ['corte-nene', 'peinado-nena', 'brushing'],
    shifts: [{ day: 6, from: '09:00', to: '18:00' }],
  },
];

export const shiftOn = (s: Stylist, weekday: number): Shift | null => s.shifts.find((x) => x.day === weekday) ?? null;
export const canDo = (s: Stylist, service: Service): boolean => service.needs.every((k) => s.skills.includes(k));

/**
 * The closing-time rule: a booking exists only if the whole service finishes before the salon
 * closes and before that person leaves. An earlier draft of the source accepted 150 minutes of
 * highlights starting when the colourist had less than that left: the model reasoned about the
 * start and forgot the duration.
 */
export function fits(stylist: Stylist, service: Service, weekday: number, time: string): boolean {
  const day = hoursOn(weekday);
  const shift = shiftOn(stylist, weekday);
  if (!day || !shift) return false;
  const start = toMin(time);
  const opens = Math.max(toMin(day.from), toMin(shift.from));
  const closes = Math.min(toMin(day.to), toMin(shift.to));
  return start >= opens && start + service.minutes <= closes;
}

/* ── Matching names the model writes ── */

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[‘’ʼ`]/g, "'");
}

const SERVICE_NAMES_EN: Readonly<Record<string, string>> = {
  'corte-hombre': "Men's cut (clippers and scissors)",
  'corte-ras': 'Buzz cut, single guard',
  barba: 'Beard trim',
  'barba-toalla': 'Full beard with hot towel',
  navaja: 'Full straight-razor shave',
  'corte-nene': `Boy's cut (up to age ${KID_MAX_AGE.en})`,
  trenzas: "Braids or girl's hairstyle",
  cejas: 'Eyebrow shaping with a razor',
  'corte-mujer': "Women's cut (wash, cut and blow-dry)",
  brushing: 'Wash and blow-dry',
  'color-raiz': 'Root color, single shade',
  'color-full': 'Full color',
  matizado: 'Toning treatment (conditioning and tone)',
  mechas: 'Highlights or babylights, half head',
  balayage: 'Balayage',
  alisado: 'Formaldehyde-free straightening',
  peinado: 'Event styling or updo',
  'combo-barba': 'Cut + beard',
  'combo-padre': 'Father and son',
};
parity('SERVICE_NAMES_EN', SALON_SERVICES.map((s) => s.id), SERVICE_NAMES_EN);

export const serviceName = (s: Service, lang: Lang = 'es'): string => (lang === 'en' ? (SERVICE_NAMES_EN[s.id] ?? s.name) : s.name);

/** Four characters: the shortest real fragment anyone types is "nene", and "de" matched everything. */
const LOOSE_MIN = 4;
/** Three in English: "cut" has to come back as the five-row question, not as "not loaded". */
const EN_LOOSE_MIN = 3;

/** Inclusion that starts at a word, so "men's cut" is not also "women's cut". */
function startsAWord(haystack: string, needle: string): boolean {
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (i === 0 || !/[a-z0-9]/.test(haystack[i - 1] ?? '')) return true;
  }
  return false;
}

/**
 * Every row the fragment could mean; empty when it means none. Exact name or id first. The loose
 * match used to answer anything: in the source, findService(''), ('a') and ('de') all came back
 * as the men's cut at $16.000, the first row containing that letter. An empty `service` is what a
 * stalled model emits, so nothing under the minimum matches by inclusion, and a fragment that
 * fits several rows is a question.
 */
export function findServices(name: string, lang: Lang = 'es'): Service[] {
  const n = normalize(name);
  if (!n) return [];
  if (lang === 'en') {
    const exact = SALON_SERVICES.find((s) => normalize(serviceName(s, 'en')) === n || s.id === n || normalize(s.name) === n);
    if (exact) return [exact];
    if (n.length < EN_LOOSE_MIN) return [];
    return SALON_SERVICES.filter((s) => {
      const en = normalize(serviceName(s, 'en'));
      return startsAWord(en, n) || startsAWord(n, en);
    });
  }
  const exact = SALON_SERVICES.find((s) => normalize(s.name) === n || s.id === n);
  if (exact) return [exact];
  if (n.length < LOOSE_MIN) return [];
  return SALON_SERVICES.filter((s) => normalize(s.name).includes(n) || n.includes(normalize(s.name)));
}

export function findService(name: string, lang: Lang = 'es'): Service | null {
  const found = findServices(name, lang);
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** Three letters tell the four names apart; a blank used to match Rubén by prefix. */
const STAFF_LOOSE_MIN = 3;

export function findStaff(name: string): Stylist | null {
  const n = normalize(name);
  if (!n) return null;
  const exact = SALON_STAFF.find((s) => normalize(s.name) === n);
  if (exact) return exact;
  if (n.length < STAFF_LOOSE_MIN) return null;
  return SALON_STAFF.find((s) => normalize(s.name).startsWith(n) || n.startsWith(normalize(s.name))) ?? null;
}

/* ── How a reply names each row in running prose, both languages, over folded text ──
   Only words that point at one row: "barba" alone could be three rows and is not here. A row
   nobody names with these words is simply not counted as named, which makes the guard stricter. */
const SERVICE_MENTIONS: Readonly<Record<string, readonly string[]>> = {
  'corte-hombre': ['cortes? de hombres?', "men'?s'? (hair)?cuts?", 'haircuts? for men'],
  'corte-ras': ['cortes? al ras', 'buzz ?cuts?'],
  barba: ['perfilados? de barbas?', 'beard trims?'],
  'barba-toalla': ['barbas? completas?( con toallas?( calientes?)?)?', 'barbas? con toallas?', 'toallas? calientes?', 'full beards?', 'hot[- ]towel'],
  navaja: ['afeitados?( completos?)?( (a|con) navajas?)?', '(straight[- ])?razor shaves?', 'full shaves?'],
  'corte-nene': ['cortes? del? nenes?', "boy'?s'? (hair)?cuts?"],
  trenzas: ['trenzas?', 'peinados? de nenas?', 'braids?', "girl'?s'? (hair)?styles?"],
  cejas: ['(perfilados? de )?cejas', '(eye)?brows?( shaping)?'],
  'corte-mujer': ['cortes? de mujer(es)?', "wom[ae]n'?s'? (hair)?cuts?"],
  // Not "blowout": a Brazilian blowout is a straightening.
  brushing: ['brushings?', 'blow[- ]?dr(y|ies|ying)'],
  'color-raiz': ['(colou?r(es)? de )?raiz', 'root colou?rs?', 'root touch-?ups?'],
  'color-full': ['colou?r(es)? completos?', 'full colou?rs?'],
  matizado: ['matizados?', 'toning( treatments?)?', 'toners?'],
  mechas: ['mechas', 'babylights?', 'highlights?'],
  balayage: ['balayages?'],
  alisado: ['alisados?', 'straightening'],
  peinado: ['peinados? de eventos?', 'recogidos?', 'event styling', 'updos?'],
  // "Corte y barba con toalla" is a cut and the hot-towel beard, not the combo.
  'combo-barba': ['cortes? ?(\\+|y|con|mas) ?barbas?(?! (con toalla|completa))', 'cuts? ?(\\+|and|with|&) ?beards?(?! with hot)'],
  'combo-padre': ['(papas?|padres?) (e|y) hijos?', '(father|dad)[- /]?(and |& )?sons?'],
};
parity('SERVICE_MENTIONS', SALON_SERVICES.map((s) => s.id), SERVICE_MENTIONS);

/** One character in, one character out, so an index into the folded text is an index into the reply. */
export function foldKeepingLength(s: string): string {
  return s
    .split('')
    .map((c) => {
      const base = c.normalize('NFD').charAt(0).toLowerCase().charAt(0) || c;
      return /[‘’ʼ`]/.test(base) ? "'" : base;
    })
    .join('');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MENTION_RES = SALON_SERVICES.flatMap((s) =>
  [escapeRe(foldKeepingLength(s.name)), escapeRe(foldKeepingLength(serviceName(s, 'en'))), ...(SERVICE_MENTIONS[s.id] ?? [])].map((src) => ({
    service: s,
    re: new RegExp(`(?<![a-z])(?:${src})(?![a-z])`, 'g'),
  })),
);

export interface Mention {
  readonly service: Service;
  readonly start: number;
  readonly end: number;
}

/** Every row the text names, in order, without overlaps (the longest match wins). */
export function servicesNamedIn(text: string): Mention[] {
  const folded = foldKeepingLength(text);
  const all: Mention[] = [];
  for (const { service, re } of MENTION_RES) {
    for (const m of folded.matchAll(re)) all.push({ service, start: m.index, end: m.index + m[0].length });
  }
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Mention[] = [];
  let until = -1;
  for (const m of all) {
    if (m.start < until) continue;
    kept.push(m);
    until = m.end;
  }
  return kept;
}

/* ── Words for the replies decide() writes ── */

export const dayPlural = (weekday: number): string => {
  const n = dayEs(weekday);
  return n === 'sábado' || n === 'domingo' ? `${n}s` : n;
};
export const dayPluralEn = (weekday: number): string => `${dayEn(weekday)}s`;

/* ── The context the model reads, built from the tables above ── */

const ROLES_EN: Readonly<Record<string, string>> = {
  Rubén: 'owner · classic cuts, beards and razor shaves',
  Damián: 'fades and clipper designs',
  Carla: "color, highlights and women's cuts",
  Vanina: 'kids, braids and blow-dries',
};
parity('ROLES_EN', SALON_STAFF.map((s) => s.name), ROLES_EN);

const GROUPS_EN: Readonly<Record<string, string>> = {
  'Barbería y hombre': "Barbering and men's cuts",
  'Mujer, color y peinado': "Women's cuts, color and styling",
  Combos: 'Combos',
};
parity('GROUPS_EN', SERVICE_GROUPS, GROUPS_EN);

/** Runs of consecutive days with the same hours. */
function shiftRuns(s: Stylist): Array<{ from: string; to: string; days: number[] }> {
  const runs: Array<{ from: string; to: string; days: number[] }> = [];
  for (const sh of [...s.shifts].sort((a, b) => a.day - b.day)) {
    const last = runs[runs.length - 1];
    if (last && last.from === sh.from && last.to === sh.to && last.days[last.days.length - 1] === sh.day - 1) last.days.push(sh.day);
    else runs.push({ from: sh.from, to: sh.to, days: [sh.day] });
  }
  return runs;
}

function shiftsLabel(s: Stylist, lang: Lang): string {
  return shiftRuns(s)
    .map((r) => {
      const first = r.days[0] ?? 0;
      const last = r.days[r.days.length - 1] ?? first;
      if (lang === 'en') {
        const d = r.days.length === 1 ? dayEn(first) : r.days.length === 2 ? `${dayEn(first)} and ${dayEn(last)}` : `${dayEn(first)} to ${dayEn(last)}`;
        return `${d}, ${time12(r.from)} to ${time12(r.to)}`;
      }
      const d = r.days.length === 1 ? dayEs(first) : r.days.length === 2 ? `${dayEs(first)} y ${dayEs(last)}` : `${dayEs(first)} a ${dayEs(last)}`;
      return `${d} ${r.from}-${r.to}`;
    })
    .join(' · ');
}

/** Who can do each service on each open day, derived from the grid decide() validates against. */
function availability(lang: Lang): string[] {
  return SALON_SERVICES.map((service) => {
    const runs: Array<{ from: number; to: number; who: string[] }> = [];
    for (const { day } of SALON_HOURS) {
      const who = SALON_STAFF.filter((s) => shiftOn(s, day) && canDo(s, service)).map((s) => s.name);
      const last = runs[runs.length - 1];
      if (last && last.who.join() === who.join()) last.to = day;
      else runs.push({ from: day, to: day, who });
    }
    const text = runs
      .filter((r) => r.who.length)
      .map((r) =>
        lang === 'en'
          ? `${r.from === r.to ? dayEn(r.from) : `${dayEn(r.from)} to ${dayEn(r.to)}`} with ${joinEn(r.who, 'or')}`
          : `${r.from === r.to ? dayEs(r.from) : `${dayEs(r.from)} a ${dayEs(r.to)}`} con ${r.who.join(' o ')}`,
      )
      .join('; ');
    return `- ${serviceName(service, lang)}: ${text || (lang === 'en' ? 'nobody does it' : 'no hay nadie que lo haga')}`;
  });
}

const POLICIES = {
  es: [
    'Se cancela o se mueve el turno hasta 4 horas antes, por este chat. No se pide seña.',
    'Efectivo, transferencia, débito y Mercado Pago. Crédito no.',
    'Sin turno se atiende sólo si hay un hueco. Los sábados casi nunca lo hay.',
    `El precio es el mismo con cualquiera de los ${SALON_STAFF.length === 4 ? 'cuatro' : SALON_STAFF.length}.`,
    'Se puede pedir por una persona en particular, sin costo extra, si ese día trabaja y hace ese servicio.',
  ],
  en: [
    'Appointments can be cancelled or moved up to 4 hours before, through this chat. No deposit is needed.',
    'Cash, bank transfer, debit card and Mercado Pago (a local payment app). No credit cards.',
    'Walk-ins are seen only if there is a gap. On Saturdays there almost never is.',
    `The price is the same with any of the ${SALON_STAFF.length === 4 ? 'four' : SALON_STAFF.length}.`,
    'You can ask for a particular person at no extra cost, if they work that day and do that service.',
  ],
};
const NOT_DONE = { es: ['Extensiones y pelucas', 'Depilación y uñas', 'Cualquier tratamiento con formol'], en: ['Extensions and wigs', 'Waxing and nails', 'Any treatment with formaldehyde'] };
const NOT_LOADED = {
  es: ['Promociones o descuentos vigentes', 'Precios de productos para llevar', 'Si hacen peinados a domicilio', 'Cursos o clases'],
  en: ['Current promotions or discounts', 'Prices of products to take home', 'Whether they do styling at your home', 'Courses or classes'],
};
export const CONTEXT_HEADINGS = {
  es: { notDone: 'Lo que no se hace', notLoaded: 'Lo que no está cargado' },
  en: { notDone: 'What the salon does not do', notLoaded: 'What is not loaded' },
} as const;

function context(lang: Lang): string {
  const en = lang === 'en';
  const money = en ? pesosEn : pesosEs;
  const closed = CLOSED_DAY_NUMBERS.map(en ? dayEn : dayEs);
  return [
    `# ${SALON.name}, ${en ? SALON.area.replace('CABA', 'Buenos Aires') : SALON.area}`,
    en
      ? `A neighborhood unisex hair salon and barbershop, open since ${SALON.since}. One location only.`
      : `Peluquería y barbería de barrio, unisex, abierta desde ${SALON.since}. Una sola sucursal.`,
    '',
    en ? '## Opening hours' : '## Horarios del local',
    ...SALON_HOURS.map((h) => (en ? `- ${dayEn(h.day)}: ${time12(h.from)} to ${time12(h.to)}` : `- ${dayEs(h.day)}: de ${h.from} a ${h.to}`)),
    en ? `- Closed: ${joinEn(closed, 'and')}.` : `- Cerrado: ${closed.join(' y ')}.`,
    '',
    en ? '## Services, prices in Argentine pesos, and how long they take' : '## Servicios, precios y cuánto tardan',
    ...SERVICE_GROUPS.flatMap((g) => [
      `### ${en ? GROUPS_EN[g] : g}`,
      ...SALON_SERVICES.filter((s) => s.group === g).map((s) => `- ${serviceName(s, lang)}: ${money(s.price)} · ${s.minutes} min`),
    ]),
    '',
    en ? '## Who works when' : '## Quién trabaja y cuándo',
    ...SALON_STAFF.map((s) => `- ${s.name} (${en ? ROLES_EN[s.name] : s.role}): ${shiftsLabel(s, lang)}.`),
    '',
    en ? '## Which days each service is done, and by whom' : '## Qué días se hace cada servicio y con quién',
    en
      ? 'This table is calculated from the schedule above: do not work it out yourself from the descriptions.'
      : 'Esta tabla está calculada desde la grilla de arriba: no la deduzcas vos de las descripciones.',
    ...availability(lang),
    '',
    en ? '## Last-appointment rule' : '## Regla del último turno',
    en
      ? 'An appointment fits only if the WHOLE service finishes before the salon closes and before the person doing it leaves.'
      : 'Un turno entra sólo si el servicio COMPLETO termina antes de que cierre el local y antes de que se vaya la persona que lo hace.',
    '',
    en ? '## Policies' : '## Políticas',
    ...POLICIES[lang].map((p) => `- ${p}`),
    '',
    `## ${CONTEXT_HEADINGS[lang].notDone}`,
    ...NOT_DONE[lang].map((x) => `- ${x}`),
    '',
    `## ${CONTEXT_HEADINGS[lang].notLoaded}`,
    ...NOT_LOADED[lang].map((x) => `- ${x}`),
  ].join('\n');
}

export const SALON_CONTEXT: Readonly<Record<Lang, string>> = { es: context('es'), en: context('en') };
