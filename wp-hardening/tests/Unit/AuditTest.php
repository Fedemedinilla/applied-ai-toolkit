<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use WpHardening\Audit\Audit;
use WpHardening\Audit\Verdict;
use WpHardening\Controls\ServerRules;
use WpHardening\Env\Paths;
use WpHardening\Integrations;
use WpHardening\Settings;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\TestCase;

final class AuditTest extends TestCase
{
    private string $root;

    private int $now = 1_800_000_000;

    protected function setUp(): void
    {
        parent::setUp();
        // One level down, so the parent that wp-config.php may sit in is also a fresh directory.
        $this->root = $this->tempDir() . '/site';
        mkdir($this->root . '/wp-content/uploads/2026/10', 0755, true);
        mkdir($this->root . '/wp-content/mu-plugins', 0755, true);
        \WP_Application_Passwords::$byUser = [];
    }

    protected function tearDown(): void
    {
        unset($GLOBALS['wpdb']);
        parent::tearDown();
    }

    private function paths(): Paths
    {
        return new Paths($this->root, $this->root . '/wp-content', $this->root . '/wp-content/uploads', $this->root . '/wp-content/mu-plugins');
    }

    /** @param array<string, mixed> $constants */
    private function audit(array $constants = [], string $php = '8.3.6', string $memory = '256M'): Audit
    {
        return new Audit($this->paths(), new FakeConstants($constants), $php, $memory, fn (): int => $this->now);
    }

    /** @param array<string, mixed> $options */
    private function options(array $options): void
    {
        Functions\when('get_option')->alias(static fn (string $name, mixed $default = false): mixed => $options[$name] ?? $default);
    }

    private function salts(): array
    {
        $out = [];
        foreach (['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'] as $i => $name) {
            $out[$name] = str_repeat(\chr(65 + $i), 64);
        }
        return $out;
    }

    public function testRegistration(): void
    {
        $this->options(['users_can_register' => '0']);
        self::assertSame(Verdict::Pass, $this->audit()->registration()->verdict);
        $this->options(['users_can_register' => '1', 'default_role' => 'subscriber']);
        self::assertSame(Verdict::Warn, $this->audit()->registration()->verdict);
        $this->options(['users_can_register' => '1', 'default_role' => 'administrator']);
        self::assertSame(Verdict::Fail, $this->audit()->registration()->verdict);
    }

    public function testDebug(): void
    {
        self::assertSame(Verdict::Pass, $this->audit()->debug()->verdict);
        self::assertSame(Verdict::Fail, $this->audit(['WP_DEBUG' => true])->debug()->verdict);
        self::assertSame(Verdict::Fail, $this->audit(['WP_DEBUG' => true, 'WP_DEBUG_DISPLAY' => true])->debug()->verdict);
        self::assertSame(Verdict::Warn, $this->audit(['WP_DEBUG' => true, 'WP_DEBUG_DISPLAY' => false])->debug()->verdict);
        file_put_contents($this->root . '/wp-content/debug.log', 'x');
        $log = $this->audit(['WP_DEBUG' => true, 'WP_DEBUG_DISPLAY' => false, 'WP_DEBUG_LOG' => true])->debug();
        self::assertSame(['wp-content/debug.log'], $log->evidence);
        self::assertStringContainsString('web root', $log->detail);
    }

    public function testSaltsReportNamesNeverValues(): void
    {
        self::assertSame(Verdict::Pass, $this->audit($this->salts())->salts()->verdict);
        $salts = $this->salts();
        $salts['NONCE_SALT'] = 'put your unique phrase here';
        $salts['AUTH_SALT'] = $salts['AUTH_KEY'];
        unset($salts['LOGGED_IN_KEY']);
        $finding = $this->audit($salts)->salts();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertSame(['LOGGED_IN_KEY', 'AUTH_SALT (same as AUTH_KEY)', 'NONCE_SALT'], $finding->evidence);
        self::assertStringNotContainsString('AAAA', json_encode($finding->toArray(), JSON_THROW_ON_ERROR));
    }

    public function testAdministrators(): void
    {
        Functions\when('get_users')->justReturn([(object) ['ID' => 1, 'user_login' => 'ana'], (object) ['ID' => 2, 'user_login' => 'Admin']]);
        $finding = $this->audit()->administrators();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertSame(['Admin'], $finding->evidence);
        Functions\when('get_users')->justReturn([(object) ['ID' => 1, 'user_login' => 'ana']]);
        self::assertSame(Verdict::Info, $this->audit()->administrators()->verdict);
    }

