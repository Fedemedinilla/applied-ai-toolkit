<?php

declare(strict_types=1);

namespace WpHardening\Tests;

use WpHardening\Cli\Output;

final class BufferOutput implements Output
{
    /** @var list<string> */
    public array $lines = [];

    /** @var list<array{rows: list<array<string, string>>, fields: list<string>}> */
    public array $tables = [];

    /** @var list<mixed> */
    public array $json = [];

    public function line(string $text): void
    {
        $this->lines[] = $text;
    }

    public function table(array $rows, array $fields): void
    {
        $this->tables[] = ['rows' => $rows, 'fields' => $fields];
    }

    public function json(mixed $data): void
    {
        $this->json[] = $data;
    }

    public function error(string $message): never
    {
        $this->lines[] = 'Error: ' . $message;
        throw new CliStop($message, 1);
    }

    public function halt(int $code): never
    {
        throw new CliStop('halt', $code);
    }

    public function text(): string
    {
        return implode("\n", $this->lines);
    }
}
