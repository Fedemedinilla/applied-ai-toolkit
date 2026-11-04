<?php

declare(strict_types=1);

namespace WpHardening\Controls;

use WpHardening\Control;
use WpHardening\Env\IpAddress;
use WpHardening\Report;
use WpHardening\Settings;
use WpHardening\State;

/**
 * SEG-15. Counts failed logins per client address and refuses every login from that address for
 * a while once the count reaches the limit. It covers wp-login.php and XML-RPC, which both
 * authenticate through wp_authenticate().
 *
 * Guards:
 * - Addresses in the allowlist are never counted, so the owner's office cannot lock itself out.
 * - The lock is per address, never per user name. Locking a user name would let anyone lock the
 *   real administrator out by typing wrong passwords for it.
 * - The address is REMOTE_ADDR unless the owner names the header a proxy in front sets. Reading
 *   X-Forwarded-For by default would let an attacker pick a new address on every request.
 * - A request with no valid address (WP-CLI, a misconfigured proxy) is not counted, instead of
 *   being counted under one shared key that would lock everyone out at once.
 * - A successful login does not reset the count. If it did, anyone with one valid account (a
 *   shop customer, an open registration) could guess the administrator's password four times,
 *   log in as themselves, and repeat without limit. The count runs out with its window instead.
 */
final class LoginLimiter implements Control
{
    public const ERROR_CODE = 'wp_hardening_locked';

    /** @param \Closure(): int|null $now */
    public function __construct(
        private readonly Settings $settings,
        private readonly ?\Closure $now = null,
    ) {
    }

    public function id(): string
    {
        return 'login';
    }

    public function title(): string
    {
        return __('Login attempt limit', 'wp-hardening');
    }

    public function register(): void
    {
        // After wp_authenticate_username_password (20) and the e-mail variant (20), so a correct
        // password during a lockout is refused too.
        add_filter('authenticate', [$this, 'gate'], 99, 1);
        add_action('wp_login_failed', [$this, 'recordFailure'], 10, 1);
        add_filter('shake_error_codes', [$this, 'shakeCodes']);
    }

    /** @param array<array-key, mixed>|null $server Defaults to $_SERVER. */
    public function clientIp(?array $server = null): ?string
    {
        $server ??= $_SERVER;
        $header = $this->settings->string('login_proxy_header');
        $candidate = null;
        if ($header !== '' && \is_string($server[$header] ?? null)) {
            $value = $server[$header];
            // A proxy appends the address it saw, so the last entry is the one it vouches for.
            $entries = array_map('trim', explode(',', $value));
            $candidate = $header === 'HTTP_X_FORWARDED_FOR' ? end($entries) : $entries[0];
        } elseif (\is_string($server['REMOTE_ADDR'] ?? null)) {
            $candidate = trim($server['REMOTE_ADDR']);
        }
        return \is_string($candidate) ? IpAddress::normalize($candidate) : null;
    }

    public function allowlisted(string $ip): bool
    {
        foreach ($this->settings->allowlist() as $range) {
            if (IpAddress::inRange($ip, $range)) {
                return true;
            }
        }
        return false;
    }

    public function gate(mixed $user): mixed
    {
        $ip = $this->clientIp();
        if ($ip === null || $this->allowlisted($ip)) {
            return $user;
        }
        $until = $this->lockedUntil($ip);
        if ($until === null) {
            return $user;
        }
        $minutes = max(1, (int) ceil(($until - $this->now()) / 60));
        return new \WP_Error(
            self::ERROR_CODE,
            \sprintf(__('Too many failed logins from this address. Try again in %d minutes.', 'wp-hardening'), $minutes),
        );
    }

