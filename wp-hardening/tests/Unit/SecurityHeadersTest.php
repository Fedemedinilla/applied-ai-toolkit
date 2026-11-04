<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Filters;
use Brain\Monkey\Functions;
use WpHardening\Controls\SecurityHeaders;
use WpHardening\Controls\ServerRules;
use WpHardening\Env\Paths;
use WpHardening\Integrations;
use WpHardening\Settings;
use WpHardening\State;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\FakeHeaders;
use WpHardening\Tests\TestCase;

final class SecurityHeadersTest extends TestCase
{
    /**
     * @param array<string, mixed> $settings
     * @param array<string, mixed> $constants
     */
    private function control(array $settings = [], ?FakeHeaders $headers = null, array $constants = []): SecurityHeaders
    {
        $s = Settings::fromArray($settings);
        return new SecurityHeaders($s, $headers ?? new FakeHeaders(), new Integrations(new FakeConstants($constants), $s));
    }

    public function testDefaultsOverHttps(): void
    {
        self::assertSame([
            'Strict-Transport-Security' => 'max-age=15552000',
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'strict-origin-when-cross-origin',
            'X-Frame-Options' => 'SAMEORIGIN',
            'Content-Security-Policy-Report-Only' => Settings::DEFAULT_CSP,
        ], $this->control()->headers(true));
    }

    public function testGuardNoHstsOverHttpOrWithZeroAge(): void
    {
        self::assertArrayNotHasKey('Strict-Transport-Security', $this->control()->headers(false));
        self::assertArrayNotHasKey('Strict-Transport-Security', $this->control(['hsts_max_age' => 0])->headers(true));
    }

    public function testGuardSubdomainsAndPreloadOnlyWhenTurnedOn(): void
    {
        self::assertSame('max-age=15552000; includeSubDomains', $this->control(['hsts_subdomains' => '1'])->headers(true)['Strict-Transport-Security']);
        $preload = $this->control(['hsts_subdomains' => '1', 'hsts_preload' => '1', 'hsts_max_age' => 31536000]);
        self::assertSame('max-age=31536000; includeSubDomains; preload', $preload->headers(true)['Strict-Transport-Security']);
        $tooShort = $this->control(['hsts_subdomains' => '1', 'hsts_preload' => '1', 'hsts_max_age' => 86400]);
        self::assertStringNotContainsString('preload', $tooShort->headers(true)['Strict-Transport-Security']);
    }

    public function testGuardTheCspIsOnlyEverReportOnly(): void
    {
        $headers = $this->control()->headers(true);
        self::assertArrayNotHasKey('Content-Security-Policy', $headers);
        Filters\expectApplied('wp_hardening_headers')->andReturnUsing(static function (array $h): array {
            $h['Content-Security-Policy'] = "default-src 'none'";
            $h['content-security-policy'] = "default-src 'none'";
            return $h;
        });
        $filtered = $this->control()->headers(true);
        self::assertArrayNotHasKey('Content-Security-Policy', $filtered);
        self::assertArrayNotHasKey('content-security-policy', $filtered);
    }

    public function testReportUriIsAppended(): void
    {
        $csp = $this->control(['csp_report_uri' => 'https://report.example/csp'])->headers(true)['Content-Security-Policy-Report-Only'];
        self::assertStringEndsWith("frame-ancestors 'self'; report-uri https://report.example/csp", $csp);
        self::assertArrayNotHasKey('Content-Security-Policy-Report-Only', $this->control(['csp_report_only' => ''])->headers(true));
    }

    public function testAFilterCannotInjectALineBreak(): void
    {
        Filters\expectApplied('wp_hardening_headers')->andReturnUsing(static fn (array $h): array => [...$h, 'X-Test' => "a\r\nSet-Cookie: x=1", 'Permissions-Policy' => 'camera=()']);
        $headers = $this->control()->headers(true);
        self::assertArrayNotHasKey('X-Test', $headers);
        self::assertSame('camera=()', $headers['Permissions-Policy']);
    }

    public function testGuardAHeaderAnotherLayerSetIsNotSentTwice(): void
    {
        $sink = new FakeHeaders(['x-frame-options', 'Strict-Transport-Security']);
        $this->control([], $sink)->send();
        self::assertArrayNotHasKey('X-Frame-Options', $sink->out);
        self::assertArrayNotHasKey('Strict-Transport-Security', $sink->out);
        self::assertSame('nosniff', $sink->out['X-Content-Type-Options']);
    }

    /** Other sites frame /embed/ views on purpose; X-Frame-Options there would blank the post card. */
    public function testGuardNoFrameOptionsOnEmbedViews(): void
    {
        $sink = new FakeHeaders();
        $this->control([], $sink)->send((object) ['query_vars' => ['embed' => 'post', 'name' => 'hello']]);
        self::assertArrayNotHasKey('X-Frame-Options', $sink->out);
        self::assertSame('nosniff', $sink->out['X-Content-Type-Options']);

        $page = new FakeHeaders();
        $this->control([], $page)->send((object) ['query_vars' => ['name' => 'hello']]);
        self::assertSame('SAMEORIGIN', $page->out['X-Frame-Options']);
        self::assertFalse(SecurityHeaders::isEmbed(null));
    }

    /** headers_list() cannot see what Apache adds, so the root .htaccess is read for the same names. */
    public function testServerSetHeadersMakeTheReportRecommended(): void
    {
        $root = $this->tempDir();
        $s = Settings::fromArray([]);
        $integrations = new Integrations(new FakeConstants(), $s);
        $rules = new ServerRules(new Paths($root, $root, $root . '/uploads', $root . '/mu'), $integrations, []);
        $control = new SecurityHeaders($s, new FakeHeaders(), $integrations, $rules);
        self::assertSame(State::Good, $control->report(true)->state);
        file_put_contents($root . '/.htaccess', "Header always set X-Frame-Options \"SAMEORIGIN\"\n");
        $report = $control->report(true);
        self::assertSame(State::Recommended, $report->state);
        self::assertStringContainsString('X-Frame-Options', $report->summary);
        self::assertStringContainsString('X-Frame-Options', implode(' ', $control->plan()));
    }

    public function testNothingIsSentAfterOutputStarted(): void
    {
        $sink = new FakeHeaders([], false);
        $this->control([], $sink)->send();
        self::assertSame([], $sink->out);
    }

    public function testSendUsesTheRequestScheme(): void
    {
        Functions\when('is_ssl')->justReturn(false);
        $sink = new FakeHeaders();
        $this->control([], $sink)->send();
        self::assertArrayNotHasKey('Strict-Transport-Security', $sink->out);
    }

    public function testRegisterCoversPagesDashboardAndLogin(): void
    {
        $control = $this->control();
        $control->register();
        foreach (['send_headers', 'admin_init', 'login_init'] as $hook) {
            self::assertNotFalse(has_action($hook, [$control, 'send']), $hook);
        }
    }

    public function testReportNamesAPageBuilder(): void
    {
        $control = $this->control([], null, ['ELEMENTOR_VERSION' => '3.0.0']);
        $report = $control->report(true);
        self::assertSame(State::Good, $report->state);
        self::assertStringContainsString('Elementor', implode(' ', $report->details));
        self::assertStringContainsString('never enforces', implode(' ', $control->plan()));
        self::assertSame(State::Recommended, $control->report(false)->state);
    }
}
