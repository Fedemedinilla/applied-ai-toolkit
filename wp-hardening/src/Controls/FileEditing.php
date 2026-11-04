<?php

declare(strict_types=1);

namespace WpHardening\Controls;

use WpHardening\Control;
use WpHardening\Env\Constants;
use WpHardening\Report;
use WpHardening\State;

/**
 * SEG-06. Defines DISALLOW_FILE_EDIT as true, which removes the theme and plugin file editors
 * from the dashboard. WordPress reads the constant when it maps capabilities, after plugins load,
 * so defining it here has the same effect as the line in wp-config.php without editing that file.
 */
final class FileEditing implements Control
{
    private const NAME = 'DISALLOW_FILE_EDIT';

    public function __construct(private readonly Constants $constants)
    {
    }

    public function id(): string
    {
        return 'file_edit';
    }

    public function title(): string
    {
        return __('Dashboard file editor disabled', 'wp-hardening');
    }

    public function register(): void
    {
        // Guard: a value already set in wp-config.php wins, including an explicit false.
        if (!$this->constants->defined(self::NAME)) {
            $this->constants->define(self::NAME, true);
        }
    }

    public function report(bool $enabled): Report
    {
        if ($this->constants->defined(self::NAME)) {
            if ($this->constants->value(self::NAME) === true) {
                return new Report(State::Good, __('DISALLOW_FILE_EDIT is true: the theme and plugin editors are off.', 'wp-hardening'));
            }
            return new Report(
                State::Recommended,
                __('DISALLOW_FILE_EDIT is defined as false, most likely in wp-config.php. This plugin does not override it.', 'wp-hardening'),
                [__('Change it to true in wp-config.php, with a copy of the file first: a syntax error there blanks the whole site.', 'wp-hardening')],
            );
        }
        return new Report(
            State::Recommended,
            __('The theme and plugin editors are on. Anyone who takes over an administrator account can write PHP from the dashboard.', 'wp-hardening'),
            [__('Turn on this control, or add define( \'DISALLOW_FILE_EDIT\', true ); to wp-config.php.', 'wp-hardening')],
        );
    }

    public function plan(): array
    {
        if ($this->constants->defined(self::NAME)) {
            $value = $this->constants->value(self::NAME) === true ? 'true' : 'false';
            return ["DISALLOW_FILE_EDIT is already defined as {$value} (wp-config.php); nothing changes."];
        }
        return ['Defines DISALLOW_FILE_EDIT as true on every request. The editors leave the dashboard; wp-config.php is not edited.'];
    }
}
