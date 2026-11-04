<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use WpHardening\Cli\HardenCommand;
use WpHardening\Env\Paths;
use WpHardening\Plugin;
use WpHardening\Settings;
use WpHardening\Tests\BufferOutput;
use WpHardening\Tests\CliStop;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\FakeHeaders;
use WpHardening\Tests\TestCase;

final class HardenCommandTest extends TestCase
{
    private BufferOutput $out;

    private Settings $stored;

    private int $saves = 0;

    private string $root;

    protected function setUp(): void
    {
        parent::setUp();
        $this->out = new BufferOutput();
        $this->stored = Settings::fromArray([]);
        $this->root = $this->tempDir() . '/site';
        mkdir($this->root . '/wp-content/uploads', 0755, true);
    }

    /** @param array<string, mixed> $constants */
    private function command(array $constants = []): HardenCommand
    {
        $paths = new Paths($this->root, $this->root . '/wp-content', $this->root . '/wp-content/uploads', $this->root . '/wp-content/mu-plugins');
        $plugin = new Plugin($this->stored, new FakeConstants($constants), new FakeHeaders(), $paths);
        return new HardenCommand(
            $plugin->controls,
            fn (): Settings => $this->stored,
            function (Settings $s): void {
                $this->stored = $s;
                $this->saves++;
            },
            $plugin->audit,
            $plugin->rules,
            $this->out,
        );
    }

    public function testStatusListsEveryControl(): void
    {
        $this->command()->status();
        $rows = $this->out->tables[0]['rows'];
        self::assertSame(Settings::CONTROLS, array_column($rows, 'control'));
        self::assertSame(['off'], array_values(array_unique(array_column($rows, 'toggle'))));
        $this->command()->status([], ['format' => 'json']);
        self::assertCount(7, $this->out->json[0]);
    }

    public function testApplyNeedsAnExplicitSelection(): void
    {
        try {
            $this->command()->apply();
            self::fail('apply without --only or --all should stop');
        } catch (CliStop $stop) {
            self::assertSame(1, $stop->getCode());
        }
        self::assertSame(0, $this->saves);
    }

    public function testDryRunSavesNothingAndPrintsTheGuards(): void
    {
        $this->command(['JETPACK__VERSION' => '14.0'])->apply([], ['only' => 'xmlrpc,login', 'dry-run' => true]);
        self::assertSame(0, $this->saves);
        $text = $this->out->text();
        self::assertStringContainsString('xmlrpc: would turn on.', $text);
        self::assertStringContainsString('Guard: Jetpack uses XML-RPC', $text);
        self::assertStringContainsString('Guard missing: the allowlist is empty', $text);
        self::assertStringContainsString('Dry run: nothing was saved.', $text);
    }

    public function testApplyAndRevertSaveOnlyWhatChanged(): void
    {
        $this->command()->apply([], ['only' => 'file_edit, version']);
        self::assertSame(1, $this->saves);
        self::assertTrue($this->stored->enabled('file_edit'));
        self::assertTrue($this->stored->enabled('version'));
        self::assertFalse($this->stored->enabled('headers'));

        $this->command()->apply([], ['only' => 'file_edit']);
        self::assertSame(1, $this->saves);
        self::assertStringContainsString('file_edit: already on.', $this->out->text());

        $this->command()->revert([], ['only' => 'version']);
        self::assertSame(2, $this->saves);
        self::assertFalse($this->stored->enabled('version'));
        self::assertTrue($this->stored->enabled('file_edit'));
    }

    public function testApplyAll(): void
    {
        $this->command()->apply([], ['all' => true]);
        foreach (Settings::CONTROLS as $id) {
            self::assertTrue($this->stored->enabled($id), $id);
        }
    }

    public function testUnknownControlsStopBeforeSaving(): void
    {
        $this->expectException(CliStop::class);
        try {
            $this->command()->apply([], ['only' => 'file_edit,firewall']);
        } finally {
            self::assertSame(0, $this->saves);
            self::assertStringContainsString('Unknown control: firewall', $this->out->text());
        }
    }

    public function testOnlyAndAllTogetherAreRefused(): void
    {
        $this->expectException(CliStop::class);
        $this->command()->apply([], ['only' => 'file_edit', 'all' => true]);
    }

    public function testHtaccessPrintsAndWritesNothing(): void
    {
        $this->command()->htaccess();
        $text = $this->out->text();
        self::assertStringContainsString('Options -Indexes', $text);
        self::assertStringContainsString('<FilesMatch', $text);
        self::assertStringContainsString('Nothing was written.', $text);
        self::assertFalse(file_exists($this->root . '/.htaccess'));
        self::assertFalse(file_exists($this->root . '/wp-content/uploads/.htaccess'));

        $this->out->lines = [];
        $this->command()->htaccess([], ['server' => 'nginx']);
        self::assertStringContainsString('autoindex off;', $this->out->text());

        $this->expectException(CliStop::class);
        $this->command()->htaccess([], ['server' => 'iis']);
    }

    private function stubFastChecks(bool $openRegistration): void
    {
        $options = ['users_can_register' => $openRegistration ? '1' : '0', 'default_role' => 'administrator', 'permalink_structure' => '/%postname%/'];
        Functions\when('get_option')->alias(static fn (string $n, mixed $d = false): mixed => $options[$n] ?? $d);
        Functions\when('get_users')->justReturn([]);
        Functions\when('get_plugins')->justReturn([]);
        Functions\when('is_multisite')->justReturn(false);
        Functions\when('wp_get_themes')->justReturn([]);
        Functions\when('is_child_theme')->justReturn(true);
        Functions\when('wp_load_alloptions')->justReturn([]);
    }

    public function testAuditExitsWithOneOnAFailure(): void
    {
        $this->stubFastChecks(true);
        try {
            $this->command()->audit([], ['fast' => true]);
            self::fail('a failing check should halt with 1');
        } catch (CliStop $stop) {
            self::assertSame(1, $stop->getCode());
        }
        $rows = $this->out->tables[0]['rows'];
        self::assertSame('fail', $rows[0]['verdict']);
        self::assertSame(['id', 'check', 'verdict', 'detail', 'evidence'], $this->out->tables[0]['fields']);
    }

    public function testAuditJsonWithNoFailureReturnsNormally(): void
    {
        $this->stubFastChecks(false);
        $this->command()->audit([], ['fast' => true, 'format' => 'json']);
        self::assertCount(12, $this->out->json[0]);
        self::assertSame('INT-11', $this->out->json[0][0]['id']);
    }
}
