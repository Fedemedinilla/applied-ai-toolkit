"""END TO END: the real CLI against the local fake site and the fake APIs.

Scenarios: a fictional school with typical problems, an anti-bot challenge from
the first request, a domain on the exclusion list, a keyless PageSpeed quota,
the hack gate and --rerender. Every run uses the hidden test hooks, so nothing
leaves 127.0.0.1 (and support.py's network guard would refuse it anyway).

Expected values for the default school (sitefixtures.school_scenario +
default_apis), written by hand:
  EXT-05 FALLA (no DMARC, Rojo); EXT-08 FALLA (field LCP 4,8 s, Amarillo);
  EXT-02 FALLA (WordPress 6.1.1 visible); VIS-16 FALLA (footer 2019 + last news
  of May 2024); VIS-09 FALLA (one 404 among 8 links); VIS-06, VIS-15, VIS-17,
  VIS-18 and VIS-01 pass. Exit 0.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import support  # noqa: F401
from support import TEST_KEY, patched_env, run_cli, temp_dir

from fakeapis import FakeApis
from fakesite import FakeSite
from sitefixtures import SchoolOptions, default_apis, school_scenario

BASE = "https://www.colegio.test"
PSI = "/pagespeedonline/v5/runPagespeed"


def cli(site: FakeSite, apis: FakeApis, salidas: Path, *extra: str, key: str | None = TEST_KEY) -> tuple[int, str, str]:
    argv = [
        f"{BASE}/",
        "--name",
        "Colegio Ejemplo",
        "--kind",
        "colegio",
        "--out",
        str(salidas),
        "--test-loopback",
        site.loopback,
        "--test-services",
        apis.base,
        *extra,
    ]
    with patched_env(SITE_CHECK_TEST_API_KEY=key, PAGESPEED_API_KEY="REAL-KEY-MUST-NEVER-BE-USED-000"):
        return run_cli(argv)


def run_dir(salidas: Path) -> Path:
    dirs = sorted((salidas / "colegio.test").iterdir())
    assert len(dirs) == 1, dirs
    return dirs[0]


def datos(rd: Path) -> dict:
    return json.loads((rd / "datos.json").read_text(encoding="utf-8"))


def check(d: dict, cid: str) -> dict:
    return next(c for c in d["checks"] if c["id"] == cid)


class EndToEndTest(unittest.TestCase):

    def test_school_run_writes_the_report_the_annex_and_the_evidence(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            code, out, err = cli(site, apis, salidas)
            self.assertEqual(code, 0, err)
            rd = run_dir(salidas)
            for name in ("datos.json", "informe.md", "anexo-tecnico.md", "00-tiempo.txt", "evidencia/requests.log", "evidencia/home.html"):
                self.assertTrue((rd / name).exists(), name)
            self.assertEqual(sorted(p.name for p in rd.iterdir() if p.is_file()), ["00-tiempo.txt", "anexo-tecnico.md", "datos.json", "informe.md"])

            informe = (rd / "informe.md").read_text(encoding="utf-8")
            self.assertTrue(informe.startswith("**Colegio Ejemplo · Estado del sitio colegio.test**\n\nFecha: "))
            self.assertIn(
                "**36 chequeos aplicables:** ▲ 1 para arreglar ya · ■ 6 para revisar · ◆ 6 mejoras opcionales · "
                "● 19 bien · ○ 4 que no se pudieron ver.",
                informe,
            )
            self.assertIn(
                "1. El correo del dominio no tiene la regla que les dice a Gmail y a Outlook qué hacer con los mails "
                "falsos.",
                informe,
            )
            self.assertIn(
                "| El pie dice 2019 y la última novedad es de hace ",
                informe,
            )
            self.assertIn(
                "**Próximo paso recomendado:** Corregir primero lo marcado para arreglar ya y para revisar, porque el "
                "correo del dominio no tiene la regla que les dice a Gmail y a Outlook qué hacer con los mails falsos.",
                informe,
            )
            self.assertIn("Se hicieron 24 pedidos a su sitio en 1 minuto, de a uno por vez y con pausas.", informe)
            annex = (rd / "anexo-tecnico.md").read_text(encoding="utf-8")
            self.assertIn("## Enlaces de la página principal que llevan a páginas que no existen", annex)
            self.assertIn("| EXT-05 | FALLA | ▲ Arreglar ya |", annex)
            self.assertIn("Report: ", out)

            d = datos(rd)
            self.assertEqual(d["schema_version"], 1)
            self.assertEqual(d["meta"]["clave"], "presente")
            self.assertEqual(d["salida"]["codigo"], 0)
            self.assertEqual(d["senales_hackeo"], [])
            self.assertEqual(len(d["checks"]), 37)
            self.assertEqual((check(d, "EXT-05")["estado"], check(d, "EXT-05")["color_final"]), ("FALLA", "rojo"))
            self.assertEqual((check(d, "EXT-08")["estado"], check(d, "EXT-08")["color_final"]), ("FALLA", "amarillo"))
            self.assertEqual(check(d, "EXT-02")["estado"], "FALLA")
            self.assertEqual(check(d, "VIS-16")["estado"], "FALLA")
            self.assertEqual(check(d, "VIS-09")["mediciones"]["n404"], 1)
            self.assertEqual(check(d, "VIS-06")["estado"], "APROBADO")
            self.assertEqual(check(d, "EXT-23")["estado"], "NO_VERIFICADO")
            self.assertEqual(check(d, "EXT-24")["estado"], "NO_VERIFICADO")
            res = d["resumen"]
            self.assertEqual(res["aplicables"], sum(res["por_color"].values()))

    def test_no_personal_data_in_the_outputs(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            cli(site, apis, salidas)
            rd = run_dir(salidas)
            site_email = r"[\w.+-]+@[\w-]+\.[\w.]+"
            for name in ("informe.md", "anexo-tecnico.md"):
                text = (rd / name).read_text(encoding="utf-8")
                self.assertNotIn("info@colegio.test", text, name)
                self.assertNotIn("5491123456789", text, name)
                self.assertNotIn("Juana Titular", text, name)
                self.assertIsNone(re.search(site_email, text), name)
            # datos.json: the institution's role address info@ is VIS-21's measured data, and nothing else of the
            # site is an address.
            text = (rd / "datos.json").read_text(encoding="utf-8")
            self.assertEqual(re.findall(site_email, text), ["info@colegio.test"])
            self.assertNotIn("5491123456789", text)
            self.assertNotIn("Juana Titular", text)
            d = json.loads(text)
            vis21 = next(c for c in d["checks"] if c["id"] == "VIS-21")
            self.assertEqual(vis21["estado"], "APROBADO")
            self.assertEqual(
                vis21["mediciones"]["dominios"],
                [{"dominio": "colegio.test", "paginas": ["inicio"], "veredicto": "recibe-mx", "direccion": "info@colegio.test"}],
            )
            # Control: without that one value, datos.json carries no address of the site.
            del vis21["mediciones"]["dominios"][0]["direccion"]
            self.assertIsNone(re.search(site_email, json.dumps(d, ensure_ascii=False)))
            for f in rd.rglob("*"):
                if f.is_file():
                    self.assertNotIn(b"Juana Titular", f.read_bytes(), str(f))

    def test_report_text_control(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            cli(site, apis, salidas)
            rd = run_dir(salidas)
            for name in ("informe.md", "anexo-tecnico.md"):
                text = (rd / name).read_text(encoding="utf-8")
                for bad in ("\u2014", "\u2013", "certificado", "Certificado", "pendiente", "insecure", "tenés", "podés"):
                    self.assertNotIn(bad, text, f"{name}: {bad!r}")
                self.assertIsNone(re.search(r"\{[a-z_][a-z0-9_]*\}", text), name)
            self.assertEqual(datos(rd)["salida"]["control_texto"], [])

    def test_nothing_outside_the_scope_and_psi_first(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            cli(site, apis, salidas)
            self.assertEqual(site.forbidden_hits(), [])
            self.assertEqual(site.outside_allowed(), [])
            self.assertLess(max(c.t for c in apis.calls(PSI)), site.first_time())
            self.assertLessEqual(len(site.requests), 90)

    def test_key_never_leaks_and_real_key_is_never_used(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            cli(site, apis, salidas)
            for c in apis.calls(PSI):
                self.assertEqual(c.headers.get("x-goog-api-key"), TEST_KEY)
                self.assertNotIn("key=", c.raw_path)
            for r in apis.requests:
                self.assertNotIn("REAL-KEY-MUST-NEVER-BE-USED", json.dumps(r.headers) + r.raw_path)
            for f in run_dir(salidas).rglob("*"):
                if f.is_file():
                    data = f.read_bytes()
                    self.assertNotIn(TEST_KEY.encode(), data, str(f))
                    self.assertNotIn(b"REAL-KEY-MUST-NEVER-BE-USED", data, str(f))


    def test_challenge_from_the_first_request_is_exit_3(self) -> None:
        with FakeSite(school_scenario(SchoolOptions(challenge=True))) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            code, _, _ = cli(site, apis, salidas)
            self.assertEqual(code, 3)
            self.assertEqual(len(site.requests), 2, "first request plus one retry")
            rd = run_dir(salidas)
            self.assertTrue((rd / "datos.json").exists())
            d = datos(rd)
            self.assertTrue(d["meta"]["sitio_cortado"])
            kept = {"EXT-08", "EXT-21", "EXT-05", "EXT-13", "EXT-23", "EXT-07"}  # measured without the home
            for c in d["checks"]:
                if c["id"] not in kept:
                    self.assertIn(c["estado"], ("NO_VERIFICADO", "NO_APLICA"), c["id"])

    def test_an_excluded_domain_gets_no_request_at_all(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            (salidas / "exclude.txt").write_text("# pidió la baja\ncolegio.test\n", encoding="utf-8")
            code, _, _ = cli(site, apis, salidas)
            self.assertEqual(code, 10)
            self.assertEqual(site.requests, [])
            self.assertEqual(apis.requests, [])
            self.assertFalse((salidas / "colegio.test").exists())


    def test_keyless_quota_is_tried_once_and_greys_speed(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis(psi_status=429)) as apis, temp_dir() as salidas:
            code, _, _ = cli(site, apis, salidas, key="")
            psi_calls = apis.calls(PSI)
            self.assertEqual(len(psi_calls), 1, "keyless: one try, a 429 is never retried")
            self.assertNotIn("x-goog-api-key", psi_calls[0].headers)
            d = datos(run_dir(salidas))
            self.assertEqual(d["meta"]["clave"], "ausente")
            self.assertEqual(check(d, "EXT-08")["estado"], "NO_VERIFICADO")
            self.assertEqual(check(d, "EXT-21")["estado"], "NO_VERIFICADO")
            self.assertEqual(code, 0)

    def test_hack_gate_leads_the_report_with_the_compromise(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis(dbl_codes=["127.0.1.4"])) as apis, temp_dir() as salidas:
            code, out, _ = cli(site, apis, salidas)
            self.assertEqual(code, 30)
            rd = run_dir(salidas)
            d = datos(rd)
            self.assertEqual(d["senales_hackeo"], ["EXT-23: Spamhaus DBL 127.0.1.4"])
            informe = (rd / "informe.md").read_text(encoding="utf-8")
            self.assertIn(
                "**Próximo paso recomendado:** Revisar el sitio a fondo, con acceso autorizado, antes de cualquier otro "
                "cambio, porque el dominio está en la lista de bloqueo de Spamhaus.",
                informe,
            )
            self.assertIn("Warning: signs that the site was compromised (EXT-23: Spamhaus DBL 127.0.1.4).", out)

    def test_rerender_makes_no_request_and_rebuilds_the_same_report(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            code1, _, _ = cli(site, apis, salidas)
            rd = run_dir(salidas)
            before = {n: (rd / n).read_bytes() for n in ("informe.md", "anexo-tecnico.md")}
            n_site, n_api = len(site.requests), len(apis.requests)
            code2, _, err = run_cli(["--rerender", str(rd / "datos.json"), "--out", str(salidas)])
            self.assertEqual(code2, code1, err)
            self.assertEqual((len(site.requests), len(apis.requests)), (n_site, n_api))
            for name, data in before.items():
                self.assertEqual((rd / name).read_bytes(), data, name)
            self.assertTrue(any(p.name.startswith("datos-") for p in rd.iterdir()), "the previous datos.json is kept")
            self.assertFalse(any("anterior" in p.name for p in rd.iterdir()), "an unchanged report is not backed up")

    def test_rerender_with_an_override_keeps_the_old_report(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            cli(site, apis, salidas)
            rd = run_dir(salidas)
            before = (rd / "informe.md").read_text(encoding="utf-8")
            overrides = salidas / "ajustes.json"
            overrides.write_text(json.dumps({"EXT-09": {"color": "azul", "motivo": "el hosting ya lo tiene en su plan"}}), encoding="utf-8")
            code, _, err = run_cli(["--rerender", str(rd / "datos.json"), "--overrides", str(overrides)])
            self.assertEqual(code, 0, err)
            self.assertEqual((rd / "informe-anterior-1.md").read_text(encoding="utf-8"), before)
            self.assertEqual(check(datos(rd), "EXT-09")["color_final"], "azul")
            self.assertEqual(check(datos(rd), "EXT-09")["motivo_ajuste"], "el hosting ya lo tiene en su plan")


if __name__ == "__main__":
    unittest.main()
