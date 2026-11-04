"""VIS-15 and the contact buttons that a script builds.

The check reads the home without running its scripts, so a WhatsApp or call
button that a widget builds (Elfsight, GetButton, Tidio, Crisp, Zendesk,
tawk.to...) is invisible to it and "there is no contact link" can be false.
Each widget family, by its script address or its loader snippet, turns VIS-15
from FALLA into APROBADO_CON_OBSERVACION; text that only names a widget does not.
"""

from __future__ import annotations

import unittest

import support  # noqa: F401

from sitecheck.checks import contact
from sitecheck.model import State
from fixhelp import run_e2e
from obsfactory import html_page, make_obs
from sitefixtures import SchoolOptions, default_apis
from test_checks_contact_paths import ev, with_home

FOUND_WHATSAPP = "El botón de WhatsApp se arma al cargar la página y no se pudo ver en el código"
FOUND_CHAT = (
    "Hay un chat o un complemento que se arma al cargar la página; desde el código no se puede ver si ofrece WhatsApp "
    "o un teléfono"
)

# A home with no contact button at all: VIS-15 fails on it (the control of every case below).
BARE_BODY = "<h1>Colegio Ejemplo</h1><p>Inscripciones abiertas para el ciclo lectivo 2027.</p>"


def vis15(body: str):  # type: ignore[no-untyped-def]
    return ev(contact.evaluate_vis15, make_obs(html_page(body=BARE_BODY + body)))


# ---------------------------------------------------------------------------
# each widget family is a marker, never a FALLA
# ---------------------------------------------------------------------------

