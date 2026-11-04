<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use WpHardening\Env\IpAddress;

final class IpAddressTest extends TestCase
{
    /** @return list<array{string, string, bool}> */
    public static function ranges(): array
    {
        return [
            ['203.0.113.7', '203.0.113.7', true],
            ['203.0.113.8', '203.0.113.7', false],
            ['203.0.113.200', '203.0.113.0/24', true],
            ['203.0.114.1', '203.0.113.0/24', false],
            ['198.51.100.1', '198.51.100.0/31', true],
            ['198.51.100.2', '198.51.100.0/31', false],
            ['10.1.2.3', '0.0.0.0/0', true],
            ['2001:db8:0:1::5', '2001:db8::/48', true],
            ['2001:db9::1', '2001:db8::/48', false],
            ['2001:db8::1', '203.0.113.0/24', false],
            ['203.0.113.1', '2001:db8::/32', false],
            ['not-an-ip', '0.0.0.0/0', false],
            ['203.0.113.1', '203.0.113.0/40', false],
            ['::ffff:203.0.113.9', '203.0.113.0/24', true],
            ['::ffff:198.51.100.1', '203.0.113.0/24', false],
        ];
    }

    #[DataProvider('ranges')]
    public function testInRange(string $ip, string $range, bool $expected): void
    {
        self::assertSame($expected, IpAddress::inRange($ip, $range));
    }

    public function testValidRanges(): void
    {
        self::assertTrue(IpAddress::isValidRange('203.0.113.0/24'));
        self::assertTrue(IpAddress::isValidRange('2001:db8::/128'));
        self::assertFalse(IpAddress::isValidRange('2001:db8::/129'));
        self::assertFalse(IpAddress::isValidRange('203.0.113.0/'));
        self::assertFalse(IpAddress::isValidRange('203.0.113.0/-1'));
        self::assertFalse(IpAddress::isValidRange('example.test'));
    }

    public function testIpv4CountsPerAddressAndIpv6PerSlash64(): void
    {
        self::assertSame('203.0.113.7', IpAddress::bucket('203.0.113.7'));
        self::assertSame('2001:db8:1:2::/64', IpAddress::bucket('2001:db8:1:2:aaaa::1'));
        self::assertSame(IpAddress::bucket('2001:db8:1:2::1'), IpAddress::bucket('2001:db8:1:2:ffff:ffff:ffff:ffff'));
        self::assertNotSame(IpAddress::bucket('2001:db8:1:2::1'), IpAddress::bucket('2001:db8:1:3::1'));
        self::assertNull(IpAddress::bucket(''));
    }

    public function testIpv4MappedAddressesBecomeIpv4(): void
    {
        self::assertSame('198.51.100.1', IpAddress::normalize('::ffff:198.51.100.1'));
        self::assertSame('198.51.100.1', IpAddress::bucket('::ffff:198.51.100.1'));
        self::assertNotSame(IpAddress::bucket('::ffff:198.51.100.1'), IpAddress::bucket('::ffff:203.0.113.9'));
        self::assertSame('2001:db8::1', IpAddress::normalize(' 2001:db8::1 '));
        self::assertSame('::1', IpAddress::normalize('::1'));
        self::assertNull(IpAddress::normalize('not-an-ip'));
    }
}
