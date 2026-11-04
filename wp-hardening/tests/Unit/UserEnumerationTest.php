<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use PHPUnit\Framework\Attributes\DataProvider;
use WpHardening\Controls\UserEnumeration;
use WpHardening\State;
use WpHardening\Tests\TestCase;

final class UserEnumerationTest extends TestCase
{
    protected function tearDown(): void
    {
        $_GET = [];
        $_POST = [];
        unset($GLOBALS['wp_query'], $GLOBALS['wp']);
        parent::tearDown();
    }

    /** @return list<array{string, bool}> */
    public static function routes(): array
    {
        return [
            ['/wp/v2/users', true],
            ['/wp/v2/users/', true],
            ['/wp/v2/users/1', true],
            ['/wp/v2/users/me', true],
            ['/WP/V2/Users/1', true],
            ['/wp/v2/usersettings', false],
            ['/wp/v2/posts', false],
            ['/wp/v2/posts/1', false],
            ['/wp/v2/types', false],
            ['/', false],
            ['/oembed/1.0/embed', false],
            ['/wc/v3/customers', false],
        ];
    }

    #[DataProvider('routes')]
    public function testRouteMatch(string $route, bool $blocked): void
    {
        self::assertSame($blocked, UserEnumeration::isUsersRoute($route));
    }

    public function testAnonymousRequestToUsersGets401(): void
    {
        $result = (new UserEnumeration())->filterRest(null, null, new \WP_REST_Request('/wp/v2/users'));
        self::assertInstanceOf(\WP_Error::class, $result);
        self::assertSame(401, $result->get_error_data()['status']);
    }

    public function testGuardTheRestOfRestIsUntouched(): void
    {
        $control = new UserEnumeration();
        foreach (['/wp/v2/posts', '/wp/v2/pages/2', '/', '/elementor/v1/globals'] as $route) {
            self::assertNull($control->filterRest(null, null, new \WP_REST_Request($route)), $route);
        }
    }

    public function testGuardLoggedInUsersKeepTheUsersRoute(): void
    {
        Functions\when('is_user_logged_in')->justReturn(true);
        self::assertNull((new UserEnumeration())->filterRest(null, null, new \WP_REST_Request('/wp/v2/users')));
    }

    public function testAnEarlierResultPassesThrough(): void
    {
        $earlier = ['already' => 'answered'];
        self::assertSame($earlier, (new UserEnumeration())->filterRest($earlier, null, new \WP_REST_Request('/wp/v2/users')));
        self::assertNull((new UserEnumeration())->filterRest(null, null, 'not a request'));
    }

    public function testAnonymousAuthorQueryBecomesA404(): void
    {
        $_GET = ['author' => '1'];
        $GLOBALS['wp_query'] = new \WP_Query();
        Functions\expect('status_header')->once()->with(404);
        Functions\expect('nocache_headers')->once();
        $control = new UserEnumeration();
        $control->blockAuthorQuery();
        self::assertTrue($GLOBALS['wp_query']->is404);
        self::assertFalse($control->filterCanonical('https://site.example/author/editor/'));
    }

    /** WP::parse_request reads public query vars from POST as well, so POST author=1 is an author archive too. */
    public function testAnonymousPostedAuthorBecomesA404(): void
    {
        $_POST = ['author' => '1'];
        $GLOBALS['wp_query'] = new \WP_Query();
        Functions\expect('status_header')->once()->with(404);
        Functions\expect('nocache_headers')->once();
        (new UserEnumeration())->blockAuthorQuery();
        self::assertTrue($GLOBALS['wp_query']->is404);
    }

    public function testTheParsedQueryIsReadToo(): void
    {
        $GLOBALS['wp'] = (object) ['query_vars' => ['author' => '2']];
        self::assertTrue(UserEnumeration::hasAuthorQuery());
        $GLOBALS['wp'] = (object) ['query_vars' => ['author_name' => 'editor']];
        self::assertFalse(UserEnumeration::hasAuthorQuery(), 'a pretty /author/<slug>/ archive is left alone');
    }

    public function testAuthorQueryIsLeftAloneForLoggedInUsersAndOtherRequests(): void
    {
        Functions\expect('status_header')->never();
        $control = new UserEnumeration();

        $_GET = ['p' => '5'];
        $control->blockAuthorQuery();
        self::assertSame('https://site.example/post/', $control->filterCanonical('https://site.example/post/'));

        $_GET = ['author' => '1'];
        Functions\when('is_user_logged_in')->justReturn(true);
        $control->blockAuthorQuery();
        self::assertSame('https://site.example/author/editor/', $control->filterCanonical('https://site.example/author/editor/'));
    }

    public function testAuthorQueryDetection(): void
    {
        self::assertTrue(UserEnumeration::hasAuthorQuery(['author' => '3']));
        self::assertTrue(UserEnumeration::hasAuthorQuery(['author' => '-1']));
        self::assertFalse(UserEnumeration::hasAuthorQuery(['author' => '']));
        self::assertFalse(UserEnumeration::hasAuthorQuery(['author' => ['1']]));
        self::assertFalse(UserEnumeration::hasAuthorQuery([]));
    }

    public function testOnlyTheUsersSitemapIsRemoved(): void
    {
        $control = new UserEnumeration();
        $provider = new \stdClass();
        self::assertFalse($control->filterSitemapProvider($provider, 'users'));
        self::assertSame($provider, $control->filterSitemapProvider($provider, 'posts'));
        self::assertSame($provider, $control->filterSitemapProvider($provider, 'taxonomies'));
    }

    public function testRegisterAndReport(): void
    {
        $control = new UserEnumeration();
        $control->register();
        self::assertNotFalse(has_filter('rest_pre_dispatch', [$control, 'filterRest']));
        self::assertSame(1, has_action('template_redirect', [$control, 'blockAuthorQuery']));
        self::assertSame(State::Good, $control->report(true)->state);
        self::assertSame(State::Recommended, $control->report(false)->state);
    }
}
