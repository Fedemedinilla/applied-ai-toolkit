<?php

declare(strict_types=1);

namespace WpHardening\Env;

/** IP parsing for the login limiter: allowlist ranges and the bucket an address is counted in. */
final class IpAddress
{
    public static function isValid(string $ip): bool
    {
        return filter_var($ip, FILTER_VALIDATE_IP) !== false;
    }

    /** An address, or an address with a prefix length ("203.0.113.0/24", "2001:db8::/48"). */
    public static function isValidRange(string $range): bool
    {
        return self::parseRange($range) !== null;
    }

    /**
     * The address in canonical form, or null when it is not one. An IPv4-mapped IPv6 address
     * (::ffff:203.0.113.9), which some dual-stack servers put in REMOTE_ADDR, becomes the IPv4
     * address it carries. Without this every IPv4 client on such a server lands in the same
     * IPv6 /64 bucket, and the allowlist's IPv4 ranges never match.
     */
    public static function normalize(string $ip): ?string
    {
        $ip = trim($ip);
        if (!self::isValid($ip)) {
            return null;
        }
        $packed = inet_pton($ip);
        if ($packed === false) {
            return null;
        }
        if (\strlen($packed) === 16 && substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff") {
            $v4 = inet_ntop(substr($packed, 12));
            return $v4 === false ? null : $v4;
        }
        return $ip;
    }

    public static function inRange(string $ip, string $range): bool
    {
        $parsed = self::parseRange($range);
        $ip = self::normalize($ip);
        $packed = $ip !== null ? inet_pton($ip) : false;
        if ($parsed === null || $packed === false) {
            return false;
        }
        [$network, $bits] = $parsed;
        if (\strlen($network) !== \strlen($packed)) {
            return false;
        }
        return self::prefix($packed, $bits) === self::prefix($network, $bits);
    }

    /**
     * The key failed logins are counted under. IPv4 counts per address. IPv6 counts per /64,
     * because one host usually holds a whole /64 and can rotate addresses inside it at will.
     */
    public static function bucket(string $ip): ?string
    {
        $ip = self::normalize($ip);
        if ($ip === null) {
            return null;
        }
        $packed = inet_pton($ip);
        if ($packed === false) {
            return null;
        }
        if (\strlen($packed) === 16) {
            $network = inet_ntop(self::prefix($packed, 64));
            return $network === false ? null : $network . '/64';
        }
        return $ip;
    }

    /** @return array{0: string, 1: int}|null */
    private static function parseRange(string $range): ?array
    {
        $range = trim($range);
        $parts = explode('/', $range, 2);
        $packed = self::isValid($parts[0]) ? inet_pton($parts[0]) : false;
        if ($packed === false) {
            return null;
        }
        $max = \strlen($packed) * 8;
        if (!isset($parts[1])) {
            return [$packed, $max];
        }
        if (preg_match('/^\d{1,3}$/', $parts[1]) !== 1 || (int) $parts[1] > $max) {
            return null;
        }
        return [$packed, (int) $parts[1]];
    }

    private static function prefix(string $packed, int $bits): string
    {
        $out = '';
        $length = \strlen($packed);
        for ($i = 0; $i < $length; $i++) {
            $take = max(0, min(8, $bits - $i * 8));
            $mask = $take === 0 ? 0 : (0xFF << (8 - $take)) & 0xFF;
            $out .= \chr(\ord($packed[$i]) & $mask);
        }
        return $out;
    }
}
