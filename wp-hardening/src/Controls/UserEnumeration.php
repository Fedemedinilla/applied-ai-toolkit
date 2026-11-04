<?php

declare(strict_types=1);

namespace WpHardening\Controls;

use WpHardening\Control;
use WpHardening\Report;
use WpHardening\State;

/**
 * SEG-08. Stops anonymous visitors from listing user names, in the three places WordPress hands
 * them out: the /wp/v2/users REST routes, the ?author=N redirect to /author/<login>/, and the
 * users sitemap.
 *
 * Guard: the rest of the REST API is untouched. The block editor, Elementor and most plugins need
 * it, and disabling the whole API is the usual way this measure breaks a site. Logged-in users
 * keep /wp/v2/users, which the editor uses for the author picker.
 */
final class UserEnumeration implements Control
{
    /** WordPress matches routes without regard to case, so /WP/V2/Users reaches the same handler. */
    private const ROUTE = '#^/wp/v2/users(?:/.*)?$#i';

    public function id(): string
    {
        return 'user_enumeration';
    }

    public function title(): string
    {
        return __('User names hidden from anonymous visitors', 'wp-hardening');
    }

    public function register(): void
    {
        add_filter('rest_pre_dispatch', [$this, 'filterRest'], 10, 3);
        add_action('template_redirect', [$this, 'blockAuthorQuery'], 1);
        add_filter('redirect_canonical', [$this, 'filterCanonical'], 10, 2);
        add_filter('wp_sitemaps_add_provider', [$this, 'filterSitemapProvider'], 10, 2);
    }

    public static function isUsersRoute(string $route): bool
    {
        return preg_match(self::ROUTE, $route) === 1;
    }

    /** Runs for embedded requests too (`?_embed` on a post), so the author record is refused there as well. */
    public function filterRest(mixed $result, mixed $server, mixed $request): mixed
    {
        if ($result !== null || is_user_logged_in()) {
            return $result;
        }
        if (!\is_object($request) || !method_exists($request, 'get_route')) {
            return $result;
        }
        $route = $request->get_route();
        if (!\is_string($route) || !self::isUsersRoute($route)) {
            return $result;
        }
        return new \WP_Error(
            'rest_user_cannot_view',
            __('Sorry, you are not allowed to list users.', 'wp-hardening'),
            ['status' => 401],
        );
    }

    /**
     * Whether the request asks for an author by id. Without an argument it reads what WordPress
     * parsed ($wp->query_vars), then $_GET and $_POST: WP::parse_request takes public query vars
     * from POST too, so a POST with author=1 renders the author archive just like ?author=1.
     * Pretty /author/<slug>/ URLs set author_name, not author, and are not matched.
     *
     * @param array<array-key, mixed>|null $query
     */
    public static function hasAuthorQuery(?array $query = null): bool
    {
        if ($query !== null) {
            return self::authorIn($query);
        }
        $wp = $GLOBALS['wp'] ?? null;
        $parsed = \is_object($wp) && isset($wp->query_vars) && \is_array($wp->query_vars) ? $wp->query_vars : [];
        return self::authorIn($parsed) || self::authorIn($_GET) || self::authorIn($_POST);
    }

    /** @param array<array-key, mixed> $query */
    private static function authorIn(array $query): bool
    {
        return isset($query['author']) && \is_scalar($query['author']) && trim((string) $query['author']) !== '';
    }

    /**
     * Turns an anonymous ?author=N request (GET or POST) into a 404 before redirect_canonical (priority 10) can
     * send it to /author/<login>/. set_404() clears is_author(), so no redirect follows.
     */
    public function blockAuthorQuery(): void
    {
        if (is_user_logged_in() || is_admin() || !self::hasAuthorQuery()) {
            return;
        }
        global $wp_query;
        if (\is_object($wp_query) && method_exists($wp_query, 'set_404')) {
            $wp_query->set_404();
        }
        status_header(404);
        nocache_headers();
    }

    public function filterCanonical(mixed $redirect, mixed $requested = null): mixed
    {
        if (!is_user_logged_in() && self::hasAuthorQuery()) {
            return false;
        }
        return $redirect;
    }

    public function filterSitemapProvider(mixed $provider, mixed $name): mixed
    {
        return $name === 'users' ? false : $provider;
    }

    public function report(bool $enabled): Report
    {
        if ($enabled) {
            return new Report(
                State::Good,
                __('Anonymous visitors get a 401 from /wp/v2/users, a 404 for ?author=N, and no users sitemap.', 'wp-hardening'),
                [__('The rest of the REST API answers as before.', 'wp-hardening')],
            );
        }
        return new Report(
            State::Recommended,
            __('Anyone can list the login names of the authors on this site through /wp-json/wp/v2/users or ?author=1.', 'wp-hardening'),
            [__('A login name is half of what a password-guessing attack needs.', 'wp-hardening')],
        );
    }

    public function plan(): array
    {
        return [
            'Anonymous requests to /wp/v2/users and /wp/v2/users/<id> get a 401; logged-in users keep them.',
            'Anonymous ?author=N gets a 404 instead of the redirect to /author/<login>/.',
            'Removes the users sitemap. Every other REST route and sitemap is unchanged.',
        ];
    }
}
