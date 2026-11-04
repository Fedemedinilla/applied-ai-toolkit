<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use WpHardening\Controls\FileEditing;
use WpHardening\State;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\TestCase;

final class FileEditingTest extends TestCase
{
    public function testDefinesTheConstantWhenWpConfigDoesNot(): void
    {
        $constants = new FakeConstants();
        $control = new FileEditing($constants);
        self::assertSame(State::Recommended, $control->report(false)->state);
        $control->register();
        self::assertTrue($constants->value('DISALLOW_FILE_EDIT'));
        self::assertSame(State::Good, $control->report(true)->state);
    }

    public function testGuardAnExplicitFalseInWpConfigWins(): void
    {
        $constants = new FakeConstants(['DISALLOW_FILE_EDIT' => false]);
        $control = new FileEditing($constants);
        $control->register();
        self::assertFalse($constants->value('DISALLOW_FILE_EDIT'));
        $report = $control->report(true);
        self::assertSame(State::Recommended, $report->state);
        self::assertStringContainsString('does not override', $report->summary);
        self::assertStringContainsString('false', $control->plan()[0]);
    }

    public function testAlreadyTrueIsGoodEvenWithTheToggleOff(): void
    {
        $control = new FileEditing(new FakeConstants(['DISALLOW_FILE_EDIT' => true]));
        self::assertSame(State::Good, $control->report(false)->state);
        self::assertStringContainsString('nothing changes', $control->plan()[0]);
    }
}
