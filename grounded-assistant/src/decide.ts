/**
 * Whether a booking the model proposed can happen. The model proposes and this file decides: a
 * card leaves only when the service is a row, the day is open, not past and within the booking
 * horizon, someone who does the service works that day, the whole service fits before closing,
 * and the time (stated, or the last possible start when none is stated) has not gone by today. Each refusal says which check failed, in the visitor's language, and replaces the
 * model's prose, which was written to accompany a booking that is not happening.
 */
import { joinEn, time12, type Lang } from './lang.ts';
import {
  canDo,
  dayPlural,
  dayPluralEn,
  findService,
  findServices,
  findStaff,
  fits,
  hoursOn,
  SALON,
  SALON_STAFF,
  serviceName,
  shiftOn,
  toHHMM,
  toMin,
} from './salon.ts';

export interface ProposedBooking {
  readonly service: string;
  readonly stylist: string | null;
  readonly date: string;
  readonly time: string | null;
}

export interface Card {
  readonly service: string;
  readonly price: number;
  readonly minutes: number;
  readonly stylist: string | null;
  /** Who could take it, when no one person was named or implied. */
  readonly candidates: readonly string[] | null;
  readonly date: string;
  readonly dayLabel: string;
  readonly time: string | null;
}

export type Refusal =
  | 'no_service'
  | 'ambiguous_service'
  | 'service_not_loaded'
  | 'bad_date'
  | 'past_date'
  | 'no_such_date'
  | 'closed'
  | 'nobody'
  | 'unknown_stylist'
  | 'wrong_stylist'
  | 'too_long'
  | 'bad_time'
  | 'past_time'
  | 'too_late_today'
  | 'too_far'
  | 'late_start';

/** How far ahead a request can be for. A date in year 9999 is a model error, not a booking. */
export const BOOKING_HORIZON_DAYS = 90;

export type Decision = { readonly ok: true; readonly card: Card } | { readonly ok: false; readonly reason: Refusal; readonly say: string };

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const staffEs = () => {
  const n = SALON_STAFF.map((s) => s.name);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`;
};

/**
 * What decide() says, per language. These texts go back into the history as assistant turns, so
 * the model reads them again next turn; a Spanish one on the English path would teach the model,
 * mid-conversation, to switch language.
 */
const SAY = {
  es: {
    no_service: () => '¿Qué servicio querés? Decime cuál y te lo paso al local.',
    ambiguous_service: (asked: string, options: string[]) => `"${asked}" me da para varios: ${options.join(', ')}. ¿Cuál de esos?`,
    service_not_loaded: (asked: string) => `No tengo cargado "${asked}" como servicio, así que no te lo puedo agendar. Fijate en ${SALON.site}.`,
    bad_date: () => 'Se me mezcló la fecha. ¿Me decís de nuevo qué día querés?',
    past_date: () => 'Esa fecha ya pasó. ¿Para qué día lo querés?',
    past_time: () => 'Esa hora de hoy ya pasó. ¿Vemos más tarde u otro día?',
    too_late_today: (service: string) => `Hoy ya no llega a entrar ${service} antes del cierre. ¿Vemos otro día?`,
    too_far: (days: number) => `Tomo pedidos hasta ${days} días para adelante. ¿Para qué día más cercano lo querés?`,
    no_such_date: () => 'Esa fecha no existe. ¿Cuál querías?',
    closed: (wd: number) => `Los ${dayPlural(wd)} el local está cerrado, así que ese día no va. ¿Te sirve otro?`,
    nobody: (wd: number, service: string) => `Los ${dayPlural(wd)} no hay nadie que haga ${service}. ¿Vemos otro día?`,
    unknown_stylist: (service: string, who: string[]) => `Acá trabajan ${staffEs()}. ${service} lo hace ${who.join(' o ')}.`,
    wrong_stylist: (wd: number, service: string, who: string[], asked: string) => `Los ${dayPlural(wd)}, ${service} lo hace ${who.join(' o ')}, no ${asked}.`,
    too_long: (wd: number, service: string, minutes: number) => `Los ${dayPlural(wd)} no entra ${service}: son ${minutes} minutos y no llega a terminar. ¿Probamos otro día?`,
    bad_time: () => '¿A qué hora te queda cómodo?',
    late_start: (service: string, minutes: number, hhmm: string) => `A esa hora no entra: ${service} son ${minutes} minutos y el último turno de ese día arranca ${hhmm}.`,
    locale: 'es-AR',
  },
  en: {
    no_service: () => "Which service would you like? Tell me and I'll pass it on to the salon.",
    ambiguous_service: (asked: string, options: string[]) => `"${asked}" could be more than one service: ${options.join('; ')}. Which one?`,
    service_not_loaded: (asked: string) => `I don't have "${asked}" loaded as a service, so there's no request to send. Have a look at ${SALON.site}.`,
    bad_date: () => 'I got the date mixed up. Which day would you like?',
    past_date: () => 'That date has already passed. Which day would you like?',
    past_time: () => 'That time has already passed today. Shall we look at later today or another day?',
    too_late_today: (service: string) => `There isn't time left today for ${lower(service)} to finish before closing. Shall we look at another day?`,
    too_far: (days: number) => `I can take requests up to ${days} days ahead. Which nearer day would suit you?`,
    no_such_date: () => "That date doesn't exist. Which one did you mean?",
    closed: (wd: number) => `The salon is closed on ${dayPluralEn(wd)}, so that day won't work. Would another day suit you?`,
    nobody: (wd: number, service: string) => `Nobody does ${lower(service)} on ${dayPluralEn(wd)}. Shall we look at another day?`,
    unknown_stylist: (service: string, who: string[]) => `The team here is ${joinEn(SALON_STAFF.map((s) => s.name), 'and')}. ${upper(service)} is done by ${joinEn(who, 'or')}.`,
    wrong_stylist: (wd: number, service: string, who: string[], asked: string) => `On ${dayPluralEn(wd)}, ${lower(service)} is done by ${joinEn(who, 'or')}, not ${asked}.`,
    too_long: (wd: number, service: string, minutes: number) => `${upper(service)} doesn't fit on ${dayPluralEn(wd)}: it takes ${minutes} minutes and there isn't time to finish. Shall we try another day?`,
    bad_time: () => 'What time would suit you?',
    late_start: (service: string, minutes: number, hhmm: string) => `That time doesn't work: ${lower(service)} takes ${minutes} minutes, and the last start that day is ${time12(hhmm)}.`,
    locale: 'en-US',
  },
} as const;

