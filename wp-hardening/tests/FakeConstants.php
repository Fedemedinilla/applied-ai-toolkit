<?php

declare(strict_types=1);

namespace WpHardening\Tests;

use WpHardening\Env\Constants;

final class FakeConstants implements Constants
{
    /** @param array<string, mixed> $values */
    public function __construct(public array $values = [])
    {
    }

    public function defined(string $name): bool
    {
        return \array_key_exists($name, $this->values);
    }

    public function value(string $name): mixed
    {
        return $this->values[$name] ?? null;
    }

    public function define(string $name, bool|int|string $value): void
    {
        if (!$this->defined($name)) {
            $this->values[$name] = $value;
        }
    }
}
