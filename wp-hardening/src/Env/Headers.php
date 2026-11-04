<?php

declare(strict_types=1);

namespace WpHardening\Env;

/** Where response headers go. Production writes with header(); the tests record. */
interface Headers
{
    /** Header names already queued for this response, as sent (any case). */
    public function sent(): array;

    public function send(string $name, string $value): void;

    public function canSend(): bool;
}
