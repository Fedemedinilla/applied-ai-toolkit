<?php

declare(strict_types=1);

// Minimal stand-ins for the WordPress classes the plugin touches. Functions are stubbed per test
// with Brain Monkey; classes cannot be, so these hold only what the code reads.

final class WP_Error
{
    /** @param array<string, mixed> $data */
    public function __construct(public string $code = '', public string $message = '', public array $data = [])
    {
    }

    public function get_error_code(): string
    {
        return $this->code;
    }

    /** @return array<string, mixed> */
    public function get_error_data(): array
    {
        return $this->data;
    }
}

final class WP_REST_Request
{
    public function __construct(private string $route)
    {
    }

    public function get_route(): string
    {
        return $this->route;
    }
}

final class WP_User
{
    public function __construct(public int $ID = 1, public string $user_login = 'editor')
    {
    }
}

final class WP_Query
{
    public bool $is404 = false;

    public function set_404(): void
    {
        $this->is404 = true;
    }
}

final class WP_Application_Passwords
{
    /** @var array<int, list<array<string, mixed>>> */
    public static array $byUser = [];

    /** @return list<array<string, mixed>> */
    public static function get_user_application_passwords(int $userId): array
    {
        return self::$byUser[$userId] ?? [];
    }
}