    public function testApplicationPasswords(): void
    {
        Functions\when('get_users')->justReturn([1, 2]);
        self::assertSame(Verdict::Pass, $this->audit()->applicationPasswords()->verdict);
        \WP_Application_Passwords::$byUser = [1 => [['name' => 'sync', 'last_used' => 1_700_000_000]]];
        self::assertSame(Verdict::Info, $this->audit()->applicationPasswords()->verdict);
        \WP_Application_Passwords::$byUser[2] = [['name' => 'old', 'last_used' => null]];
        $finding = $this->audit()->applicationPasswords();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertSame(['total=2', 'never_used=1'], $finding->evidence);
    }

    public function testUnusedCode(): void
    {
        Functions\when('get_plugins')->justReturn(['a/a.php' => [], 'b/b.php' => [], 'c/c.php' => []]);
        Functions\when('is_multisite')->justReturn(false);
        Functions\when('wp_get_themes')->justReturn(['t1' => 1, 't2' => 2]);
        $this->options(['active_plugins' => ['a/a.php', 'b/b.php', 'c/c.php']]);
        self::assertSame(Verdict::Pass, $this->audit()->unusedCode()->verdict);
        $this->options(['active_plugins' => ['a/a.php']]);
        $finding = $this->audit()->unusedCode();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertSame(['b/b.php', 'c/c.php', 'themes=2'], $finding->evidence);
    }

    public function testNetworkActivePluginsCountAsActive(): void
    {
        Functions\when('get_plugins')->justReturn(['a/a.php' => [], 'n/n.php' => []]);
        Functions\when('is_multisite')->justReturn(true);
        Functions\when('get_site_option')->justReturn(['n/n.php' => 1]);
        Functions\when('wp_get_themes')->justReturn([]);
        $this->options(['active_plugins' => ['a/a.php']]);
        self::assertSame(Verdict::Pass, $this->audit()->unusedCode()->verdict);
    }

    public function testChildThemePermalinksPingbacks(): void
    {
        Functions\when('is_child_theme')->justReturn(true);
        self::assertSame(Verdict::Pass, $this->audit()->childTheme()->verdict);
        Functions\when('is_child_theme')->justReturn(false);
        self::assertSame(Verdict::Info, $this->audit()->childTheme()->verdict);

        $this->options(['permalink_structure' => '', 'default_ping_status' => 'open']);
        self::assertSame(Verdict::Warn, $this->audit()->permalinks()->verdict);
        self::assertSame(Verdict::Warn, $this->audit()->pingbacks()->verdict);
        $this->options(['permalink_structure' => '/%postname%/', 'default_ping_status' => 'closed']);
        self::assertSame(Verdict::Pass, $this->audit()->permalinks()->verdict);
        self::assertSame(Verdict::Pass, $this->audit()->pingbacks()->verdict);
    }

    public function testPhpAndMemory(): void
    {
        self::assertSame(Verdict::Pass, $this->audit([], '8.3.6', '512M')->php()->verdict);
        self::assertSame(Verdict::Pass, $this->audit([], '8.2.0', '-1')->php()->verdict);
        self::assertSame(Verdict::Warn, $this->audit([], '8.1.30', '1G')->php()->verdict);
        $low = $this->audit([], '8.3.0', '128M')->php();
        self::assertSame(Verdict::Warn, $low->verdict);
        self::assertStringContainsString('256M', $low->detail);
        self::assertSame(268435456, Audit::bytes('256M'));
        self::assertSame(1073741824, Audit::bytes('1g'));
        self::assertSame(0, Audit::bytes('lots'));
    }

    public function testWpConfigMode(): void
    {
        self::assertSame(Verdict::Skip, $this->audit()->wpConfigMode()->verdict);
        $file = $this->root . '/wp-config.php';
        file_put_contents($file, '<?php');
        chmod($file, 0600);
        self::assertSame(Verdict::Pass, $this->audit()->wpConfigMode()->verdict);
        chmod($file, 0644);
        self::assertSame(Verdict::Warn, $this->audit()->wpConfigMode()->verdict);
        chmod($file, 0666);
        self::assertSame(Verdict::Fail, $this->audit()->wpConfigMode()->verdict);
        unlink($file);
        file_put_contents(\dirname($this->root) . '/wp-config.php', '<?php');
        try {
            chmod(\dirname($this->root) . '/wp-config.php', 0640);
            self::assertSame(['mode=640'], $this->audit()->wpConfigMode()->evidence);
        } finally {
            unlink(\dirname($this->root) . '/wp-config.php');
        }
    }

