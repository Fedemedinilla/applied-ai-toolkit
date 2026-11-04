<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;
use WpHardening\Tests\TestCase;

/** Loads wp-hardening.php the way WordPress does, in a process of its own because it defines constants. */
final class BootstrapTest extends TestCase
{
    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testThePluginFileBootsWithItsOwnAutoloader(): void
    {
        $root = $this->tempDir();
        \define('ABSPATH', $root . '/');
        \define('WP_CONTENT_DIR', $root . '/wp-content');
        Functions\when('get_option')->justReturn(['enabled' => ['version' => '1']]);
        // Paths are built when Site Health or WP-CLI needs them: wp_upload_dir() caches its result,
        // so calling it while plugins load would fix the paths before others hook upload_dir.
        Functions\expect('wp_upload_dir')->never();

        require \dirname(__DIR__, 2) . '/wp-hardening.php';

        self::assertNotFalse(has_filter('site_status_tests'));
        self::assertNotFalse(has_filter('the_generator'));
        self::assertFalse(has_filter('xmlrpc_methods'));

        $loaders = spl_autoload_functions();
        $own = end($loaders);
        self::assertInstanceOf(\Closure::class, $own);
        self::assertFalse(class_exists('WpHardening\\Cli\\WpCliOutput', false));
        $own('WpHardening\\Cli\\WpCliOutput');
        self::assertTrue(class_exists('WpHardening\\Cli\\WpCliOutput', false));
        $own('Other\\Thing');
    }
}