    public function recordFailure(mixed $username = null): void
    {
        $ip = $this->clientIp();
        if ($ip === null || $this->allowlisted($ip)) {
            return;
        }
        // A failure during a lockout does not extend it, so the lockout length is predictable.
        if ($this->lockedUntil($ip) !== null) {
            return;
        }
        $key = $this->key('count', $ip);
        $now = $this->now();
        $window = $this->settings->int('login_window_minutes') * 60;
        $entry = get_transient($key);
        if (\is_array($entry) && \is_int($entry['first'] ?? null) && \is_int($entry['count'] ?? null) && $now - $entry['first'] < $window) {
            $first = $entry['first'];
            $count = $entry['count'] + 1;
        } else {
            $first = $now;
            $count = 1;
        }
        if ($count >= $this->settings->int('login_max_attempts')) {
            $lockout = $this->settings->int('login_lockout_minutes') * 60;
            set_transient($this->key('lock', $ip), $now + $lockout, $lockout);
            delete_transient($key);
            return;
        }
        set_transient($key, ['first' => $first, 'count' => $count], max(1, $window - ($now - $first)));
    }

    /**
     * @param array<array-key, mixed> $codes
     * @return array<array-key, mixed>
     */
    public function shakeCodes(mixed $codes): mixed
    {
        if (\is_array($codes)) {
            $codes[] = self::ERROR_CODE;
        }
        return $codes;
    }

    public function lockedUntil(string $ip): ?int
    {
        $until = get_transient($this->key('lock', $ip));
        return \is_int($until) && $until > $this->now() ? $until : null;
    }

    /** Transient names are capped at 172 characters; a hash of the bucket fits and keeps addresses out of option names. */
    private function key(string $kind, string $ip): string
    {
        $bucket = IpAddress::bucket($ip) ?? $ip;
        return 'wph_' . $kind . '_' . substr(hash('sha256', $bucket), 0, 32);
    }

    private function now(): int
    {
        return $this->now !== null ? ($this->now)() : time();
    }

    public function report(bool $enabled): Report
    {
        $max = $this->settings->int('login_max_attempts');
        $window = $this->settings->int('login_window_minutes');
        $lockout = $this->settings->int('login_lockout_minutes');
        $allow = \count($this->settings->allowlist());
        if (!$enabled) {
            return new Report(
                State::Recommended,
                __('Failed logins are not limited. A script can try passwords on wp-login.php and XML-RPC without pause.', 'wp-hardening'),
                [__('Before turning this on, add the addresses you log in from to the allowlist.', 'wp-hardening')],
            );
        }
        $details = [];
        if ($allow === 0) {
            $details[] = __('The allowlist is empty: the owner can be locked out like anyone else.', 'wp-hardening');
        }
        if ($this->settings->string('login_proxy_header') === '' && \is_string($_SERVER['HTTP_X_FORWARDED_FOR'] ?? null)) {
            $details[] = __('This request came through a proxy (X-Forwarded-For is set) but the limiter reads REMOTE_ADDR, so every visitor may share one address. Name the proxy header in the settings.', 'wp-hardening');
        }
        return new Report(
            $details === [] ? State::Good : State::Recommended,
            \sprintf(__('%1$d failed logins in %2$d minutes lock an address for %3$d minutes. %4$d allowlist entries.', 'wp-hardening'), $max, $window, $lockout, $allow),
            $details,
        );
    }

    public function plan(): array
    {
        $lines = [\sprintf(
            '%d failed logins from one address in %d minutes refuse every login from it for %d minutes (wp-login.php and XML-RPC).',
            $this->settings->int('login_max_attempts'),
            $this->settings->int('login_window_minutes'),
            $this->settings->int('login_lockout_minutes'),
        )];
        $lines[] = $this->settings->allowlist() === []
            ? 'Guard missing: the allowlist is empty. Add your own address first (settings, "Never lock these addresses").'
            : 'Never locked: ' . implode(', ', $this->settings->allowlist()) . '.';
        $header = $this->settings->string('login_proxy_header');
        $lines[] = 'Client address read from ' . ($header === '' ? 'REMOTE_ADDR' : $header) . '.';
        return $lines;
    }
}
