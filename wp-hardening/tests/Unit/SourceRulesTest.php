<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Rules the source must keep, checked as text: every file is strict and namespaced, and nothing
 * outside the settings save and the login counters writes to disk, the database or wp-config.php.
 */
final class SourceRulesTest extends TestCase
{
    /** @return list<string> */
    private static function files(): array
    {
        $root = \dirname(__DIR__, 2);
        $files = [$root . '/wp-hardening.php', $root . '/uninstall.php'];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root . '/src', \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            \assert($file instanceof \SplFileInfo);
            if ($file->getExtension() === 'php') {
                $files[] = $file->getPathname();
            }
        }
        sort($files);
        return $files;
    }

    public function testEveryFileIsStrict(): void
    {
        foreach (self::files() as $file) {
            self::assertStringContainsString('declare(strict_types=1);', (string) file_get_contents($file), $file);
        }
    }

    public function testSourceFilesAreNamespaced(): void
    {
        foreach (self::files() as $file) {
            if (str_contains($file, '/src/')) {
                self::assertMatchesRegularExpression('/^namespace WpHardening(\\\\\w+)*;$/m', (string) file_get_contents($file), $file);
            }
        }
    }

    /**
     * Calls that write to disk, the options table or the database. `$wpdb->` has its own branch
     * because a word boundary never comes before `$`: `\b\$wpdb` would not match `  $wpdb->query(`.
     */
    private const WRITES = '/(?:\b(file_put_contents|fwrite|fputs|fopen|unlink|rename|copy|mkdir|rmdir|chmod|touch|insert_with_markers|save_mod_rewrite_rules|update_option|add_option|delete_option|set_transient|delete_transient|set_site_transient|delete_site_transient)|(\$wpdb\s*->\s*(?:query|insert|update|delete|replace)))\s*\(/';

    /** @return list<string> The write calls found in $text, by name. */
    private static function writes(string $text): array
    {
        preg_match_all(self::WRITES, $text, $m, PREG_SET_ORDER);
        $found = [];
        foreach ($m as $match) {
            $found[] = ($match[1] ?? '') !== '' ? $match[1] : (string) preg_replace('/\s+/', '', $match[2] ?? '');
        }
        return array_values(array_unique($found));
    }

    public function testTheWriteDetectorCatchesEachForm(): void
    {
        self::assertSame(['$wpdb->query'], self::writes('  $wpdb->query("DELETE FROM x")'));
        self::assertSame(['$wpdb->insert'], self::writes('$wpdb -> insert($table, $row);'));
        self::assertSame(['file_put_contents'], self::writes('\\file_put_contents($f, $x);'));
        self::assertSame(['update_option'], self::writes('if (1) { update_option(1); }'));
        self::assertSame(['set_transient'], self::writes('set_transient($k, $v, 60);'));
        self::assertSame([], self::writes('$wpdb->get_results("SELECT 1"); get_option("x"); $this->update_options;'));
    }

    public function testNothingWritesSilently(): void
    {
        $allowed = [
            // The settings save behind `wp harden apply`/`revert`, which the operator runs on purpose.
            'src/Plugin.php' => ['update_option'],
            // The login counters, which expire on their own.
            'src/Controls/LoginLimiter.php' => ['set_transient', 'delete_transient'],
            // Runs only when the plugin is deleted from the dashboard.
            'uninstall.php' => ['delete_option'],
        ];
        $root = \dirname(__DIR__, 2) . '/';
        foreach (self::files() as $file) {
            $relative = substr($file, \strlen($root));
            $found = self::writes((string) file_get_contents($file));
            sort($found);
            $expected = $allowed[$relative] ?? [];
            sort($expected);
            self::assertSame($expected, $found, $relative);
        }
    }

    public function testBootstrapParsesWithoutPhp8Syntax(): void
    {
        $text = (string) file_get_contents(\dirname(__DIR__, 2) . '/wp-hardening.php');
        self::assertStringNotContainsString('fn (', $text);
        self::assertStringNotContainsString('match (', $text);
        self::assertStringNotContainsString('?->', $text);
        self::assertStringContainsString('Requires PHP:      8.1', $text);
    }
}
