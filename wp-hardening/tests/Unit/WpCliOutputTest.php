<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;
use PHPUnit\Framework\TestCase;
use WpHardening\Cli\WpCliOutput;

/** Runs in its own process, so the WP_CLI stand-in defined here reaches no other test. */
final class WpCliOutputTest extends TestCase
{
    /** File names come from disk and need not be UTF-8; the JSON must still carry every finding. */
    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testJsonSurvivesInvalidUtf8InEvidence(): void
    {
        eval('final class WP_CLI { /** @var list<string> */ public static array $lines = []; public static function line(string $text): void { self::$lines[] = $text; } }');
        (new WpCliOutput())->json([['id' => 'INT-02', 'verdict' => 'fail', 'evidence' => ["2026/sh\xE9ll.php"]]]);
        $lines = \WP_CLI::$lines;
        self::assertCount(1, $lines);
        $decoded = json_decode($lines[0], true);
        self::assertIsArray($decoded);
        self::assertSame('INT-02', $decoded[0]['id']);
        self::assertSame("2026/sh\u{FFFD}ll.php", $decoded[0]['evidence'][0]);
    }
}
