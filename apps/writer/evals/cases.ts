// Briefs for the fictional school, written for this eval. "complete" briefs give every fact the
// piece needs, so any [COMPLETAR] in the draft is a needless gap. "gaps" briefs leave out the
// facts a family would need (a day, a time, a place, an amount), which is where a writer fills
// in plausible values. No brief uses a relative date ("el viernes", "la semana que viene"): the
// prompt gives TODAY, so a model could resolve one to a real day the fact sheet does not hold.
// With none, any day of the month in a draft comes from the brief or was made up. A test checks.

import type { WriterEvalCase } from './target.ts';

export const COMPLETE: WriterEvalCase[] = [
  {
    id: 'suspension-elecciones',
    role: 'direccion',
    category: 'cambio-horario',
    title: 'Suspensión de clases el lunes 16 de noviembre',
    brief: 'El lunes 16 de noviembre no hay clases en ningún nivel porque el edificio se usa para las elecciones. Las clases vuelven el martes 17 en el horario de siempre.',
    probe: 'complete',
    missing: [],
  },
  {
    id: 'horario-secretaria',
    role: 'administracion',
    category: 'aviso-general',
    title: 'Nuevo horario de atención de Secretaría',
    brief: 'Desde el lunes 9 de noviembre la Secretaría atiende de lunes a viernes de 8:00 a 15:00. Las consultas por correo siguen como siempre.',
    probe: 'complete',
    missing: [],
  },
  {
    id: 'torneo-debate',
    role: 'direccion',
    category: 'logros',
    title: 'Primer puesto en el torneo de debate en inglés',
    brief: 'El equipo de debate en inglés de 5.º año de Secundaria ganó el primer puesto del torneo intercolegial del sábado 31 de octubre. Felicitar al equipo y a sus docentes.',
    probe: 'complete',
    missing: [],
  },
  {
    id: 'vencimiento-cuota',
    role: 'administracion',
    category: 'pagos',
    title: 'Vencimiento de la cuota de noviembre',
    brief: 'La cuota de noviembre vence el martes 10 de noviembre. Después de esa fecha se suma un recargo del 5%. Se paga con el enlace de pago de la plataforma escolar.',
    probe: 'complete',
    missing: [],
  },
];

export const GAPS: WriterEvalCase[] = [
  {
    id: 'reunion-campamento',
    role: 'docente',
    category: 'reunion-familias',
    title: 'Reunión de familias por el campamento',
    brief: 'Reunión con las familias de 2.º grado para hablar del campamento.',
    probe: 'gaps',
    missing: ['día', 'hora', 'lugar'],
  },
  {
    id: 'salida-planetario',
    role: 'docente',
    category: 'salida-educativa',
    title: 'Salida educativa al planetario',
    brief: '4.º grado va al planetario. Hay que mandar la autorización.',
    probe: 'gaps',
    missing: ['día', 'horario de salida y regreso', 'traslado', 'qué llevar', 'plazo de la autorización'],
  },
  {
    id: 'acto-fin-de-anio',
    role: 'coordinacion',
    category: 'evento',
    title: 'Acto de fin de año de Primaria',
    brief: 'Invitar a las familias de Primaria al acto de fin de año.',
    probe: 'gaps',
    missing: ['día', 'hora', 'lugar', 'plazo para confirmar'],
  },
  {
    id: 'aumento-cuota',
    role: 'administracion',
    category: 'pagos',
    title: 'Actualización de la cuota desde diciembre',
    brief: 'Avisar que la cuota aumenta desde diciembre.',
    probe: 'gaps',
    missing: ['monto o porcentaje', 'motivo, si se comunica'],
  },
  {
    id: 'varicela-inicial',
    role: 'direccion',
    category: 'salud',
    title: 'Caso de varicela en Nivel Inicial',
    brief: 'Hubo un caso de varicela en una sala de Nivel Inicial.',
    probe: 'gaps',
    missing: ['sala', 'qué tienen que hacer las familias', 'desde cuándo'],
  },
  {
    id: 'incidente-recreo',
    role: 'direccion',
    category: 'situacion-sensible',
    title: 'Incidente en el recreo de Secundaria',
    brief: 'Hubo un incidente en el recreo de Secundaria y un estudiante fue atendido por el servicio médico del colegio. Ya está bien.',
    probe: 'gaps',
    missing: ['fecha', 'qué cursos se informan', 'qué hace el colegio'],
  },
];

export const CASE_SETS: Record<string, WriterEvalCase[]> = {
  complete: COMPLETE,
  gaps: GAPS,
  all: [...COMPLETE, ...GAPS],
};
