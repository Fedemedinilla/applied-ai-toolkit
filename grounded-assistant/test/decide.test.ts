// decide(): every way a proposed booking can be impossible, each with a control that is possible.
// Dates: 2026-11-04 is a Wednesday, 11-07 a Saturday, 11-08 a Sunday, 11-09 a Monday, 11-10 a Tuesday.

import { describe, expect, it } from 'vitest';
import { BOOKING_HORIZON_DAYS, decide, findService, findServices, findStaff, timeEn24, type ProposedBooking } from '../src/index.ts';

const TODAY = '2026-11-04';
const b = (over: Partial<ProposedBooking>): ProposedBooking => ({ service: 'Balayage', stylist: null, date: '2026-11-07', time: null, ...over });
const reason = (d: ReturnType<typeof decide>) => (d.ok ? 'ok' : d.reason);

describe('closed days and dates', () => {
  it('Sunday and Monday are closed, in both languages', () => {
    const sun = decide(b({ date: '2026-11-08' }), TODAY);
    expect(sun).toMatchObject({ ok: false, reason: 'closed', say: 'Los domingos el local está cerrado, así que ese día no va. ¿Te sirve otro?' });
    expect(decide(b({ date: '2026-11-09' }), TODAY, 'en')).toMatchObject({ ok: false, reason: 'closed', say: expect.stringContaining('closed on Mondays') });
    expect(decide(b({ date: '2026-11-07' }), TODAY).ok).toBe(true);
  });

  it('a past date, a malformed one and one that does not exist', () => {
    expect(reason(decide(b({ date: '2026-11-03' }), TODAY))).toBe('past_date');
    expect(reason(decide(b({ date: '7/11/2026' }), TODAY))).toBe('bad_date');
    expect(reason(decide(b({ date: '2026-02-30' }), '2026-01-01'))).toBe('no_such_date');
    expect(reason(decide(b({ date: '2026-13-01' }), TODAY))).toBe('no_such_date');
  });

  it('the weekday comes from the calendar date, whatever the process time zone', () => {
    // A Saturday read in a zone west of UTC would land on Friday if parsed as local time.
    const d = decide(b({ service: 'Trenzas o peinado de nena', date: '2026-11-07' }), TODAY);
    expect(d).toMatchObject({ ok: true, card: { stylist: 'Vanina', dayLabel: 'sábado, 7 de noviembre' } });
  });
});

describe('staff', () => {
  it('nobody does color on a Tuesday', () => {
    expect(decide(b({ date: '2026-11-10' }), TODAY)).toMatchObject({ ok: false, reason: 'nobody', say: 'Los martes no hay nadie que haga Balayage. ¿Vemos otro día?' });
  });

  it('a stylist who does not do the service, and one who does not exist', () => {
    expect(decide(b({ service: 'Corte de hombre (máquina y tijera)', stylist: 'Vanina' }), TODAY)).toMatchObject({
      ok: false,
      reason: 'wrong_stylist',
      say: 'Los sábados, Corte de hombre (máquina y tijera) lo hace Rubén o Damián, no Vanina.',
    });
    expect(decide(b({ stylist: 'Lucía' }), TODAY)).toMatchObject({ ok: false, reason: 'unknown_stylist', say: 'Acá trabajan Rubén, Damián, Carla y Vanina. Balayage lo hace Carla.' });
  });

  it('a blank stylist is no stylist, not Rubén by prefix', () => {
    expect(findStaff(' ')).toBeNull();
    expect(findStaff('ru')).toBeNull();
    expect(findStaff('Rub')?.name).toBe('Rubén');
  });

  it('the only person who can take it goes on the card', () => {
    expect(decide(b({}), TODAY)).toMatchObject({ ok: true, card: { stylist: 'Carla', candidates: null } });
  });
});

