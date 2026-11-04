<?php

declare(strict_types=1);

namespace WpHardening\Tests;

use WpHardening\Env\Headers;

final class FakeHeaders implements Headers
{
    /** @var array<string, string> */
    public array $out = [];

    /** @param list<string> $already */
    public function __construct(public array $already = [], public bool $open = true)
    {
    }

    public function sent(): array
    {
        return [...$this->already, ...array_keys($this->out)];
    }

    public function send(string $name, string $value): void
    {
        $this->out[$name] = $value;
    }

    public function canSend(): bool
    {
        return $this->open;
    }
}
