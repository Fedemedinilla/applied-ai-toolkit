<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use WpHardening\Settings;
use WpHardening\Tests\TestCase;

final class SettingsTest extends TestCase
{
    public function testEveryControlStartsOff(): void
    {
        $settings = Settings::fromArray([]);
        foreach (Settings::CONTROLS as $control) {
            self::assertFalse($settings->enabled($control), $control);
        }
        self::assertSame(15552000, $settings->int('hsts_max_age'));
        self::assertFalse($settings->bool('hsts_subdomains'));
        self::assertFalse($settings->bool('hsts_preload'));
    }

    public function testLoadReadsTheOptionAndSurvivesGarbage(): void
    {
        Functions\when('get_option')->justReturn('not an array');
        self::assertFalse(Settings::load()->enabled('xmlrpc'));

        Functions\when('get_option')->justReturn(['enabled' => ['xmlrpc' => '1']]);
        self::assertTrue(Settings::load()->enabled('xmlrpc'));
    }

    public function testUnknownKeysAndControlsAreDropped(): void
    {
        $values = Settings::sanitize(['enabled' => ['xmlrpc' => '1', 'everything' => '1'], 'extra' => 'x'])['values'];
        self::assertArrayNotHasKey('extra', $values);
        self::assertArrayNotHasKey('everything', $values['enabled']);
        self::assertTrue($values['enabled']['xmlrpc']);
    }

    public function testPreloadNeedsSubdomainsAndAYear(): void
    {
        $short = Settings::sanitize(['hsts_preload' => '1', 'hsts_subdomains' => '1', 'hsts_max_age' => '15552000']);
        self::assertFalse($short['values']['hsts_preload']);
        self::assertCount(1, $short['errors']);

        $noSub = Settings::sanitize(['hsts_preload' => '1', 'hsts_max_age' => '31536000']);
        self::assertFalse($noSub['values']['hsts_preload']);

        $ok = Settings::sanitize(['hsts_preload' => '1', 'hsts_subdomains' => '1', 'hsts_max_age' => '31536000']);
        self::assertTrue($ok['values']['hsts_preload']);
        self::assertSame([], $ok['errors']);
    }

    public function testHeaderValuesWithLineBreaksAreRefused(): void
    {
        $result = Settings::sanitize(['csp_report_only' => "default-src 'self'\r\nSet-Cookie: x=1"]);
        self::assertSame(Settings::DEFAULT_CSP, $result['values']['csp_report_only']);
        self::assertNotEmpty($result['errors']);
    }

    public function testReportUriMustBeHttps(): void
    {
        self::assertSame('', Settings::sanitize(['csp_report_uri' => 'http://report.example/csp'])['values']['csp_report_uri']);
        self::assertSame('', Settings::sanitize(['csp_report_uri' => 'https://report.example/a; script-src *'])['values']['csp_report_uri']);
        self::assertSame('https://report.example/csp', Settings::sanitize(['csp_report_uri' => 'https://report.example/csp'])['values']['csp_report_uri']);
    }

    public function testEmptyCspMeansNone(): void
    {
        self::assertSame('', Settings::sanitize(['csp_report_only' => ''])['values']['csp_report_only']);
    }

    public function testNumbersOutsideTheirRangeFallBackToDefaults(): void
    {
        $result = Settings::sanitize(['login_max_attempts' => '1', 'login_window_minutes' => 'ten', 'login_lockout_minutes' => '30', 'hsts_max_age' => '-5']);
        self::assertSame(5, $result['values']['login_max_attempts']);
        self::assertSame(15, $result['values']['login_window_minutes']);
        self::assertSame(30, $result['values']['login_lockout_minutes']);
        self::assertSame(15552000, $result['values']['hsts_max_age']);
        self::assertCount(3, $result['errors']);
    }

    public function testAllowlistKeepsValidAddressesAndRanges(): void
    {
        $result = Settings::sanitize(['login_allowlist' => "203.0.113.7\n198.51.100.0/24, 2001:db8::/48\nnot-an-ip\n10.0.0.0/33\n203.0.113.7"]);
        self::assertSame(['203.0.113.7', '198.51.100.0/24', '2001:db8::/48'], $result['values']['login_allowlist']);
        self::assertCount(2, $result['errors']);
        self::assertSame(['203.0.113.7', '198.51.100.0/24', '2001:db8::/48'], Settings::fromArray($result['values'])->allowlist());
    }

    public function testOnlyKnownProxyHeadersAreAccepted(): void
    {
        self::assertSame('HTTP_CF_CONNECTING_IP', Settings::sanitize(['login_proxy_header' => 'HTTP_CF_CONNECTING_IP'])['values']['login_proxy_header']);
        $bad = Settings::sanitize(['login_proxy_header' => 'HTTP_X_ANYTHING']);
        self::assertSame('', $bad['values']['login_proxy_header']);
        self::assertNotEmpty($bad['errors']);
    }

    public function testWithEnabledReturnsACopyAndRejectsUnknownIds(): void
    {
        $off = Settings::fromArray([]);
        $on = $off->withEnabled('headers', true);
        self::assertFalse($off->enabled('headers'));
        self::assertTrue($on->enabled('headers'));
        $this->expectException(\InvalidArgumentException::class);
        $off->withEnabled('everything', true);
    }

    public function testStoredValuesRoundTrip(): void
    {
        $settings = Settings::fromArray(['enabled' => ['login' => true], 'login_allowlist' => ['203.0.113.7']]);
        self::assertSame($settings->toArray(), Settings::fromArray($settings->toArray())->toArray());
    }
}
