<?php

declare(strict_types=1);

namespace WpHardening\Audit;

use WpHardening\State;

enum Verdict: string
{
    case Pass = 'pass';
    case Warn = 'warn';
    case Fail = 'fail';
    case Info = 'info';
    /** The check could not run here: offline, or a file it needs is unreadable. Never read as a pass. */
    case Skip = 'skip';

    public function state(): State
    {
        return match ($this) {
            self::Pass, self::Info => State::Good,
            self::Warn, self::Skip => State::Recommended,
            self::Fail => State::Critical,
        };
    }
}