    public function testAutoloadSize(): void
    {
        Functions\when('wp_load_alloptions')->justReturn(['small' => 'x', 'big' => str_repeat('y', 900 * 1024)]);
        $finding = $this->audit()->autoloadSize();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertStringStartsWith('big ', $finding->evidence[0]);
        Functions\when('wp_load_alloptions')->justReturn(['small' => 'x', 'list' => ['a', 'b']]);
        self::assertSame(Verdict::Pass, $this->audit()->autoloadSize()->verdict);
    }

    public function testCoreChecksumsIsASkipNeverAPass(): void
    {
        $finding = $this->audit()->coreChecksums();
        self::assertSame(Verdict::Skip, $finding->verdict);
        self::assertStringContainsString('wp core verify-checksums', $finding->detail);
    }

    public function testPhpInUploads(): void
    {
        $uploads = $this->root . '/wp-content/uploads/2026/10';
        file_put_contents($uploads . '/photo.jpg', "\xFF\xD8\xFF");
        self::assertSame(Verdict::Pass, $this->audit()->uploadsPhp()->verdict);
        file_put_contents($uploads . '/cache.PHP', '<?php');
        file_put_contents($uploads . '/icon.ico', "\x00\x00<?php system(\$_GET['c']);");
        $finding = $this->audit()->uploadsPhp();
        self::assertSame(Verdict::Fail, $finding->verdict);
        self::assertSame(['2026/10/cache.PHP', '2026/10/icon.ico (image with PHP inside)'], array_values(array_intersect(['2026/10/cache.PHP', '2026/10/icon.ico (image with PHP inside)'], $finding->evidence)));
        self::assertCount(2, $finding->evidence);
    }

    public function testMuPluginsAndDropins(): void
    {
        self::assertSame(Verdict::Pass, $this->audit()->muPlugins()->verdict);
        file_put_contents($this->root . '/wp-content/object-cache.php', '<?php');
        self::assertSame(Verdict::Info, $this->audit()->muPlugins()->verdict);
        file_put_contents($this->root . '/wp-content/mu-plugins/known.php', "<?php\n/**\n * Plugin Name: Known\n */");
        file_put_contents($this->root . '/wp-content/mu-plugins/wp-cache-helper.php', '<?php eval($x);');
        $finding = $this->audit()->muPlugins();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertSame(['mu-plugins/wp-cache-helper.php', 'object-cache.php'], $finding->evidence);
    }

    public function testRecentPhp(): void
    {
        $old = $this->root . '/wp-content/old.php';
        $new = $this->root . '/wp-content/mu-plugins/new.php';
        file_put_contents($old, '<?php');
        file_put_contents($new, '<?php');
        touch($old, $this->now - 40 * 86400);
        touch($new, $this->now - 2 * 86400);
        $finding = $this->audit()->recentPhp();
        self::assertSame(Verdict::Info, $finding->verdict);
        self::assertSame(['mu-plugins/new.php'], $finding->evidence);
    }

    public function testSuspiciousHtaccessLines(): void
    {
        $text = implode("\n", [
            '# BEGIN WordPress',
            'RewriteRule . /index.php [L]',
            '# END WordPress',
            'RewriteCond %{HTTP_USER_AGENT} googlebot [NC]',
            'RewriteRule ^(.*)$ https://spam.example/$1 [R=301,L]',
            'php_value auto_prepend_file /tmp/x.php',
            'AddHandler application/x-httpd-php .jpg',
            'AddHandler application/x-httpd-ea-php83 .php',
            ServerRules::BEGIN,
            '  Deny from all',
            ServerRules::END,
        ]);
        $hits = Audit::suspiciousLines($text, false);
        self::assertSame([[4, 'condition on the user agent'], [5, 'rewrite to another host'], [6, 'PHP prepend or append file'], [7, 'PHP handler for an image or text extension']], $hits);
        self::assertSame([[1, 'PHP handler inside uploads']], Audit::suspiciousLines('AddHandler application/x-httpd-php .php', true));
    }

    public function testHtaccessFinding(): void
    {
        self::assertSame(Verdict::Pass, $this->audit()->htaccessRules()->verdict);
        file_put_contents($this->root . '/wp-content/uploads/.htaccess', "SetHandler application/x-httpd-php\n");
        $finding = $this->audit()->htaccessRules();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertSame(['uploads/.htaccess line 1: PHP handler inside uploads'], $finding->evidence);
    }

    public function testGeneratedBlocksDoNotFlagThemselves(): void
    {
        $rules = new ServerRules($this->paths(), new Integrations(new FakeConstants(), Settings::fromArray([])), []);
        file_put_contents($this->root . '/.htaccess', $rules->rootBlock());
        file_put_contents($this->root . '/wp-content/uploads/.htaccess', $rules->uploadsBlock());
        self::assertSame(Verdict::Pass, $this->audit()->htaccessRules()->verdict);
    }

