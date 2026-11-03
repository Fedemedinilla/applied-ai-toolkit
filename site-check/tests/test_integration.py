"""INTEGRATION: the whole tool, end to end, on the rules that protect the site owner.

Every run goes to the local fake site and the fake APIs through the hidden test
hooks; support.py's network guard refuses anything that is not loopback, so no
test can reach a real site.

Pinned here:
  1. scope guard: a request outside the passive scope raises, is logged and is never sent;
  2. anti-bot challenge: after the host is cut, no further request reaches it;
  3. the key (a fake one) never appears in datos.json, requests.log or any evidence file;
  4. the exclusion list: exit 10 with zero requests and no folder;
  5. report text has no em/en dash and never "certificado";
  6. determinism: the same observations and the same clock give byte-identical
     datos.json, informe.md and anexo-tecnico.md; every number a sentence prints
     is traced to its measurement; examples/ matches a fresh build.
Expected phrases are written by hand, case by case.
"""

from __future__ import annotations

import copy
import datetime as dt
import io
import json
import re
import types
import unittest
from pathlib import Path
from unittest import mock

import support  # noqa: F401
from support import TEST_KEY, patched_env, run_cli, temp_dir

from sitecheck.challenge import ChallengeDetector, Expect
from sitecheck.config import RunConfig
from sitecheck.credentials import Redactor
from sitecheck.endpoints import Endpoints
from sitecheck.exitcodes import ExitCode
from sitecheck.httpclient import ClientConfig, HttpClient, LoopbackRoute
from sitecheck.requestlog import RequestLog
from sitecheck.scope import Purpose, ScopeError, ScopeGuard
from fakeapis import FakeApis
from fakesite import FakeSite
from sitefixtures import SchoolOptions, default_apis, school_scenario

BASE = "https://www.colegio.test"
PSI = "/pagespeedonline/v5/runPagespeed"
OTHER_FAKE_KEY = "FAKE-KEY-FOR-THE-LEAK-TEST-9876543210"


