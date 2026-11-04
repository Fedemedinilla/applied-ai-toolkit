<?php

declare(strict_types=1);

namespace WpHardening;

use WpHardening\Env\IpAddress;

/**
 * The plugin's single option. Every control starts off: activating the plugin changes nothing,
 * and each control is turned on by itself (settings page or `wp harden apply --only=<id>`), so a
 * change that breaks a site can be traced to one toggle.
 */
final class Settings
{
    public const OPTION = 'wp_hardening';

    public const CONTROLS = ['file_edit', 'xmlrpc', 'user_enumeration', 'headers', 'version', 'login', 'server_rules'];

    /** One year: the minimum max-age the HSTS preload list accepts. */
    public const PRELOAD_MIN_AGE = 31536000;

    public const MAX_HSTS_AGE = 63072000;

    /** Request headers the limiter may read the client address from, when a proxy is in front. */
    public const PROXY_HEADERS = ['', 'HTTP_CF_CONNECTING_IP', 'HTTP_X_REAL_IP', 'HTTP_X_FORWARDED_FOR'];

    public const DEFAULT_CSP = "default-src 'self' https: data: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'";

    public const DEFAULTS = [
        'enabled' => [
            'file_edit' => false,
            'xmlrpc' => false,
            'user_enumeration' => false,
            'headers' => false,
            'version' => false,
            'login' => false,
            'server_rules' => false,
        ],
        'xmlrpc_keep_for_app' => false,
        // 180 days, the value in the source checklist. No includeSubDomains and no preload until every
        // subdomain has been checked over HTTPS.
        'hsts_max_age' => 15552000,
        'hsts_subdomains' => false,
        'hsts_preload' => false,
        'csp_report_only' => self::DEFAULT_CSP,
        'csp_report_uri' => '',
        'login_max_attempts' => 5,
        'login_window_minutes' => 15,
        'login_lockout_minutes' => 15,
        'login_allowlist' => [],
        'login_proxy_header' => '',
    ];

    /** @param array<string, mixed> $values Already sanitized. */
    private function __construct(private readonly array $values)
    {
    }

    public static function load(): self
    {
        $stored = get_option(self::OPTION, []);
        return self::fromArray(\is_array($stored) ? $stored : []);
    }

    /** @param array<array-key, mixed> $stored */
    public static function fromArray(array $stored): self
    {
        return new self(self::sanitize($stored)['values']);
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return $this->values;
    }

    public function enabled(string $control): bool
    {
        $enabled = $this->values['enabled'];
        return \is_array($enabled) && ($enabled[$control] ?? false) === true;
    }

    /** A copy with one control's toggle changed. */
    public function withEnabled(string $control, bool $on): self
    {
        if (!\in_array($control, self::CONTROLS, true)) {
            throw new \InvalidArgumentException("Unknown control: {$control}");
        }
        $values = $this->values;
        $enabled = \is_array($values['enabled']) ? $values['enabled'] : [];
        $enabled[$control] = $on;
        $values['enabled'] = $enabled;
        return new self($values);
    }

    public function bool(string $key): bool
    {
        return ($this->values[$key] ?? false) === true;
    }

    public function int(string $key): int
    {
        $value = $this->values[$key] ?? 0;
        return \is_int($value) ? $value : 0;
    }

    public function string(string $key): string
    {
        $value = $this->values[$key] ?? '';
        return \is_string($value) ? $value : '';
    }

    /** @return list<string> */
    public function allowlist(): array
    {
        $list = $this->values['login_allowlist'] ?? [];
        return \is_array($list) ? array_values(array_filter($list, 'is_string')) : [];
    }