    public function testDatabaseChecksAreReadOnlyQueries(): void
    {
        $wpdb = new class () {
            public string $options = 'wp_options';
            public string $posts = 'wp_posts';
            /** @var list<string> */
            public array $queries = [];

            public function prepare(string $sql, string ...$args): string
            {
                return vsprintf(str_replace('%s', "'%s'", $sql), array_map('addslashes', $args));
            }

            /** @return list<string> */
            public function get_col(string $sql): array
            {
                $this->queries[] = $sql;
                return ['widget_custom_html_9'];
            }

            /** @return list<array<string, mixed>> */
            public function get_results(string $sql, string $output): array
            {
                $this->queries[] = $sql;
                return [['ID' => '12', 'post_type' => 'page']];
            }
        };
        $GLOBALS['wpdb'] = $wpdb;
        $options = $this->audit()->optionsWithCode();
        self::assertSame(Verdict::Warn, $options->verdict);
        self::assertSame(['widget_custom_html_9'], $options->evidence);
        $posts = $this->audit()->injectedContent();
        self::assertSame(['post 12 (page)'], $posts->evidence);
        foreach ($wpdb->queries as $sql) {
            self::assertStringStartsWith('SELECT ', $sql);
            self::assertStringContainsString('LIMIT 20', $sql);
        }
    }

    public function testDatabaseChecksSkipWithoutAConnection(): void
    {
        self::assertSame(Verdict::Skip, $this->audit()->optionsWithCode()->verdict);
        self::assertSame(Verdict::Skip, $this->audit()->injectedContent()->verdict);
    }

    public function testOrphanCron(): void
    {
        Functions\when('_get_cron_array')->justReturn([
            1_800_000_100 => ['wp_version_check' => [], 'role_cache_rebuild_x' => []],
            1_800_000_200 => ['role_cache_rebuild_x' => []],
        ]);
        add_action('wp_version_check', 'wp_version_check');
        $finding = $this->audit()->orphanCron();
        self::assertSame(Verdict::Warn, $finding->verdict);
        self::assertSame(['role_cache_rebuild_x'], $finding->evidence);
    }

    public function testFastRunHasNoFileWalksOrTableScans(): void
    {
        self::assertSame([], array_intersect(array_keys($this->audit()->fastChecks()), ['uploads_php', 'recent_php', 'htaccess', 'options_code', 'injected', 'cron']));
        self::assertCount(12, $this->audit()->fastChecks());
        self::assertCount(8, $this->audit()->slowChecks());
    }

    public function testTheAuditWritesNothing(): void
    {
        $this->options([]);
        Functions\when('get_users')->justReturn([]);
        Functions\when('get_plugins')->justReturn([]);
        Functions\when('is_multisite')->justReturn(false);
        Functions\when('wp_get_themes')->justReturn([]);
        Functions\when('is_child_theme')->justReturn(true);
        Functions\when('wp_load_alloptions')->justReturn([]);
        Functions\when('_get_cron_array')->justReturn([]);
        Functions\expect('update_option')->never();
        Functions\expect('delete_option')->never();
        Functions\expect('set_transient')->never();
        file_put_contents($this->root . '/wp-content/uploads/2026/10/a.jpg', 'x');
        $before = filemtime($this->root . '/wp-content/uploads/2026/10/a.jpg');
        $findings = $this->audit()->run();
        self::assertCount(20, $findings);
        self::assertSame($before, filemtime($this->root . '/wp-content/uploads/2026/10/a.jpg'));
        self::assertFalse(file_exists($this->root . '/.htaccess'));
    }

    public function testEveryFastCheckHasASiteHealthTitle(): void
    {
        self::assertSame(array_keys($this->audit()->fastChecks()), array_keys(Audit::FAST_TITLES));
    }

    /** A directory the walk cannot open ends it as truncated, so the uploads check warns instead of passing. */
    public function testAnUnreadableDirectoryMakesTheWalkPartial(): void
    {
        if (\function_exists('posix_geteuid') && posix_geteuid() === 0) {
            self::markTestSkipped('root reads a mode 000 directory anyway; this runs as the CI user.');
        }
        $locked = $this->root . '/wp-content/uploads/locked';
        mkdir($locked);
        file_put_contents($locked . '/shell.php', '<?php');
        chmod($locked, 0);
        try {
            self::assertSame(Verdict::Warn, $this->audit()->uploadsPhp()->verdict);
        } finally {
            chmod($locked, 0755);
        }
    }
}