describe('time', () => {
  it('a service that does not fit in anyone’s window that day', () => {
    // Balayage is 180 minutes; on Saturday Carla works 09:00 to 15:00, so it fits only from 09:00 to 12:00.
    expect(decide(b({ time: '12:30' }), TODAY)).toMatchObject({
      ok: false,
      reason: 'late_start',
      say: 'A esa hora no entra: Balayage son 180 minutos y el último turno de ese día arranca 12:00.',
    });
    expect(decide(b({ time: '12:00' }), TODAY).ok).toBe(true);
  });

  it('the last start is the latest of everyone who could take it, not the first in the list', () => {
    // Saturday: Rubén leaves at 15:00, Damián at 18:00. A men's cut at 17:00 fits with Damián.
    const d = decide(b({ service: 'Corte de hombre (máquina y tijera)', time: '17:00' }), TODAY);
    expect(d).toMatchObject({ ok: true, card: { candidates: ['Damián'] } });
    expect(decide(b({ service: 'Corte de hombre (máquina y tijera)', time: '17:45' }), TODAY)).toMatchObject({
      reason: 'late_start',
      say: expect.stringContaining('arranca 17:30'),
    });
  });

  it('candidates at a time are the ones there at that time', () => {
    // Wednesday 09:30: Rubén is in, Damián starts at 13:00.
    const d = decide(b({ service: 'Corte de hombre (máquina y tijera)', date: TODAY, time: '09:30' }), TODAY, 'es', '08:00');
    expect(d).toMatchObject({ ok: true, card: { candidates: ['Rubén'] } });
  });

  it('a time today that has gone by, including the current minute', () => {
    const sat = '2026-11-07';
    expect(decide(b({ time: '11:00' }), sat, 'es', '12:00')).toMatchObject({ reason: 'past_time', say: 'Esa hora de hoy ya pasó. ¿Vemos más tarde u otro día?' });
    expect(reason(decide(b({ time: '11:00' }), sat, 'es', '11:00'))).toBe('past_time');
    expect(decide(b({ time: '11:00' }), sat, 'es', '10:30').ok).toBe(true);
    expect(decide(b({ time: '11:00' }), TODAY, 'es', '23:00').ok).toBe(true);
  });

  it('today with no time: refused once the last possible start has gone by', () => {
    // Balayage is 180 minutes; on Wednesday only Carla does it, 10:00 to 19:00, so the last start is 16:00.
    const today = b({ date: TODAY });
    expect(decide(today, TODAY, 'es', '19:50')).toMatchObject({ ok: false, reason: 'too_late_today', say: 'Hoy ya no llega a entrar Balayage antes del cierre. ¿Vemos otro día?' });
    expect(reason(decide(today, TODAY, 'es', '16:00'))).toBe('too_late_today');
    expect(decide(today, TODAY, 'en', '19:50')).toMatchObject({ reason: 'too_late_today', say: expect.stringContaining("isn't time left today for balayage") });
    expect(decide(today, TODAY, 'es', '15:59')).toMatchObject({ ok: true, card: { stylist: 'Carla', time: null } });
    expect(decide(today, TODAY, 'es', '19:50').ok).toBe(false);
    expect(decide(b({ date: '2026-11-05' }), TODAY, 'es', '19:50').ok).toBe(true);
  });

  it('today with no time lists only the people who can still start', () => {
    // Wednesday men's cut: Rubén until 15:00, Damián until 20:00. At 16:00 only Damián is left.
    const d = decide(b({ service: 'Corte de hombre (máquina y tijera)', date: TODAY }), TODAY, 'es', '16:00');
    expect(d).toMatchObject({ ok: true, card: { candidates: ['Damián'] } });
  });

  it(`a date more than ${BOOKING_HORIZON_DAYS} days ahead is refused`, () => {
    expect(reason(decide(b({ date: '9999-11-06' }), TODAY))).toBe('too_far');
    expect(reason(decide(b({ date: '2027-02-03' }), TODAY))).toBe('too_far'); // 91 days
    expect(reason(decide(b({ service: 'Corte de hombre (máquina y tijera)', date: '2027-02-02' }), TODAY))).toBe('ok'); // 90 days, a Tuesday
  });

  it('a malformed time asks for the hour', () => {
    expect(reason(decide(b({ time: '25:00' }), TODAY))).toBe('bad_time');
    expect(reason(decide(b({ time: 'tarde' }), TODAY))).toBe('bad_time');
  });

  it('English times with am/pm or one digit are read; the Spanish path is strict', () => {
    expect(timeEn24('5:30 pm')).toBe('17:30');
    expect(timeEn24('9:30')).toBe('09:30');
    expect(timeEn24('12 am')).toBe('00:00');
    expect(timeEn24('13 pm')).toBe('13 pm');
    expect(decide(b({ service: 'Balayage', time: '9:30 am' }), TODAY, 'en')).toMatchObject({ ok: true, card: { time: '09:30', dayLabel: 'Saturday, November 7' } });
    expect(reason(decide(b({ time: '9:30' }), TODAY, 'es'))).toBe('bad_time');
  });
});

describe('services', () => {
  it('an empty service asks which one', () => {
    expect(reason(decide(b({ service: '  ' }), TODAY))).toBe('no_service');
    expect(findServices('')).toEqual([]);
    expect(findServices('de')).toEqual([]);
  });

  it('"corte" is several rows: a question, not "not loaded"', () => {
    const d = decide(b({ service: 'corte' }), TODAY);
    expect(d).toMatchObject({ ok: false, reason: 'ambiguous_service' });
    expect(reason(decide(b({ service: 'cut' }), TODAY, 'en'))).toBe('ambiguous_service');
  });

  it('a service with no row is not loaded, never priced off a neighbour', () => {
    expect(decide(b({ service: 'Fade con diseño' }), TODAY)).toMatchObject({ reason: 'service_not_loaded', say: expect.stringContaining('peluqueria-los-pelados.example') });
  });

  it("English \"men's cut\" is the men's cut, not also the women's", () => {
    expect(findService("men's cut", 'en')?.id).toBe('corte-hombre');
    expect(findService('Men’s cut', 'en')?.id).toBe('corte-hombre');
  });

  it('the card carries the row’s price and minutes, never the model’s', () => {
    expect(decide(b({}), TODAY)).toMatchObject({ ok: true, card: { service: 'Balayage', price: 78_000, minutes: 180 } });
  });
});
