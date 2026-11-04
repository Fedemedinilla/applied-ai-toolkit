<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use WpHardening\Audit\Audit;
use WpHardening\Audit\Finding;
use WpHardening\Audit\Verdict;
use WpHardening\Env\Paths;
use WpHardening\Plugin;
use WpHardening\Settings;
use WpHardening\SiteHealth;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\FakeHeaders;
use WpHardening\Tests\TestCase;

final class SiteHealthTest extends TestCase
{
    private function plugin(array $stored = []): Plugin
    {
        $root = $this->tempDir();
        return new Plugin(Settings::fromArray($stored), new FakeConstants(), new FakeHeaders(), new Paths($root, $root . '/wp-content', $root . '/wp-content/uploads', $root . '/wp-content/mu-plugins'));
    }

    private function health(Plugin $plugin): SiteHealth
    {
        Functions\when('admin_url')->alias(static fn (string $path): string => 'https://site.example/wp-admin/' . $path);
        return new SiteHealth($plugin->controls, $plugin->settings, $plugin->audit);
    }

    public function testOneDirectTestPerControlAndFastCheck(): void
    {
        $plugin = $this->plugin();
        $tests = $this->health($plugin)->addTests(['direct' => ['core_test' => ['label' => 'x']], 'async' => []]);
        self::assertArrayHasKey('core_test', $tests['direct']);
        foreach (Settings::CONTROLS as $id) {
            self::assertArrayHasKey('wp_hardening_' . $id, $tests['direct']);
            self::assertIsCallable($tests['direct']['wp_hardening_' . $id]['test']);
        }
        foreach (array_keys($plugin->audit->fastChecks()) as $key) {
            self::assertArrayHasKey('wp_hardening_audit_' . $key, $tests['direct']);
        }
        self::assertArrayNotHasKey('wp_hardening_audit_uploads_php', $tests['direct']);
        self::assertSame('not an array', $this->health($plugin)->addTests('not an array'));
    }

    public function testControlResultFollowsTheToggle(): void
    {
        $off = $this->plugin();
        $result = $this->health($off)->controlResult($off->controls[0]);
        self::assertSame('recommended', $result['status']);
        self::assertSame('wp_hardening_file_edit', $result['test']);
        self::assertSame(['label' => 'Security', 'color' => 'blue'], $result['badge']);
        self::assertStringContainsString('options-general.php?page=wp-hardening', $result['actions']);

        $on = $this->plugin(['enabled' => ['user_enumeration' => true]]);
        $result = $this->health($on)->controlResult($on->controls[2]);
        self::assertSame('good', $result['status']);
    }

    public function testRunningAControlTestDoesNotRegisterIt(): void
    {
        $plugin = $this->plugin();
        $tests = $this->health($plugin)->addTests(['direct' => []]);
        ($tests['direct']['wp_hardening_xmlrpc']['test'])();
        self::assertFalse(has_filter('xmlrpc_methods'));
    }

    public function testFindingsAreEscapedAndMapped(): void
    {
        $plugin = $this->plugin();
        $finding = new Finding('INT-15', '.htaccess rules', Verdict::Fail, 'Bad <b>rule</b>', ['<script>x</script>']);
        $result = $this->health($plugin)->findingResult('htaccess', $finding);
        self::assertSame('critical', $result['status']);
        self::assertStringNotContainsString('<script>', $result['description']);
        self::assertStringNotContainsString('<b>', $result['description']);
        self::assertSame('INT-15 .htaccess rules', $result['label']);
        self::assertSame('recommended', Verdict::Skip->state()->value);
        self::assertSame('good', Verdict::Info->state()->value);
    }

    public function testRegisterHooksSiteStatusTests(): void
    {
        $health = $this->health($this->plugin());
        $health->register();
        self::assertNotFalse(has_filter('site_status_tests', [$health, 'addTests']));
    }
}