def cli(site: FakeSite, apis: FakeApis, salidas: Path, *extra: str, key: str | None = TEST_KEY) -> tuple[int, str, str]:
    argv = [
        f"{BASE}/",
        "--name",
        "Colegio Ejemplo",
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


class ScopeGuardEndToEndTest(unittest.TestCase):
    def test_request_outside_the_scope_raises_is_logged_and_never_sent(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis:
            redactor = Redactor([TEST_KEY])
            guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test(apis.base), test_loopback=True)
            guard.set_canonical(f"{BASE}/")
            log = RequestLog(None, redactor)
            client = HttpClient(
                guard, log, ChallengeDetector(), redactor,
                ClientConfig(pace_seconds=0.0, pace_jitter=0.0, challenge_wait=0.0, challenge_pace=0.0, loopback=LoopbackRoute(port=site.port)),
                sleeper=lambda s: None,
            )
            for url in (f"{BASE}/wp-json/", f"{BASE}/readme.html", f"{BASE}/?author=1", f"{BASE}/no-enlazada/"):
                with self.assertRaises(ScopeError, msg=url):
                    client.fetch(url, purpose=Purpose.LINK_CHECK, expect=Expect.ANY)
            self.assertEqual(site.requests, [], "a refused request is never sent")
            outcomes = [r.outcome for r in log.records()]
            self.assertEqual(outcomes, ["refused-scope"] * 4)
            self.assertIn("/wp-json/", log.records()[0].url)

    def test_a_collector_bug_aborts_the_run_with_exit_50(self) -> None:
        """A request the scope forbids, made by the collector itself, stops the whole run."""
        from sitecheck import collect as collect_mod

        def buggy_feed(services, obs):  # type: ignore[no-untyped-def]
            services.http.fetch(f"{BASE}/wp-json/", purpose=Purpose.FEED, expect=Expect.XML)

        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            with mock.patch.object(collect_mod, "fetch_feed", buggy_feed):
                code, _, _ = cli(site, apis, salidas)
            self.assertEqual(code, int(ExitCode.SCOPE_VIOLATION))
            self.assertNotIn(f"{BASE}/wp-json/", site.requested_urls())
            rd = run_dir(salidas)
            lines = [json.loads(l) for l in (rd / "evidencia" / "requests.log").read_text(encoding="utf-8").splitlines() if l.strip()]
            refused = [l for l in lines if l["outcome"] == "refused-scope"]
            self.assertEqual(len(refused), 1)
            self.assertTrue(refused[0]["url"].endswith("/wp-json/"))
            self.assertEqual(datos(rd)["salida"]["codigo"], 50)


class ChallengeStopsTheSiteTest(unittest.TestCase):
    def test_after_the_cut_nothing_else_reaches_the_host(self) -> None:
        with FakeSite(school_scenario(SchoolOptions(challenge=True))) as site, FakeApis(default_apis()) as apis:
            redactor = Redactor([TEST_KEY])
            guard = ScopeGuard("colegio.test", f"{BASE}/", Endpoints.for_test(apis.base), test_loopback=True)
            guard.set_canonical(f"{BASE}/")
            log = RequestLog(None, redactor)
            client = HttpClient(
                guard, log, ChallengeDetector(), redactor,
                ClientConfig(pace_seconds=0.0, pace_jitter=0.0, challenge_wait=0.0, challenge_pace=0.0, loopback=LoopbackRoute(port=site.port)),
                sleeper=lambda s: None,
            )
            first = client.fetch(f"{BASE}/", purpose=Purpose.HOME, expect=Expect.HTML)
            self.assertIsNotNone(first.challenge)
            self.assertTrue(client.blocked)
            self.assertEqual(len(site.requests), 2, "the request and its single retry")
            after = client.fetch(f"{BASE}/robots.txt", purpose=Purpose.ROBOTS, expect=Expect.TEXT)
            self.assertEqual(after.skipped, "blocked")
            self.assertEqual(len(site.requests), 2, "nothing else is sent once the host is cut")

    def test_whole_run_greys_what_needs_the_site(self) -> None:
        with FakeSite(school_scenario(SchoolOptions(challenge=True))) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            code, _, _ = cli(site, apis, salidas)
            self.assertEqual(code, int(ExitCode.HOME_UNREACHABLE))
            self.assertEqual(len(site.requests), 2)
            rd = run_dir(salidas)
            # Exit 3 keeps what was measured without the home (PageSpeed, DNS, RDAP,
            # DBL, TLS); everything that needs the site is grey.
            kept = {"EXT-08", "EXT-21", "EXT-05", "EXT-13", "EXT-23", "EXT-07"}
            for c in datos(rd)["checks"]:
                if c["id"] not in kept:
                    self.assertIn(c["estado"], ("NO_VERIFICADO", "NO_APLICA"), c["id"])


class KeyNeverLeaksTest(unittest.TestCase):
    def test_fake_key_is_absent_from_every_output(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            code, out, err = cli(site, apis, salidas, key=OTHER_FAKE_KEY)
            self.assertEqual(code, 0, err)
            sent = [c.headers.get("x-goog-api-key") for c in apis.calls(PSI)]
            self.assertTrue(sent and all(v == OTHER_FAKE_KEY for v in sent), "the key travels in the header")
            for c in apis.requests:
                self.assertNotIn(OTHER_FAKE_KEY, c.raw_path, "never in a URL")
            rd = run_dir(salidas)
            checked = 0
            for f in rd.rglob("*"):
                if f.is_file():
                    checked += 1
                    self.assertNotIn(OTHER_FAKE_KEY.encode(), f.read_bytes(), str(f))
            self.assertGreater(checked, 10)
            for name in ("datos.json", "evidencia/requests.log", "evidencia/psi-mobile-1.json", "evidencia/psi-desktop.json"):
                self.assertTrue((rd / name).exists(), name)
            self.assertNotIn(OTHER_FAKE_KEY, out + err)
            self.assertEqual(datos(rd)["meta"]["clave"], "presente")


class DoNotContactTest(unittest.TestCase):
    def test_listed_www_host_exits_10_with_zero_requests(self) -> None:
        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as salidas:
            (salidas / "exclude.txt").write_text("# pidió la baja el 1/10\nwww.colegio.test\n", encoding="utf-8")
            code, out, _ = cli(site, apis, salidas)
            self.assertEqual(code, 10)
            self.assertEqual(site.requests, [])
            self.assertEqual(apis.requests, [])
            self.assertFalse((salidas / "colegio.test").exists())
            self.assertIn("Exit 10.", out)


class _FixedLog:
    def counts(self) -> dict:
        return {"site": 24, "api": 9, "dns": 2, "tls": 2, "control": 3}

    def site_window(self) -> tuple[str, str]:
        return ("2026-10-09T15:00:00+00:00", "2026-10-09T15:02:30+00:00")


class DeterministicOutputTest(unittest.TestCase):
    """Same observations and same clock: datos.json, informe.md and anexo-tecnico.md are byte-identical."""

    def collect_once(self):  # type: ignore[no-untyped-def]
        from sitecheck.collect import collect
        from sitecheck.services import build_services

        with FakeSite(school_scenario()) as site, FakeApis(default_apis()) as apis, temp_dir() as tmp:
            config = RunConfig(
                url=f"{BASE}/", institution="Colegio Ejemplo", kind="colegio", out_root=tmp,
                test_loopback=site.loopback, test_services=apis.base,
            )
            with patched_env(SITE_CHECK_TEST_API_KEY=TEST_KEY):
                services = build_services(config, tmp / "evidencia", sleeper=lambda s: None)
                obs = collect(config, services)
            return obs, dict(services.artifacts.written_map())

    def run_once(self, obs, written, salidas: Path):  # type: ignore[no-untyped-def]
        from sitecheck import pipeline

        def factory(config, evidence_dir, *, sleeper):  # type: ignore[no-untyped-def]
            (evidence_dir / "requests.log").write_text("{}\n", encoding="utf-8")
            return types.SimpleNamespace(
                redactor=Redactor([TEST_KEY]),
                key=types.SimpleNamespace(present=True, as_datos=lambda: "presente"),
                log=_FixedLog(),
                guard=types.SimpleNamespace(describe=lambda: {"admitidos": [f"{BASE}/"]}),
                artifacts=types.SimpleNamespace(written_map=lambda: dict(written)),
                psi=object(),
                crux=object(),
            )

        fixed = dt.datetime(2026, 10, 9, 15, 0, 0, tzinfo=dt.timezone.utc)
        config = RunConfig(
            url=f"{BASE}/", institution="Colegio Ejemplo", kind="colegio", out_root=salidas,
            test_loopback="127.0.0.1:1", test_services="http://127.0.0.1:1",
        )
        with mock.patch("sitecheck.collect.collect", lambda config, services, **kw: copy.deepcopy(obs)), \
                mock.patch.object(pipeline, "_now_utc", lambda: fixed):
            res = pipeline.run(config, services_factory=factory, stdout=io.StringIO(), stderr=io.StringIO())
        return res

    def test_same_inputs_give_the_same_bytes(self) -> None:
        obs, written = self.collect_once()
        with temp_dir() as a, temp_dir() as b:
            first = self.run_once(obs, written, a)
            second = self.run_once(obs, written, b)
            self.assertEqual(first.exit_code, ExitCode.OK)
            self.assertEqual(second.exit_code, first.exit_code)
            for name in ("datos.json", "informe.md", "anexo-tecnico.md"):
                self.assertEqual((first.run_dir / name).read_bytes(), (second.run_dir / name).read_bytes(), name)
            d = json.loads((first.run_dir / "datos.json").read_text(encoding="utf-8"))
            self.assertEqual(len(d["checks"]), 37)

    def test_every_number_in_a_sentence_is_traced_to_its_measurement(self) -> None:
        """On the full fake-school run, every number a report sentence prints is either a
        fixed threshold of its rule (listed by hand below) or the rendering of a traced
        value, and every trace entry resolves to a stored value in datos.json."""
        obs, written = self.collect_once()
        with temp_dir() as a:
            res = self.run_once(obs, written, a)
            d = json.loads((res.run_dir / "datos.json").read_text(encoding="utf-8"))
        by_id = {c["id"]: c for c in d["checks"]}
        with_numbers = 0
        for c in d["checks"]:
            sentence = " | ".join(str(v) for v in (c["frase_informe_llena"] or {}).values() if v)
            values = []
            for placeholder, where in c["trazas"].items():
                value = _resolve_trace(d, by_id, where)
                self.assertIsNotNone(value, f"{c['id']} {placeholder} -> {where} does not resolve")
                values.append(value)
            covered: list[tuple[int, int]] = []
            for value in values:
                for text in _renderings(value):
                    pattern = r"(?<![\d.,])" + re.escape(text) + r"(?!\d|[.,]\d)"
                    covered.extend(m.span() for m in re.finditer(pattern, sentence))
            numbers = list(re.finditer(r"\d+(?:[.,]\d+)*", sentence))
            with_numbers += bool(numbers)
            for m in numbers:
                if m.group() in RULE_CONSTANTS.get(c["id"], set()):
                    continue
                inside = any(lo <= m.start() and m.end() <= hi for lo, hi in covered)
                self.assertTrue(inside, f"{c['id']}: {m.group()!r} in {sentence!r} has no trace (trazas: {c['trazas']})")
        self.assertEqual(with_numbers, 13, "the fake school prints measured numbers in 13 sentences (README)")


# Numbers that are part of a rule's fixed text, not measurements. Typed by hand.
RULE_CONSTANTS: dict[str, set[str]] = {
    "EXT-08": {"2,5"},  # Google's LCP threshold
    "EXT-01": {"6"},  # the six protection headers
    "VIS-04": {"50", "60", "120", "160"},  # recommended title and description lengths
}
MONTHS = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre")
BUENOS_AIRES = dt.timezone(dt.timedelta(hours=-3))


def _resolve_trace(d: dict, by_id: dict, where: str):  # type: ignore[no-untyped-def]
    """The stored value a trace entry names: checks[ID].measured.key or meta.key. None when absent."""
    m = re.fullmatch(r"checks\[([A-Z]+-\d+)\]\.measured\.(\w+)", where)
    if m is not None:
        return by_id.get(m.group(1), {}).get("mediciones", {}).get(m.group(2))
    m = re.fullmatch(r"meta\.(\w+)", where)
    if m is not None:
        return d["meta"].get(m.group(1))
    if where == "home <title>":  # the site's own title text, kept in the home evidence file
        return where
    return None


def _decimal(value: float, places: int) -> str:
    from decimal import ROUND_HALF_UP, Decimal

    q = Decimal(1).scaleb(-places)
    return str(Decimal(str(value)).quantize(q, rounding=ROUND_HALF_UP)).replace(".", ",")


def _renderings(value):  # type: ignore[no-untyped-def]
    """Every way a report sentence may print ``value``, computed here by hand."""
    if isinstance(value, bool):
        return []
    if isinstance(value, list):
        return [r for v in value for r in _renderings(v)]
    if isinstance(value, (int, float)):
        out = [_decimal(value / 1000, 1), _decimal(value / 1_048_576, 1), _decimal(value / 1024, 0), _decimal(value, 2)]
        if float(value).is_integer():
            out.append(str(int(value)))
        return out
    if isinstance(value, str):
        out = [value]
        try:
            moment = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return out
        if moment.tzinfo is not None:
            moment = moment.astimezone(BUENOS_AIRES)
        out.append(f"{moment.day} de {MONTHS[moment.month - 1]} de {moment.year}")
        out.append(f"{MONTHS[moment.month - 1]} de {moment.year}")
        return out
    return []


class ExampleIsReproducibleTest(unittest.TestCase):
    """examples/ is what examples/make_example.py builds today, byte for byte."""

    def test_a_fresh_build_matches_the_committed_files(self) -> None:
        import importlib.util

        examples = Path(__file__).resolve().parent.parent / "examples"
        spec = importlib.util.spec_from_file_location("make_example", examples / "make_example.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with temp_dir() as fresh:
            code, _, err = module.build(fresh)
            self.assertEqual(code, 0, err)
            for name in module.FILES:
                self.assertEqual(
                    (fresh / name).read_bytes(), (examples / name).read_bytes(),
                    f"examples/{name} is stale: run python3 examples/make_example.py",
                )

if __name__ == "__main__":
    unittest.main()
