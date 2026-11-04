<?php

declare(strict_types=1);

namespace WpHardening\Cli;

/** What the command writes to. WP-CLI in production; a buffer in the tests. */
interface Output
{
    public function line(string $text): void;

    /**
     * @param list<array<string, string>> $rows
     * @param list<string> $fields
     */
    public function table(array $rows, array $fields): void;

    public function json(mixed $data): void;

    /** Prints the message and stops with exit code 1. */
    public function error(string $message): never;

    public function halt(int $code): never;
}
