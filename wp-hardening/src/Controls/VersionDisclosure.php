<?php

declare(strict_types=1);

namespace WpHardening\Controls;

use WpHardening\Control;
use WpHardening\Report;
use WpHardening\State;

/**
 * SEG-19. Removes the generator meta tag (pages and feeds) and replaces the value of ?ver= on
 * this site's scripts and styles with a keyed hash of it.
 *
 * Guard: ?ver= is how WordPress busts browser and CDN caches after an update. Stripping it leaves
 * visitors on stale CSS and JavaScript until those caches expire; a hash keeps a new value for
 * each new version. The hash is an HMAC with a site secret, because a plain hash of "6.8.3" can be
 * reversed by hashing every released version. Third-party URLs keep their ?ver= untouched.
 */
final class VersionDisclosure implements Control
{
    /** @param \Closure(): string|null $key Defaults to wp_salt('nonce'). */
    public function __construct(private readonly ?\Closure $key = null)
    {
    }

    public function id(): string
    {
        return 'version';
    }

    public function title(): string
    {
        return __('WordPress version hidden', 'wp-hardening');
    }

    public function register(): void
    {
        remove_action('wp_head', 'wp_generator');
        add_filter('the_generator', [$this, 'emptyGenerator']);
        add_filter('script_loader_src', [$this, 'filterSrc'], PHP_INT_MAX);
        add_filter('style_loader_src', [$this, 'filterSrc'], PHP_INT_MAX);
    }

    public function emptyGenerator(): string
    {
        return '';
    }

    public function filterSrc(mixed $src): mixed
    {
        if (!\is_string($src) || $src === '') {
            return $src;
        }
        $home = wp_parse_url(home_url());
        $host = \is_array($home) && \is_string($home['host'] ?? null) ? $home['host'] : '';
        $key = $this->key !== null ? ($this->key)() : wp_salt('nonce');
        return self::maskVersion($src, $host, $key);
    }

    /** Replaces each ver= value in a same-site URL with the first 10 hex digits of its HMAC. */
    public static function maskVersion(string $src, string $siteHost, string $key): string
    {
        $parts = parse_url($src);
        if ($parts === false) {
            return $src;
        }
        $host = $parts['host'] ?? null;
        if ($host !== null && ($siteHost === '' || strcasecmp($host, $siteHost) !== 0)) {
            return $src;
        }
        return (string) preg_replace_callback(
            '/([?&])ver=([^&#]*)/',
            static fn (array $m): string => $m[1] . 'ver=' . substr(hash_hmac('sha256', rawurldecode($m[2]), $key), 0, 10),
            $src,
        );
    }

    public function report(bool $enabled): Report
    {
        if ($enabled) {
            return new Report(
                State::Good,
                __('The generator tag is gone and ?ver= on this site\'s assets carries a hash instead of a version.', 'wp-hardening'),
                [__('readme.html also shows the version; block it with the root block from `wp harden htaccess`.', 'wp-hardening')],
            );
        }
        return new Report(
            State::Recommended,
            __('Pages announce the WordPress version in a generator tag and in ?ver= on core assets.', 'wp-hardening'),
            [__('Hiding it does not fix an old version, but it stops automated scans from matching this site to known flaws by version alone.', 'wp-hardening')],
        );
    }

    public function plan(): array
    {
        return [
            'Removes the generator meta tag from pages and feeds.',
            'Replaces ?ver=<version> on same-site scripts and styles with a keyed hash; caches still refresh after an update.',
            'readme.html is a file, not PHP output: block it at the server (`wp harden htaccess`).',
        ];
    }
}
