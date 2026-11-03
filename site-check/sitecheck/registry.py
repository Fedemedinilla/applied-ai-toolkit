"""The CHECK REGISTRY: 37 fixed checks, each with its priority and its evaluator.

EXT-* checks look at the site as infrastructure (connection, domain, server,
mail records, blocklists, speed); VIS-* checks look at what a visitor and a
search engine see (titles, previews, links, contact paths, accessibility,
signs of neglect). The module prefix drives the colour table (colours.py).

"Resumen de Google" (the four Lighthouse scores) is NOT a check: it is the
report header, built by checks/header.py.

Flags: ``speed`` (a FALLA is always Amarillo: slow is never "arreglar ya") and
``html_derived`` (a FALLA must pass the HTML evidence gate, gate.py).
"""

from __future__ import annotations

from .checks import a11y, contact, content, legacy, linkcheck, mailauth, security, seo, speed
from .model import CheckSpec, Module, Priority

_C, _A, _M, _B = Priority.CRITICA, Priority.ALTA, Priority.MEDIA, Priority.BAJA
_EXT, _VIS = Module.EXT, Module.VIS

CHECKS: tuple[CheckSpec, ...] = (
    # Speed (FALLA is always Amarillo)
    CheckSpec("EXT-08", "¿Qué tan rápido lo ven los usuarios reales en el celular?", _EXT, _A,
              speed.evaluate_ext08, speed=True),
    CheckSpec("EXT-21", "¿Cuánto pesa la página y cuánto es de terceros?", _EXT, _M,
              speed.evaluate_ext21, speed=True),
    CheckSpec("EXT-20", "¿Cuánto tarda el servidor en empezar a responder?", _EXT, _A,
              speed.evaluate_ext20, speed=True),
    CheckSpec("EXT-18", "¿El servidor usa los protocolos rápidos?", _EXT, _M,
              speed.evaluate_ext18, speed=True),
    CheckSpec("EXT-19", "¿Hay una capa de caché o CDN funcionando?", _EXT, _M,
              speed.evaluate_ext19, speed=True, html_derived=True),
    # Visibility
    CheckSpec("VIS-06", "¿El link se ve con foto y título cuando lo comparten por WhatsApp?", _VIS, _A,
              seo.evaluate_vis06, html_derived=True),
    CheckSpec("VIS-04", "¿El título y la descripción dicen qué es el sitio?", _VIS, _M,
              seo.evaluate_vis04, html_derived=True),
    CheckSpec("VIS-01", "¿Google puede mostrar el sitio?", _VIS, _C,
              seo.evaluate_vis01, html_derived=True),
    CheckSpec("VIS-02", "¿El sitio le da a Google el mapa de sus páginas?", _VIS, _M,
              seo.evaluate_vis02),
    CheckSpec("VIS-03", "¿Cada página tiene una sola dirección oficial?", _VIS, _M,
              seo.evaluate_vis03, html_derived=True),
    CheckSpec("VIS-05", "¿La página tiene un solo título principal?", _VIS, _B,
              seo.evaluate_vis05, html_derived=True),
    CheckSpec("VIS-07", "¿El sitio le da a Google sus datos de contacto y ubicación en el formato que Google lee?", _VIS, _B,
              seo.evaluate_vis07, html_derived=True),
    CheckSpec("VIS-08", "Si el sitio es bilingüe, ¿Google entiende qué versión mostrar?", _VIS, _B,
              seo.evaluate_vis08, html_derived=True),
    CheckSpec("VIS-09", "¿Hay links rotos o que dan vueltas antes de llegar?", _VIS, _M,
              linkcheck.evaluate_vis09),
    CheckSpec("VIS-10", "¿Se lee bien y se ve dónde está el foco al navegar con teclado?", _VIS, _M,
              a11y.evaluate_vis10),
    CheckSpec("VIS-11", "¿Las imágenes tienen descripción para quien no las ve?", _VIS, _B,
              a11y.evaluate_vis11, html_derived=True),
    CheckSpec("VIS-12", "¿Se puede usar en un celular angosto y con zoom al 200 %?", _VIS, _M,
              a11y.evaluate_vis12, html_derived=True),
    CheckSpec("VIS-13", "¿Los formularios se entienden y los botones se pueden tocar?", _VIS, _M,
              a11y.evaluate_vis13, html_derived=True),
    CheckSpec("VIS-14", "¿La página declara su idioma y tiene título propio?", _VIS, _B,
              seo.evaluate_vis14, html_derived=True),
    CheckSpec("VIS-15", "¿Se puede escribir o llamar en un toque desde el celular?", _VIS, _B,
              contact.evaluate_vis15, html_derived=True),
    # Security seen from outside
    CheckSpec("EXT-07", "¿El candado es válido y no está por vencer?", _EXT, _A,
              security.evaluate_ext07),
    CheckSpec("EXT-13", "¿El dominio está por vencer?", _EXT, _A,
              security.evaluate_ext13),
    CheckSpec("EXT-17", "¿Entra siempre al mismo sitio con candado, con o sin www?", _EXT, _A,
              security.evaluate_ext17),
    CheckSpec("EXT-16", "¿Hay partes del sitio que cargan sin candado?", _EXT, _M,
              security.evaluate_ext16, html_derived=True),
    CheckSpec("EXT-01", "¿El sitio le dice al navegador cómo protegerse?", _EXT, _A,
              security.evaluate_ext01),
    CheckSpec("EXT-05", "¿Pueden mandar mails falsos con el nombre del dominio?", _EXT, _A,
              mailauth.evaluate_ext05),
    CheckSpec("EXT-23", "¿Google o las listas de correo marcan al sitio como peligroso?", _EXT, _C,
              security.evaluate_ext23),
    CheckSpec("EXT-02", "¿Se ve qué versión de WordPress usa?", _EXT, _M,
              security.evaluate_ext02, html_derived=True),
    CheckSpec("EXT-09", "¿El servidor cuenta qué software y versión corre?", _EXT, _B,
              security.evaluate_ext09),
    CheckSpec("EXT-24", "¿Google muestra páginas ajenas dentro del sitio?", _EXT, _C,
              content.evaluate_ext24, html_derived=True),
    # Content and contact
    CheckSpec("VIS-16", "Señales de desactualización", _VIS, _M,
              content.evaluate_vis16, html_derived=True),
    CheckSpec("VIS-17", "Inscripciones a la vista", _VIS, _M,
              content.evaluate_vis17, html_derived=True),
    CheckSpec("EXT-25", "Política de privacidad", _EXT, _M,
              security.evaluate_ext25, html_derived=True),
    CheckSpec("VIS-18", "Botón de WhatsApp con el número bien escrito", _VIS, _M,
              contact.evaluate_vis18, html_derived=True),
    CheckSpec("VIS-19", "Restos de fábrica del tema y de WordPress", _VIS, _B,
              content.evaluate_vis19, html_derived=True),
    CheckSpec("VIS-20", "¿El código del sitio está hecho para navegadores que ya no se usan?", _VIS, _M,
              legacy.evaluate_vis20, html_derived=True),
    CheckSpec("VIS-21", "¿Las direcciones de correo que publica el sitio pueden recibir mails?", _VIS, _M,
              contact.evaluate_vis21, html_derived=True),
)


def all_specs() -> tuple[CheckSpec, ...]:
    """Every CheckSpec, in registry order."""
    return CHECKS


def by_id() -> dict[str, CheckSpec]:
    """Mapping id -> CheckSpec. Raises ValueError on a duplicate ID."""
    out: dict[str, CheckSpec] = {}
    for spec in CHECKS:
        if spec.id in out:
            raise ValueError(f"duplicate check ID in the registry: {spec.id}")
        out[spec.id] = spec
    return out


def get(check_id: str) -> CheckSpec:
    """The CheckSpec of ``check_id``; KeyError when unknown."""
    return by_id()[check_id]
