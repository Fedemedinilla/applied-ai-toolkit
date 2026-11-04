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
        \WP_CLI::line((string) json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
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
