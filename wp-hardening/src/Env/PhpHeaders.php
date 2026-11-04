<?php

declare(strict_types=1);

namespace WpHardening\Env;

final class PhpHeaders implements Headers
{
    public function sent(): array
    {
        $names = [];
        foreach (headers_list() as $line) {
            $names[] = trim(strstr($line, ':', true) ?: $line);
        }
        return $names;
    }

    public function send(string $name, string $value): void
    {
        header($name . ': ' . $value);
    }

    public function canSend(): bool
    {
        return !headers_sent();
    }
}
