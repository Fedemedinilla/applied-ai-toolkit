<?php

declare(strict_types=1);

namespace WpHardening\Cli;

final class WpCliOutput implements Output
{
    public function line(string $text): void
    {
        \WP_CLI::line($text);
    }

    public function table(array $rows, array $fields): void
    {
        \WP_CLI\Utils\format_items('table', $rows, $fields);
    }

    public function json(mixed $data): void
    {
        // Evidence holds file names from disk, which need not be UTF-8. Without the substitute
        // flag one such name makes json_encode() return false and the whole report vanish.
        \WP_CLI::line(json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR));
    }

    public function error(string $message): never
    {
        \WP_CLI::error($message);
        exit(1);
    }

    public function halt(int $code): never
    {
        \WP_CLI::halt($code);
        exit($code);
    }
}
