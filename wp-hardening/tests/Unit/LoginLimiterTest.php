<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use WpHardening\Controls\LoginLimiter;
use WpHardening\Settings;
use WpHardening\State;
use WpHardening\Tests\TestCase;

final class LoginLimiterTest extends TestCase
{
    private int $now = 1_700_000_000;

    /** @var \ArrayObject<string, mixed> */
    private \ArrayObject $store;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = $this->transients();
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        unset($_SERVER['HTTP_X_FORWARDED_FOR'], $_SERVER['HTTP_CF_CONNECTING_IP']);
    }

    protected function tearDown(): void
    {
        unset($_SERVER['REMOTE_ADDR'], $_SERVER['HTTP_X_FORWARDED_FOR'], $_SERVER['HTTP_CF_CONNECTING_IP']);
        parent::tearDown();
    }

    /** @param array<string, mixed> $settings */
    private function limiter(array $settings = []): LoginLimiter
    {
        return new LoginLimiter(Settings::fromArray($settings + ['login_max_attempts' => 3]), fn (): int => $this->now);
    }

    private function failTimes(LoginLimiter $limiter, int $times): void
    {
        for ($i = 0; $i < $times; $i++) {
            $limiter->recordFailure('editor');
        }
    }

    public function testLocksAfterTheLimitEvenForACorrectPassword(): void
    {
        $limiter = $this->limiter();
        $this->failTimes($limiter, 2);
        $user = new \WP_User();
        self::assertSame($user, $limiter->gate($user));
        $this->failTimes($limiter, 1);
        $result = $limiter->gate($user);
        self::assertInstanceOf(\WP_Error::class, $result);
        self::assertSame(LoginLimiter::ERROR_CODE, $result->get_error_code());
        self::assertStringContainsString('15 minutes', $result->message);
    }

    public function testLockoutExpires(): void
    {
        $limiter = $this->limiter();
        $this->failTimes($limiter, 3);
        $this->now += 15 * 60 - 1;
        self::assertInstanceOf(\WP_Error::class, $limiter->gate(null));
        $this->now += 2;
        self::assertNull($limiter->gate(null));
    }

    public function testFailuresDuringALockoutDoNotExtendIt(): void
    {
        $limiter = $this->limiter();
        $this->failTimes($limiter, 3);
        $until = $limiter->lockedUntil('203.0.113.7');
        $this->now += 600;
        $this->failTimes($limiter, 10);
        self::assertSame($until, $limiter->lockedUntil('203.0.113.7'));
    }

    public function testFixedCountingWindowRestartsAfterItEnds(): void
    {
        $limiter = $this->limiter();
        $this->failTimes($limiter, 2);
        $this->now += 15 * 60;
        $this->failTimes($limiter, 2);
        self::assertNull($limiter->gate(null));
        $this->failTimes($limiter, 1);
        self::assertInstanceOf(\WP_Error::class, $limiter->gate(null));
    }

    public function testTheCounterExpiresWithTheWindow(): void
    {
        $limiter = $this->limiter();
        $this->failTimes($limiter, 1);
        $this->now += 60;
        $this->failTimes($limiter, 1);
        $ttls = array_values(array_filter($this->store->getArrayCopy(), static fn ($v, $k): bool => str_starts_with((string) $k, 'ttl:'), ARRAY_FILTER_USE_BOTH));
        self::assertSame([14 * 60], $ttls);
    }

    public function testGuardAllowlistedAddressesAreNeverLocked(): void
    {
        $limiter = $this->limiter(['login_allowlist' => ['203.0.113.0/24']]);
        $this->failTimes($limiter, 20);
        self::assertNull($limiter->gate(null));
        self::assertSame([], $this->store->getArrayCopy());
    }

    public function testGuardTheLockIsPerAddressNotPerUserName(): void
    {
        $limiter = $this->limiter();
        $this->failTimes($limiter, 3);
        $_SERVER['REMOTE_ADDR'] = '198.51.100.20';
        $user = new \WP_User(1, 'admin');
        self::assertSame($user, $limiter->gate($user));
    }

    public function testIpv6AddressesInOneSlash64ShareACounter(): void
    {
        $limiter = $this->limiter();
        foreach (['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff::9'] as $ip) {
            $_SERVER['REMOTE_ADDR'] = $ip;
            $limiter->recordFailure('editor');
        }
        $_SERVER['REMOTE_ADDR'] = '2001:db8:1:2::abcd';
        self::assertInstanceOf(\WP_Error::class, $limiter->gate(null));
        $_SERVER['REMOTE_ADDR'] = '2001:db8:1:3::1';
        self::assertNull($limiter->gate(null));
    }

    public function testGuardARequestWithNoAddressIsNotCounted(): void
    {
        unset($_SERVER['REMOTE_ADDR']);
        $limiter = $this->limiter();
        $this->failTimes($limiter, 10);
        self::assertSame([], $this->store->getArrayCopy());
        self::assertNull($limiter->gate(null));
    }

    public function testGuardForwardedForIsIgnoredUnlessConfigured(): void
    {
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '192.0.2.1';
        self::assertSame('203.0.113.7', $this->limiter()->clientIp());
        $report = $this->limiter()->report(true);
        self::assertStringContainsString('X-Forwarded-For', implode(' ', $report->details));
    }

    public function testConfiguredProxyHeaders(): void
    {
        $xff = $this->limiter(['login_proxy_header' => 'HTTP_X_FORWARDED_FOR']);
        self::assertSame('198.51.100.9', $xff->clientIp(['HTTP_X_FORWARDED_FOR' => '192.0.2.66, 198.51.100.9', 'REMOTE_ADDR' => '10.0.0.1']));
        self::assertNull($xff->clientIp(['HTTP_X_FORWARDED_FOR' => 'garbage', 'REMOTE_ADDR' => '10.0.0.1']));
        $cf = $this->limiter(['login_proxy_header' => 'HTTP_CF_CONNECTING_IP']);
        self::assertSame('2001:db8::5', $cf->clientIp(['HTTP_CF_CONNECTING_IP' => '2001:db8::5', 'REMOTE_ADDR' => '10.0.0.1']));
    }

    public function testGuardASuccessfulLoginDoesNotResetTheCount(): void
    {
        // An attacker with one valid account of their own: 2 wrong guesses for the administrator,
        // a successful login as themselves, then one more guess. Nothing listens on wp_login, so
        // the login in between changes nothing and the third failure still locks.
        $limiter = $this->limiter();
        $limiter->register();
        self::assertFalse(has_action('wp_login'));
        $this->failTimes($limiter, 2);
        self::assertInstanceOf(\WP_User::class, $limiter->gate(new \WP_User(7, 'customer')));
        $this->failTimes($limiter, 1);
        self::assertInstanceOf(\WP_Error::class, $limiter->gate(null));
    }

    public function testIpv4MappedAddressesAreCountedPerIpv4Address(): void
    {
        $limiter = $this->limiter(['login_allowlist' => ['192.0.2.0/24']]);
        $_SERVER['REMOTE_ADDR'] = '::ffff:198.51.100.1';
        $this->failTimes($limiter, 3);
        self::assertInstanceOf(\WP_Error::class, $limiter->gate(null));
        $_SERVER['REMOTE_ADDR'] = '::ffff:203.0.113.9';
        self::assertNull($limiter->gate(null));
        self::assertSame('203.0.113.9', $limiter->clientIp());
        $_SERVER['REMOTE_ADDR'] = '::ffff:192.0.2.10';
        self::assertTrue($limiter->allowlisted((string) $limiter->clientIp()));
    }

    public function testKeysDoNotHoldTheAddress(): void
    {
        $this->failTimes($this->limiter(), 1);
        foreach (array_keys($this->store->getArrayCopy()) as $key) {
            self::assertStringNotContainsString('203.0.113', (string) $key);
            self::assertLessThanOrEqual(172, \strlen((string) $key));
        }
    }

    public function testRegisterRunsAfterThePasswordCheck(): void
    {
        $limiter = $this->limiter();
        $limiter->register();
        self::assertSame(99, has_filter('authenticate', [$limiter, 'gate']));
        self::assertNotFalse(has_action('wp_login_failed', [$limiter, 'recordFailure']));
        self::assertSame(['a', LoginLimiter::ERROR_CODE], $limiter->shakeCodes(['a']));
    }

    public function testReport(): void
    {
        self::assertSame(State::Recommended, $this->limiter()->report(false)->state);
        $empty = $this->limiter()->report(true);
        self::assertSame(State::Recommended, $empty->state);
        self::assertStringContainsString('allowlist is empty', implode(' ', $empty->details));
        self::assertSame(State::Good, $this->limiter(['login_allowlist' => ['203.0.113.7']])->report(true)->state);
        self::assertStringContainsString('Guard missing', implode(' ', $this->limiter()->plan()));
    }
}
