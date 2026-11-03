/**
 * Sample situations for the fictional writer, in both languages.
 *
 * Two kinds, as in the case study. "example" briefs can be answered from the
 * sheet plus the brief; if one cannot, it measures the fixture and not the
 * model, and the fix goes into the fixture. "unloaded" briefs ask about
 * something the sheet never mentions, or leave out the one fact the piece
 * needs, which is where a writer pads with plausible inventions.
 */
import type { WriterCase } from './business.ts';

export const EXAMPLES: WriterCase[] = [
  {
    id: 'notice-closed-holiday',
    piece: 'notice',
    probe: 'example',
    brief: {
      en: 'We are closed this Saturday for a national holiday and open again on Tuesday.',
      es: 'Este sábado cerramos por el feriado y volvemos el martes.',
    },
  },
  {
    id: 'reply-tuneup-price',
    piece: 'reply',
    probe: 'example',
    brief: {
      en: 'Someone asks how much a basic tune-up is and whether it can be ready today.',
      es: 'Preguntan cuánto sale el service básico y si puede estar hoy.',
    },
  },
  {
    id: 'email-two-bikes',
    piece: 'email',
    probe: 'example',
    brief: {
      en: 'A customer wants brakes adjusted on both wheels of two bikes. Tell them the total and how it works.',
      es: 'Un cliente quiere ajustar los frenos de las dos ruedas de dos bicis. Pasale el total y cómo funciona.',
    },
  },
];

export const PROBES: WriterCase[] = [
  {
    id: 'reply-electric',
    piece: 'reply',
    probe: 'unloaded',
    brief: { en: 'Someone asks if we repair electric bikes.', es: 'Preguntan si arreglan bicis eléctricas.' },
  },
  {
    id: 'reply-helmets',
    piece: 'reply',
    probe: 'unloaded',
    brief: { en: 'Someone asks if we sell helmets.', es: 'Preguntan si venden cascos.' },
  },
  {
    id: 'notice-close-early',
    piece: 'notice',
    probe: 'unloaded',
    brief: { en: 'Let people know we close early on Friday for stocktaking.', es: 'Avisar que el viernes cerramos más temprano por inventario.' },
  },
  {
    id: 'reply-rental',
    piece: 'reply',
    probe: 'unloaded',
    brief: { en: 'A tourist asks if we rent bikes for the weekend.', es: 'Un turista pregunta si alquilan bicis para el fin de semana.' },
  },
  {
    id: 'email-closed-pickup',
    piece: 'email',
    probe: 'unloaded',
    brief: {
      en: 'We are closed next Thursday for a family matter.',
      es: 'El jueves que viene cerramos por un tema familiar.',
    },
  },
];

export const CASE_SETS: Record<string, WriterCase[]> = {
  examples: EXAMPLES,
  probes: PROBES,
  all: [...EXAMPLES, ...PROBES],
};

export const ALL_CASES = CASE_SETS.all!;
