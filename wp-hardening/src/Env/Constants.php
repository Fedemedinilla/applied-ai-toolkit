<?php

declare(strict_types=1);

namespace WpHardening\Env;

/**
 * Reads and defines PHP constants. A constant cannot be undefined once a process defines it, so
 * every control that looks at wp-config.php constants goes through this seam and the tests pass a
 * fake.
 */
interface Constants
{
    public function defined(string $name): bool;

    public function value(string $name): mixed;

    public function define(string $name, bool|int|string $value): void;
}