# (case, HTML added to the bare home, marker name, the report's "found" sentence), typed by hand.
FAMILIES: tuple[tuple[str, str, str, str], ...] = (
    (
        "elfsight static",
        '<script src="https://static.elfsight.com/platform/platform.js" async></script><div class="elfsight-app-1a2b"></div>',
        "elfsight",
        FOUND_CHAT,
    ),
    ("elfsight apps", '<script src="https://apps.elfsight.com/p/platform.js" defer></script>', "elfsight", FOUND_CHAT),
    ("elfsight cdn", '<script src="https://elfsightcdn.com/platform.js" async></script>', "elfsight", FOUND_CHAT),
    (
        "getbutton src",
        '<script src="https://static.getbutton.io/widget-send-button/js/init.js" async></script>',
        "getbutton",
        FOUND_WHATSAPP,
    ),
    (
        "getbutton snippet",
        '<script>(function () { var options = { whatsapp: "+5491123456789", call: "+5491123456789" };'
        ' var proto = "https:", host = "getbutton.io", url = proto + "//static." + host;'
        ' var s = document.createElement("script"); s.src = url + "/widget-send-button/js/init.js"; })();</script>',
        "getbutton",
        FOUND_WHATSAPP,
    ),
    (
        "whatshelp",
        '<script src="https://static.whatshelp.io/widget-send-button/js/init.js" async></script>',
        "whatshelp",
        FOUND_WHATSAPP,
    ),
    ("tidio code", '<script src="//code.tidio.co/abcdefghijklmnopqrstuvwxyz012345.js" async></script>', "tidio", FOUND_CHAT),
    ("tidio widget", '<script src="https://widget.tidio.co/loader.js" async></script>', "tidio", FOUND_CHAT),
    (
        "tidio plugin",
        '<script src="https://www.colegio.test/wp-content/plugins/tidio-live-chat/media/js/load.js"></script>',
        "tidio",
        FOUND_CHAT,
    ),
    (
        "crisp snippet",
        '<script>window.$crisp=[];window.CRISP_WEBSITE_ID="0000-1111";(function(){var d=document;'
        'var s=d.createElement("script");s.src="https://client.crisp.chat/l.js";s.async=1;'
        'd.getElementsByTagName("head")[0].appendChild(s);})();</script>',
        "crisp",
        FOUND_CHAT,
    ),
    ("crisp name only", '<script>window.$crisp = []; window.CRISP_WEBSITE_ID = "0000";</script>', "crisp", FOUND_CHAT),
    (
        "zendesk",
        '<script id="ze-snippet" src="https://static.zdassets.com/ekr/snippet.js?key=0000-1111"></script>',
        "zendesk",
        FOUND_CHAT,
    ),
    (
        "zopim",
        '<script>window.$zopim||(function(d,s){var z=$zopim=function(c){z._.push(c)},$=z.s=d.createElement(s),'
        'e=d.getElementsByTagName(s)[0];z.set=function(o){z.set._.push(o)};z._=[];z.set._=[];$.async=!0;'
        '$.setAttribute("charset","utf-8");$.src="https://v2.zopim.com/?0000";z.t=+new Date;$.type="text/javascript";'
        'e.parentNode.insertBefore($,e)})(document,"script");</script>',
        "zendesk",
        FOUND_CHAT,
    ),
    (
        "tawk.to",
        "<script>var Tawk_API=Tawk_API||{}, Tawk_LoadStart=new Date();(function(){var s1=document.createElement(\"script\"),"
        "s0=document.getElementsByTagName(\"script\")[0];s1.async=true;s1.src='https://embed.tawk.to/0000/default';"
        "s0.parentNode.insertBefore(s1,s0);})();</script>",
        "tawk.to",
        FOUND_CHAT,
    ),
    ("tawk.to name only", "<script>var Tawk_API = Tawk_API || {};</script>", "tawk.to", FOUND_CHAT),
    ("callbell", '<script src="https://dash.callbell.eu/include/0000.js" async></script>', "callbell", FOUND_WHATSAPP),
    ("wati host", '<script src="https://cdn.wati.io/widget.js" async></script>', "wati", FOUND_WHATSAPP),
    (
        "wati loader",
        "<script>var url = 'https://widgets.proveedor.test/v2/watiWidget.js?1234'; var s = document.createElement('script');"
        " s.src = url; document.head.appendChild(s);</script>",
        "wati",
        FOUND_WHATSAPP,
    ),
    (
        "joinchat from a CDN",
        '<script src="https://cdn.estaticos.test/creame/joinchat@5.1/public/js/joinchat.min.js" defer></script>',
        "joinchat",
        FOUND_WHATSAPP,
    ),
    (
        "click to chat",
        '<script src="https://www.colegio.test/wp-content/plugins/click-to-chat-for-whatsapp/new/inc/assets/js/app.js">'
        "</script>",
        "click-to-chat",
        FOUND_WHATSAPP,
    ),
    ("ht-ctc", '<script src="https://cdn.estaticos.test/js/ht-ctc-app.min.js"></script>', "click-to-chat", FOUND_WHATSAPP),
    ("chaty hosted", '<script src="https://cdn.chaty.app/pixel.js?id=abc123" async></script>', "chaty", FOUND_WHATSAPP),
    (
        "chaty plugin",
        '<script src="https://www.colegio.test/wp-content/plugins/chaty/js/cht-front-script.min.js"></script>',
        "chaty",
        FOUND_WHATSAPP,
    ),
    (
        "wa.link button script",
        '<script>document.getElementById("boton").onclick = function () { window.open("https://wa.link/abc123"); };</script>',
        "wa.link",
        FOUND_WHATSAPP,
    ),
    (
        "another whatsapp plugin",
        '<script src="https://www.colegio.test/wp-content/plugins/boton-whatsapp/assets/js/boton.js"></script>',
        "whatsapp",
        FOUND_WHATSAPP,
    ),
)


