// The tenant the demo page embeds: a fictional plant nursery. Every name, address and detail below
// is invented. The text is neutral Latin American Spanish, as the business would write it.

export const DEMO_TENANT = {
  tenantId: 'vivero-demo',
  accountId: '6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7',
  email: 'owner@vivero-demo.example',
  botName: 'Vivero Hoja Clara',
  header: 'Vivero Hoja Clara',
  welcome: 'Hola. Soy el asistente del vivero. ¿En qué te puedo ayudar?',
  placeholder: 'Escribe tu pregunta',
  primaryColor: '#2f6b3a',
  font: 'system-ui',
  suggestedQuestions: ['¿Qué horario tienen?', '¿Hacen envíos?', '¿Qué planta me recomiendan para interior?'],
  tonePreset: 'friendly',
  tone: 'Trata al cliente de tú. Si preguntan por una planta que no está en la lista, ofrece averiguar en el local.',
  context: [
    'Vivero Hoja Clara es un vivero de barrio ficticio, creado para esta demostración.',
    'Horario: martes a domingo de 9 a 18 h. Los lunes está cerrado.',
    'Envíos: dentro de la ciudad, los jueves y sábados. Las macetas de más de 40 cm no se envían.',
    'Plantas de interior que siempre hay: potus, sansevieria, zamioculca y helechos.',
    'Plantas de exterior: lavanda, romero, jazmín y rosales de temporada.',
    'Se puede pagar en efectivo, con tarjeta o con transferencia.',
    'Los precios cambian con la temporada y se consultan en el local.',
  ].join('\n'),
  faq: [
    'P: ¿Tienen estacionamiento?',
    'R: No, pero hay lugar en la calle.',
    '',
    'P: ¿Hacen diseño de jardines?',
    'R: No. Damos consejos en el local sin cargo.',
  ].join('\n'),
  allowedDomains: ['localhost', '127.0.0.1'],
} as const;
