<?php

declare(strict_types=1);

namespace WpHardening\Tests;

use Brain\Monkey;
use Brain\Monkey\Functions;
use Mockery\Adapter\Phpunit\MockeryPHPUnitIntegration;

abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    use MockeryPHPUnitIntegration;

    protected function setUp(): void
    {
        parent::setUp();
        Monkey\setUp();
        Functions\stubTranslationFunctions();
        Functions\stubEscapeFunctions();
        Functions\when('is_user_logged_in')->justReturn(false);
        Functions\when('is_admin')->justReturn(false);
        Functions\when('is_ssl')->justReturn(true);
    }

    protected function tearDown(): void
    {
        $this->removeTempDirs();
        Monkey\tearDown();
        parent::tearDown();
    }

    /** A temporary directory removed after the test. */
    protected function tempDir(): string
    {
        $dir = sys_get_temp_dir() . '/wph-' . bin2hex(random_bytes(6));
        mkdir($dir, 0700, true);
        $this->cleanup[] = $dir;
        return $dir;
    }

    /** @var list<string> */
    private array $cleanup = [];

    private function removeTempDirs(): void
    {
        foreach ($this->cleanup as $dir) {
            self::rmTree($dir);
        }
        $this->cleanup = [];
    }

    private static function rmTree(string $dir): void
    {
        if (!is_dir($dir) || is_link($dir)) {
            @unlink($dir);
            return;
        }
        foreach (scandir($dir) ?: [] as $name) {
            if ($name !== '.' && $name !== '..') {
                self::rmTree($dir . '/' . $name);
            }
        }
        @chmod($dir, 0700);
        rmdir($dir);
    }

    /**
     * Backs get_transient, set_transient and delete_transient with an array, and returns it by
     * reference so a test can read what was stored.
     *
     * @return \ArrayObject<string, mixed>
     */
    protected function transients(): \ArrayObject
    {
        $store = new \ArrayObject();
        Functions\when('get_transient')->alias(static fn (string $k): mixed => $store[$k] ?? false);
        Functions\when('set_transient')->alias(static function (string $k, mixed $v, int $ttl) use ($store): bool {
            $store[$k] = $v;
            $store['ttl:' . $k] = $ttl;
            return true;
        });
        Functions\when('delete_transient')->alias(static function (string $k) use ($store): bool {
            unset($store[$k], $store['ttl:' . $k]);
            return true;
        });
        return $store;
    }
}
