<?php

declare(strict_types=1);

namespace WpHardening;

/**
 * One hardening control. The plugin calls register() only when the control's toggle is on, so a
 * control that is off adds no hook at all. report() and plan() are read-only and safe to call on
 * any request.
 */
interface Control
{
    /** Stable id: the settings key, the Site Health test name and the WP-CLI argument. */
    public function id(): string;

    public function title(): string;

    /** Adds the control's hooks. Only called when the toggle is on. */
    public function register(): void;

    /** What is in force now, given whether the toggle is on. */
    public function report(bool $enabled): Report;

    /**
     * What turning the toggle on would do on this site, guards included, for `wp harden apply
     * --dry-run`. One sentence per line, no markup.
     *
     * @return list<string>
     */
    public function plan(): array;
}