    /**
     * Cleans what the settings form (or a stored option) holds. Anything unknown is dropped,
     * anything invalid falls back to its default, and each correction comes back as a message.
     *
     * @param mixed $input
     * @return array{values: array<string, mixed>, errors: list<string>}
     */
    public static function sanitize(mixed $input): array
    {
        $in = \is_array($input) ? $input : [];
        $errors = [];
        $out = self::DEFAULTS;

        $enabled = \is_array($in['enabled'] ?? null) ? $in['enabled'] : [];
        foreach (self::CONTROLS as $control) {
            $out['enabled'][$control] = self::truthy($enabled[$control] ?? false);
        }
        foreach (['xmlrpc_keep_for_app', 'hsts_subdomains', 'hsts_preload'] as $key) {
            $out[$key] = self::truthy($in[$key] ?? self::DEFAULTS[$key]);
        }

        $out['hsts_max_age'] = self::intIn($in, 'hsts_max_age', 0, self::MAX_HSTS_AGE, $errors);
        // The preload list only takes includeSubDomains with at least a year, so preload without
        // them would never be accepted, and with them it reaches every subdomain.
        if ($out['hsts_preload'] && (!$out['hsts_subdomains'] || $out['hsts_max_age'] < self::PRELOAD_MIN_AGE)) {
            $out['hsts_preload'] = false;
            $errors[] = 'HSTS preload needs includeSubDomains and a max-age of at least 31536000; preload was left off.';
        }

        $out['csp_report_only'] = self::headerValue($in, 'csp_report_only', $errors);
        $uri = self::headerValue($in, 'csp_report_uri', $errors);
        if ($uri !== '' && (preg_match('#^https://[^\s;,]+$#', $uri) !== 1)) {
            $errors[] = 'The CSP report URI must be an https:// URL; it was cleared.';
            $uri = '';
        }
        $out['csp_report_uri'] = $uri;

        $out['login_max_attempts'] = self::intIn($in, 'login_max_attempts', 3, 50, $errors);
        $out['login_window_minutes'] = self::intIn($in, 'login_window_minutes', 1, 1440, $errors);
        $out['login_lockout_minutes'] = self::intIn($in, 'login_lockout_minutes', 1, 1440, $errors);

        $rawList = $in['login_allowlist'] ?? [];
        $lines = \is_string($rawList) ? preg_split('/[\s,]+/', $rawList) : (\is_array($rawList) ? $rawList : []);
        $list = [];
        foreach ($lines ?: [] as $line) {
            if (!\is_string($line) || trim($line) === '') {
                continue;
            }
            $line = trim($line);
            if (IpAddress::isValidRange($line)) {
                $list[] = $line;
            } else {
                $errors[] = 'Not an IP address or range, dropped from the allowlist: ' . substr($line, 0, 64);
            }
        }
        $out['login_allowlist'] = array_values(array_unique($list));

        $header = $in['login_proxy_header'] ?? '';
        if (!\is_string($header) || !\in_array($header, self::PROXY_HEADERS, true)) {
            $errors[] = 'Unknown proxy header; the limiter reads REMOTE_ADDR.';
            $header = '';
        }
        $out['login_proxy_header'] = $header;

        return ['values' => $out, 'errors' => $errors];
    }

    private static function truthy(mixed $value): bool
    {
        return $value === true || $value === 1 || $value === '1' || $value === 'on' || $value === 'yes';
    }

    /**
     * @param array<array-key, mixed> $in
     * @param list<string> $errors
     */
    private static function intIn(array $in, string $key, int $min, int $max, array &$errors): int
    {
        $default = self::DEFAULTS[$key];
        \assert(\is_int($default));
        if (!\array_key_exists($key, $in)) {
            return $default;
        }
        $value = $in[$key];
        if (\is_string($value) && preg_match('/^\d+$/', trim($value)) === 1) {
            $value = (int) trim($value);
        }
        if (!\is_int($value) || $value < $min || $value > $max) {
            $errors[] = "{$key} must be a whole number from {$min} to {$max}; it was reset to {$default}.";
            return $default;
        }
        return $value;
    }

    /**
     * A value that ends up in a response header. A line break would let it add headers of its own,
     * so one is refused instead of stripped.
     *
     * @param array<array-key, mixed> $in
     * @param list<string> $errors
     */
    private static function headerValue(array $in, string $key, array &$errors): string
    {
        $default = self::DEFAULTS[$key];
        \assert(\is_string($default));
        $value = $in[$key] ?? $default;
        if (!\is_string($value)) {
            return $default;
        }
        $value = trim($value);
        if (preg_match('/[\x00-\x1F\x7F]/', $value) === 1) {
            $errors[] = "{$key} holds a control character or line break; it was reset.";
            return $default;
        }
        return $value;
    }
}
