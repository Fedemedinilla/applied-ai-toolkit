<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use WpHardening\Env\Paths;
use WpHardening\Plugin;
use WpHardening\Settings;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\FakeHeaders;
use WpHardening\Tests\TestCase;

final class PluginTest extends TestCase
{
    private FakeConstants $constants;

    private function plugin(array $stored): Plugin
    {
        $root = $this->tempDir();
        $this->constants = new FakeConstants();
        return new Plugin(Settings::fromArray($stored), $this->constants, new FakeHeaders(), new Paths($root, $root . '/wp-content', $root . '/wp-content/uploads', $root . '/wp-content/mu-plugins'));
    }

    public function testControlIdsMatchTheSettings(): void
    {
        $ids = array_map(static fn ($c): string => $c->id(), $this->plugin([])->controls);
        self::assertSame(Settings::CONTROLS, $ids);
    }

    public function testActivationWithDefaultsChangesNothing(): void
    {
        $plugin = $this->plugin([]);
        $plugin->register();
        foreach (['xmlrpc_methods', 'rest_pre_dispatch', 'send_headers', 'authenticate', 'script_loader_src', 'template_redirect', 'wp_sitemaps_add_provider'] as $hook) {
            self::assertFalse(has_filter($hook), $hook);
        }
        self::assertFalse($this->constants->defined('DISALLOW_FILE_EDIT'));
        self::assertNotFalse(has_filter('site_status_tests'));
        self::assertFalse(has_action('admin_menu'));
    }

    public function testOnlyTheControlsThatAreOnRegister(): void
    {
        Functions\when('is_admin')->justReturn(true);
        $plugin = $this->plugin(['enabled' => ['headers' => true, 'file_edit' => true]]);
        $plugin->register();
        self::assertNotFalse(has_action('send_headers'));
        self::assertTrue($this->constants->value('DISALLOW_FILE_EDIT'));
        self::assertFalse(has_filter('xmlrpc_methods'));
        self::assertFalse(has_filter('authenticate'));
        self::assertNotFalse(has_action('admin_menu'));
    }
}