/** English models write "5:30 pm" or "9:30" despite the schema; both have one reading. */
export function timeEn24(raw: string): string {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(raw.trim());
  if (m) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) return raw;
    const h24 = (h % 12) + ((m[3] ?? '').toLowerCase() === 'p' ? 12 : 0);
    return `${String(h24).padStart(2, '0')}:${m[2] ?? '00'}`;
  }
  const bare = /^(\d):(\d{2})$/.exec(raw.trim());
  return bare ? `0${bare[1]}:${bare[2]}` : raw;
}

/** Whole days from one YYYY-MM-DD to another, on the UTC calendar. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** True for a real calendar date in YYYY-MM-DD, so 2026-02-30 is not silently March 2. */
function realDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/**
 * `today` is the salon's calendar day and `now` its current time ("HH:MM"), both in the salon's
 * time zone. Without `now`, a booking for today at an hour already gone was approved (in the
 * source, at 17:00 the assistant offered "hoy a las 12").
 */
export function decide(b: ProposedBooking, today: string, lang: Lang = 'es', now?: string): Decision {
  const say = SAY[lang];
  const no = (reason: Refusal, text: string): Decision => ({ ok: false, reason, say: text });
  const service = findService(b.service, lang);
  if (!service) {
    // Three different noes, because saying the wrong one is also a lie: "corte" is five rows.
    if (!b.service.trim()) return no('no_service', say.no_service());
    const options = findServices(b.service, lang);
    if (options.length > 1) return no('ambiguous_service', say.ambiguous_service(b.service, options.map((o) => serviceName(o, lang))));
    return no('service_not_loaded', say.service_not_loaded(b.service));
  }
  const name = serviceName(service, lang);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return no('bad_date', say.bad_date());
  if (!realDate(b.date)) return no('no_such_date', say.no_such_date());
  if (b.date < today) return no('past_date', say.past_date());
  if (daysBetween(today, b.date) > BOOKING_HORIZON_DAYS) return no('too_far', say.too_far(BOOKING_HORIZON_DAYS));

  // Parsed as UTC on purpose: a plain calendar date that the server's zone must not shift.
  const weekday = new Date(`${b.date}T00:00:00Z`).getUTCDay();
  const day = hoursOn(weekday);
  if (!day) return no('closed', say.closed(weekday));

  const candidates = SALON_STAFF.filter((s) => shiftOn(s, weekday) && canDo(s, service));
  if (!candidates.length) return no('nobody', say.nobody(weekday, name));

  let stylist = b.stylist ? findStaff(b.stylist) : null;
  if (b.stylist && !stylist) return no('unknown_stylist', say.unknown_stylist(name, candidates.map((c) => c.name)));
  if (stylist && !candidates.includes(stylist)) return no('wrong_stylist', say.wrong_stylist(weekday, name, candidates.map((c) => c.name), stylist.name));
  if (!stylist && candidates.length === 1) stylist = candidates[0] ?? null;

  const window = (s: (typeof candidates)[number]) => {
    const sh = shiftOn(s, weekday);
    return sh ? { opens: Math.max(toMin(day.from), toMin(sh.from)), closes: Math.min(toMin(day.to), toMin(sh.to)) } : { opens: 0, closes: 0 };
  };
  const doable = (stylist ? [stylist] : candidates).filter((s) => window(s).closes - window(s).opens >= service.minutes);
  if (!doable.length) return no('too_long', say.too_long(weekday, name, service.minutes));

  // With a time, the grid is checked for everyone who could take it, not the first in the list.
  // The source once answered "the last start is 14:30" (the first person's closing) while another
  // barber cut until 18:00, and approved a card listing someone who starts at 13:00 for 09:30.
  let possible = doable;
  const time = lang === 'en' && b.time ? timeEn24(b.time) : b.time;
  if (time) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return no('bad_time', say.bad_time());
    if (now && b.date === today && time <= now) return no('past_time', say.past_time());
    possible = doable.filter((s) => fits(s, service, weekday, time));
    if (!possible.length) {
      const lastStart = Math.max(...doable.map((s) => window(s).closes - service.minutes));
      return no('late_start', say.late_start(name, service.minutes, toHHMM(lastStart)));
    }
  } else if (now && b.date === today) {
    // No time for today: someone must still be able to start after now and finish before closing.
    // Without this, at 19:50 a 180-minute service got a card for today.
    possible = doable.filter((s) => window(s).closes - service.minutes > toMin(now));
    if (!possible.length) return no('too_late_today', say.too_late_today(name));
  }

  const dayLabel = new Intl.DateTimeFormat(say.locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${b.date}T00:00:00Z`));
  return {
    ok: true,
    card: {
      service: name,
      price: service.price,
      minutes: service.minutes,
      stylist: stylist ? stylist.name : null,
      candidates: stylist ? null : possible.map((c) => c.name),
      date: b.date,
      dayLabel,
      time: time || null,
    },
  };
}