class WidgetFamiliesTest(unittest.TestCase):
    def test_control_the_bare_home_fails(self) -> None:
        f = vis15("")
        self.assertEqual(f.state, State.FALLA)
        self.assertIsNone(f.measured["plugin_marker"])

    def test_each_family_turns_the_failure_into_an_observation(self) -> None:
        for case, html, marker, found in FAMILIES:
            with self.subTest(case):
                control = vis15("")
                self.assertEqual(control.state, State.FALLA, "control: the same home without the widget")
                f = vis15(html)
                self.assertEqual(f.state, State.APROBADO_CON_OBSERVACION)
                self.assertEqual(f.measured["plugin_marker"], marker)
                self.assertEqual(f.phrase_report.found, found)

    def test_a_real_link_still_wins_over_the_widget(self) -> None:
        # The widget changes nothing when the home has a tel: link in the footer (APROBADO, as before).
        html = '<footer><a href="tel:+541100000000">0000-0000</a></footer><script src="https://code.tidio.co/abc.js"></script>'
        f = vis15(html)
        self.assertEqual((f.state, f.measured["plugin_marker"]), (State.APROBADO, "tidio"))
        control = vis15('<footer><a href="tel:+541100000000">0000-0000</a></footer>')
        self.assertEqual((control.state, control.measured["plugin_marker"]), (State.APROBADO, None))


# ---------------------------------------------------------------------------
# the page text never counts
# ---------------------------------------------------------------------------


class PageTextTest(unittest.TestCase):
    def test_text_that_names_a_widget_stays_a_failure(self) -> None:
        cases = {
            "text": "<p>Respondemos consultas por el chat de Tidio.</p>",
            "text with the host": "<p>El chat (code.tidio.co, tawk.to o crisp.chat) atiende de 8 a 16.</p>",
            "a link to the vendor": '<p><a href="https://www.tidio.com/">Tidio</a></p>',
            "a script that names it without loading it": '<script>var proveedorDeChat = "tidio";</script>',
            "a longer host name": '<script src="https://cdn.notidio.co.test/chat.js"></script>',
            "the host inside another name": '<script src="https://tidio.co.colegio.test/chat.js"></script>',
            "a file named after it on the school's host": '<script src="https://www.colegio.test/js/tidio.js"></script>',
            "structured data": '<script type="application/ld+json">{"@type":"School","sameAs":["https://embed.tawk.to/x"]}</script>',
        }
        for case, html in cases.items():
            with self.subTest(case):
                f = vis15(html)
                self.assertEqual(f.state, State.FALLA)
                self.assertIsNone(f.measured["plugin_marker"])
        # Control: the same vendor loaded by a script is a marker.
        self.assertEqual(vis15('<script src="https://code.tidio.co/abc.js"></script>').state, State.APROBADO_CON_OBSERVACION)


# ---------------------------------------------------------------------------
# end to end, a site whose only button is an Elfsight script
# ---------------------------------------------------------------------------

TEL_FOOTER = '<p>Tel: <a href="tel:+541100000000">0000-0000</a></p>\n'
ELFSIGHT = (
    '<script src="https://elfsightcdn.com/platform.js" async></script>\n'
    '<div class="elfsight-app-0a1b2c3d-4e5f-6789-abcd-ef0123456789" data-elfsight-app-lazy></div>\n</body>'
)


def _no_button_scenario(*extra: tuple[str, str]):  # type: ignore[no-untyped-def]
    """The school with no WhatsApp, no tel: link and no share image (VIS-06 fails too)."""
    options = SchoolOptions(whatsapp=None, broken_link=False, og_image=False)
    return with_home(options, (TEL_FOOTER, ""), *extra)


class ElfsightEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.control = run_e2e(_no_button_scenario(), default_apis())
        cls.widget = run_e2e(_no_button_scenario(("</body>", ELFSIGHT)), default_apis())


    def test_the_widget_host_is_never_requested(self) -> None:
        self.assertTrue(self.widget.site_urls, "control: the fake site was read")
        self.assertEqual([u for u in self.widget.site_urls if "elfsight" in u], [])


if __name__ == "__main__":
    unittest.main()
