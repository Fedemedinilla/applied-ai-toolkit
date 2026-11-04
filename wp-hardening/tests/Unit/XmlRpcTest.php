<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Filters;
use WpHardening\Controls\ServerRules;
use WpHardening\Controls\XmlRpc;
use WpHardening\Env\Paths;
use WpHardening\Integrations;
use WpHardening\Settings;
use WpHardening\State;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\TestCase;

final class XmlRpcTest extends TestCase
{
    /**
     * @param array<string, mixed> $constants
     * @param array<string, mixed> $settings
     */
    private function control(array $constants = [], array $settings = []): XmlRpc
    {
        return new XmlRpc(new Integrations(new FakeConstants($constants), Settings::fromArray($settings)));
    }

    public function testGuardAServerDenyPastedBeforeJetpackIsReportedAsCritical(): void
    {
        $root = $this->tempDir();
        $integrations = new Integrations(new FakeConstants(['JETPACK__VERSION' => '14.0']), Settings::fromArray([]));
        $rules = new ServerRules(new Paths($root, $root, $root . '/uploads', $root . '/mu'), $integrations, []);
        $control = new XmlRpc($integrations, $rules);
        self::assertSame(State::Good, $control->report(true)->state);
        file_put_contents($root . '/.htaccess', "<Files xmlrpc.php>\n  Require all denied\n</Files>\n");
        $report = $control->report(true);
        self::assertSame(State::Critical, $report->state);
        self::assertStringContainsString('denies xmlrpc.php', $report->summary);
    }

    public function testRegisterAddsTheFilters(): void
    {
        $control = $this->control();
        $control->register();
        self::assertNotFalse(has_filter('xmlrpc_methods', [$control, 'filterMethods']));
        self::assertNotFalse(has_filter('xmlrpc_enabled', [$control, 'filterEnabled']));
        self::assertNotFalse(has_filter('wp_headers', [$control, 'filterHeaders']));
    }

    public function testClosesWhenNothingUsesIt(): void
    {
        $control = $this->control();
        self::assertTrue($control->blocking());
        self::assertFalse($control->filterEnabled(true));
        self::assertSame([], $control->filterMethods(['wp.getUsersBlogs' => 'x', 'pingback.ping' => 'y', 'system.multicall' => 'z']));
        self::assertSame(['Content-Type' => 'text/html'], $control->filterHeaders(['Content-Type' => 'text/html', 'x-pingback' => 'https://site.example/xmlrpc.php']));
    }

    public function testGuardJetpackKeepsItOpen(): void
    {
        $control = $this->control(['JETPACK__VERSION' => '14.0']);
        self::assertFalse($control->blocking());
        $methods = ['jetpack.verifyRegistration' => 'x'];
        self::assertSame($methods, $control->filterMethods($methods));
        self::assertTrue($control->filterEnabled(true));
        self::assertSame(['X-Pingback' => 'u'], $control->filterHeaders(['X-Pingback' => 'u']));
        $report = $control->report(true);
        self::assertSame(State::Good, $report->state);
        self::assertStringContainsString('Jetpack', $report->summary);
        self::assertStringContainsString('Guard', $control->plan()[0]);
    }

    public function testGuardTheDeclaredMobileAppKeepsItOpen(): void
    {
        $control = $this->control([], ['xmlrpc_keep_for_app' => '1']);
        self::assertFalse($control->blocking());
        self::assertStringContainsString('mobile app', $control->report(true)->summary);
    }

    public function testGuardAPluginCanDeclareItselfThroughTheFilter(): void
    {
        Filters\expectApplied('wp_hardening_xmlrpc_integrations')->andReturn(['Example Sync']);
        $control = $this->control();
        self::assertFalse($control->blocking());
    }

    public function testAFilterReturningGarbageDoesNotOpenIt(): void
    {
        Filters\expectApplied('wp_hardening_xmlrpc_integrations')->andReturn('yes');
        self::assertTrue($this->control()->blocking());
    }

    public function testRsdLinkIsRemovedOnlyWhenBlocking(): void
    {
        add_action('wp_head', 'rsd_link');
        $this->control(['JETPACK__VERSION' => '14.0'])->removeRsdLink();
        self::assertNotFalse(has_action('wp_head', 'rsd_link'));
        $this->control()->removeRsdLink();
        self::assertFalse(has_action('wp_head', 'rsd_link'));
    }

    public function testReportWhenOff(): void
    {
        self::assertSame(State::Recommended, $this->control()->report(false)->state);
        self::assertSame(State::Good, $this->control()->report(true)->state);
    }
}
