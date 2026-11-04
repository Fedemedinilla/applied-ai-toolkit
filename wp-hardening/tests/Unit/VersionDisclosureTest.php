<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use WpHardening\Controls\VersionDisclosure;
use WpHardening\State;
use WpHardening\Tests\TestCase;

final class VersionDisclosureTest extends TestCase
{
    private const KEY = 'test-secret';

    public function testSameSiteVersionIsReplacedWithAKeyedHash(): void
    {
        $masked = VersionDisclosure::maskVersion('https://site.example/wp-includes/js/jquery/jquery.min.js?ver=6.8.3', 'site.example', self::KEY);
        self::assertStringNotContainsString('6.8.3', $masked);
        self::assertMatchesRegularExpression('/\?ver=[0-9a-f]{10}$/', $masked);
        self::assertSame($masked, VersionDisclosure::maskVersion('https://site.example/wp-includes/js/jquery/jquery.min.js?ver=6.8.3', 'site.example', self::KEY));
    }

    public function testGuardANewVersionStillChangesTheUrl(): void
    {
        $a = VersionDisclosure::maskVersion('/wp-includes/css/dist/block-library/style.min.css?ver=6.8.3', 'site.example', self::KEY);
        $b = VersionDisclosure::maskVersion('/wp-includes/css/dist/block-library/style.min.css?ver=6.8.4', 'site.example', self::KEY);
        self::assertNotSame($a, $b);
    }

    public function testThePlainHashOfTheVersionIsNotUsed(): void
    {
        $masked = VersionDisclosure::maskVersion('/a.js?ver=6.8.3', '', self::KEY);
        self::assertStringNotContainsString(substr(hash('sha256', '6.8.3'), 0, 10), $masked);
        self::assertStringNotContainsString(substr(md5('6.8.3'), 0, 10), $masked);
        self::assertNotSame($masked, VersionDisclosure::maskVersion('/a.js?ver=6.8.3', '', 'other-secret'));
    }

    public function testOtherParametersAndFragmentsAreKept(): void
    {
        $masked = VersionDisclosure::maskVersion('https://site.example/a.js?foo=1&ver=2.0&bar=2#x', 'SITE.example', self::KEY);
        self::assertMatchesRegularExpression('/^https:\/\/site\.example\/a\.js\?foo=1&ver=[0-9a-f]{10}&bar=2#x$/', $masked);
    }

    public function testThirdPartyUrlsAreUntouched(): void
    {
        $src = 'https://cdn.example.net/lib.js?ver=1.2.3';
        self::assertSame($src, VersionDisclosure::maskVersion($src, 'site.example', self::KEY));
        self::assertSame('/no-version.js', VersionDisclosure::maskVersion('/no-version.js', 'site.example', self::KEY));
        self::assertSame('/x.js?version=1', VersionDisclosure::maskVersion('/x.js?version=1', 'site.example', self::KEY));
    }

    public function testFilterSrcReadsTheHomeHost(): void
    {
        Functions\when('home_url')->justReturn('https://site.example');
        Functions\when('wp_parse_url')->alias('parse_url');
        $control = new VersionDisclosure(static fn (): string => self::KEY);
        self::assertStringNotContainsString('6.8.3', (string) $control->filterSrc('https://site.example/a.js?ver=6.8.3'));
        self::assertSame(false, $control->filterSrc(false));
    }

    public function testRegisterRemovesTheGeneratorTag(): void
    {
        add_action('wp_head', 'wp_generator');
        $control = new VersionDisclosure();
        $control->register();
        self::assertFalse(has_action('wp_head', 'wp_generator'));
        self::assertNotFalse(has_filter('the_generator', [$control, 'emptyGenerator']));
        self::assertNotFalse(has_filter('script_loader_src', [$control, 'filterSrc']));
        self::assertNotFalse(has_filter('style_loader_src', [$control, 'filterSrc']));
        self::assertSame('', $control->emptyGenerator());
    }

    public function testReport(): void
    {
        self::assertSame(State::Good, (new VersionDisclosure())->report(true)->state);
        self::assertSame(State::Recommended, (new VersionDisclosure())->report(false)->state);
    }
}
