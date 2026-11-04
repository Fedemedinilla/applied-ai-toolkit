<?php

declare(strict_types=1);

namespace WpHardening\Env;

/**
 * The directories the audit and the server rules read. Built from WordPress in production, and
 * only when Site Health or WP-CLI asks: wp_upload_dir() caches its result for the request, so
 * calling it while plugins load would freeze the upload paths before other plugins hook upload_dir.
 */
final class Paths
{
    /** Where the site's root .htaccess lives. Differs from $root when WordPress sits in its own directory. */
    public readonly string $home;

    /** URL path of the uploads directory, for the nginx rule ("/wp-content/uploads"). */
    public readonly string $uploadsUri;

    public function __construct(
        public readonly string $root,
        public readonly string $content,
        public readonly string $uploads,
        public readonly string $muPlugins,
        ?string $home = null,
        string $uploadsUri = '/wp-content/uploads',
    ) {
        $this->home = $home ?? $root;
        $this->uploadsUri = self::safeUri($uploadsUri);
    }

    public static function fromWordPress(): self
    {
        $uploads = wp_upload_dir(null, false);
        $basedir = \is_array($uploads) && \is_string($uploads['basedir'] ?? null)
            ? $uploads['basedir']
            : WP_CONTENT_DIR . '/uploads';
        $baseurl = \is_array($uploads) && \is_string($uploads['baseurl'] ?? null) ? $uploads['baseurl'] : '';
        $uri = parse_url($baseurl, PHP_URL_PATH);
        $root = rtrim(ABSPATH, '/');
        return new self(
            $root,
            rtrim(WP_CONTENT_DIR, '/'),
            rtrim($basedir, '/'),
            rtrim(\defined('WPMU_PLUGIN_DIR') ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR . '/mu-plugins', '/'),
            self::homeRoot($root, (string) get_option('home'), (string) get_option('siteurl')),
            \is_string($uri) ? $uri : '/wp-content/uploads',
        );
    }

    /**
     * The directory that serves the home URL. With core in /wp/ and the site at /, siteurl ends
     * in /wp and ABSPATH is the core folder, so the root .htaccess is one level up. This is what
     * get_home_path() computes, without its reliance on SCRIPT_FILENAME, which is WP-CLI's own
     * script when run from the command line.
     */
    public static function homeRoot(string $abspath, string $homeUrl, string $siteUrl): string
    {
        $abspath = rtrim($abspath, '/');
        $home = rtrim((string) parse_url($homeUrl, PHP_URL_PATH), '/');
        $site = rtrim((string) parse_url($siteUrl, PHP_URL_PATH), '/');
        if ($site === $home || !str_starts_with($site, $home . '/')) {
            return $abspath;
        }
        $extra = substr($site, \strlen($home));
        return str_ends_with($abspath, $extra) ? substr($abspath, 0, -\strlen($extra)) : $abspath;
    }

    /** Only characters that need no quoting in an nginx location; anything else falls back to the default. */
    private static function safeUri(string $uri): string
    {
        $uri = '/' . trim($uri, '/');
        return preg_match('#^(?:/[A-Za-z0-9._~-]+)+$#', $uri) === 1 ? $uri : '/wp-content/uploads';
    }

    /** wp-config.php sits in the root or one level above it; WordPress looks in both places. */
    public function wpConfig(): ?string
    {
        foreach ([$this->root . '/wp-config.php', \dirname($this->root) . '/wp-config.php'] as $file) {
            if (is_file($file)) {
                return $file;
            }
        }
        return null;
    }
}
