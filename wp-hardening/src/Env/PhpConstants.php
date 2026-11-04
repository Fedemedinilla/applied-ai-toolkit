<?php

declare(strict_types=1);

namespace WpHardening\Env;

final class PhpConstants implements Constants
{
    public function defined(string $name): bool
    {
        return \defined($name);
    }

    public function value(string $name): mixed
    {
        return \defined($name) ? \constant($name) : null;
    }

    public function define(string $name, bool|int|string $value): void
    {
        if (!\defined($name)) {
            \define($name, $value);
        }
    }
}
