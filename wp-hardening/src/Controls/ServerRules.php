<?php

declare(strict_types=1);

namespace WpHardening\Controls;

use WpHardening\Control;
use WpHardening\Env\Paths;
use WpHardening\Integrations;
use WpHardening\Report;
use WpHardening\State;

/**
 * SEG-17, SEG-18 and the file half of SEG-07 and SEG-19: the rules that only the web server can
 * apply. PHP never runs for a request to readme.html, a directory index or a file in uploads/, so
 * these cannot be hooks.
 *
 * Guard: the plugin generates the blocks and checks whether they are in place, and never writes
 * them. A syntax error in .htaccess, or `Options` on a host whose AllowOverride does not allow it,
 * turns every page into a 500. The owner adds the block with a copy of the file and loads the site
 * right after. Turning the toggle on only makes Site Health check that the blocks are present.
 */
final class ServerRules implements Control
{
    public const BEGIN = '# BEGIN WP Hardening';
    public const END = '# END WP Hardening';

    /** Apache 2.4 (mod_authz_core) and 2.2 syntax side by side, so the block loads on either. */
    private const DENY = <<<'TXT'
          <IfModule mod_authz_core.c>
            Require all denied
          </IfModule>
          <IfModule !mod_authz_core.c>
            Order allow,deny
            Deny from all
          </IfModule>
        TXT;

    /** The headers SecurityHeaders sends, looked for in the root .htaccess. */
    private const SERVER_HEADERS = ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Content-Security-Policy-Report-Only', 'Content-Security-Policy'];

    private ?Paths $resolved = null;

    /**
     * @param Paths|\Closure(): Paths $paths A closure is called the first time a path is needed.
     * @param array<array-key, mixed>|null $server Defaults to $_SERVER.
     */
    public function __construct(
        private readonly Paths|\Closure $paths,
        private readonly Integrations $integrations,
        private readonly ?array $server = null,
    ) {
    }

    private function paths(): Paths
    {
        return $this->resolved ??= $this->paths instanceof Paths ? $this->paths : ($this->paths)();
    }

    public function id(): string
    {
        return 'server_rules';
    }

    public function title(): string
    {
        return __('Server rules for uploads, directory listing and readme.html', 'wp-hardening');
    }

    public function register(): void
    {
        // Nothing to hook: see the class comment.
    }

    /** "apache" covers LiteSpeed, which reads .htaccess the same way. */
    public function server(): string
    {
        $software = ($this->server ?? $_SERVER)['SERVER_SOFTWARE'] ?? '';
        $software = \is_string($software) ? strtolower($software) : '';
        if (str_contains($software, 'nginx')) {
            return 'nginx';
        }
        if (str_contains($software, 'apache') || str_contains($software, 'litespeed')) {
            return 'apache';
        }
        return 'unknown';
    }

    public function rootBlock(): string
    {
        $lines = [self::BEGIN, 'Options -Indexes', '<Files readme.html>', self::DENY, '</Files>'];
        if ($this->integrations->xmlrpcUsers() === []) {
            $lines = [...$lines, '<Files xmlrpc.php>', self::DENY, '</Files>'];
        }
        $lines[] = self::END;
        return implode("\n", $lines) . "\n";
    }

    /** php, php3 to php8, phtml, pht, phps and phar, in any case: `shell.PHP` is matched too. */
    public function uploadsBlock(): string
    {
        return implode("\n", [
            self::BEGIN,
            '<FilesMatch "\.(?i:php\d?|phtml|pht|phps|phar)$">',
            self::DENY,
            '</FilesMatch>',
            '<IfModule mod_headers.c>',
            '  Header always set X-Content-Type-Options "nosniff"',
            '</IfModule>',
            self::END,
        ]) . "\n";
    }

    /**
     * The same rules for an nginx server block, where .htaccess is not read.
     *
     * nginx picks the first regex location that matches, in file order, so a plain
     * `location ~* ^/uploads/.*\.php$` placed after the site's usual `location ~ \.php$` never
     * runs and PHP in uploads still executes. The `^~` prefix location wins over every regex
     * location wherever it sits, so the uploads rule fails closed instead of open.
     */
    public function nginxBlock(): string
    {
        $uploads = $this->paths()->uploadsUri;
        $lines = [
            '# WP Hardening: add inside server { }, then run nginx -t before reloading.',
            '# The uploads location uses ^~, so it wins over regex locations such as `location ~ \.php$`',
            '# wherever it sits. Regex locations elsewhere (cache headers for images, for example) no longer',
            '# apply under ' . $uploads . '/: copy those directives inside it if the site relies on them.',
            'autoindex off;',
            'location = /readme.html { deny all; }',
        ];
        if ($this->integrations->xmlrpcUsers() === []) {
            $lines[] = 'location = /xmlrpc.php { deny all; }';
        }
        $lines[] = 'location ^~ ' . $uploads . '/ {';
        $lines[] = '    location ~* \.(?:php\d?|phtml|pht|phps|phar)$ { deny all; }';
        $lines[] = '}';
        return implode("\n", $lines) . "\n";
    }

    /**
     * Which generated blocks are already in place. Reads the two files, never writes them.
     *
     * @return array{root: bool, uploads: bool}
     */
    public function installed(): array
    {
        return [
            'root' => self::hasBlock($this->paths()->home . '/.htaccess'),
            'uploads' => self::hasBlock($this->paths()->uploads . '/.htaccess'),
        ];
    }

    /** The root .htaccess, up to 1 MB, or '' when it is missing or unreadable. */
    private function rootHtaccess(): string
    {
        $file = $this->paths()->home . '/.htaccess';
        if (!is_file($file) || !is_readable($file)) {
            return '';
        }
        return (string) file_get_contents($file, false, null, 0, 1 << 20);
    }

    /**
     * Whether the root .htaccess refuses xmlrpc.php, in this plugin's block or anywhere else. A
     * block pasted before Jetpack was installed still carries the rule, and the server keeps
     * refusing XML-RPC whatever the PHP side decides.
     */
    public function deniesXmlrpc(): bool
    {
        return preg_match('/<Files\s+"?xmlrpc\.php"?\s*>/i', $this->rootHtaccess()) === 1;
    }

    /**
     * Security header names that the root .htaccess sets with `Header set|always set|add|append`.
     * PHP cannot see headers the server adds, so SecurityHeaders would send a second copy.
     *
     * @return list<string>
     */
    public function serverHeaders(): array
    {
        $text = $this->rootHtaccess();
        $found = [];
        foreach (self::SERVER_HEADERS as $name) {
            $pattern = '/^\s*Header\s+(?:always\s+)?(?:set|add|append)\s+"?' . preg_quote($name, '/') . '"?\s/im';
            if (preg_match($pattern, $text) === 1) {
                $found[] = $name;
            }
        }
        return $found;
    }

    public static function hasBlock(string $file): bool
    {
        if (!is_file($file) || !is_readable($file)) {
            return false;
        }
        $text = (string) file_get_contents($file, false, null, 0, 1 << 20);
        $begin = strpos($text, self::BEGIN);
        return $begin !== false && strpos($text, self::END, $begin) !== false;
    }

    public function report(bool $enabled): Report
    {
        $server = $this->server();
        // Checked whatever the toggle says: the rule may be in place from an earlier paste.
        $users = $this->integrations->xmlrpcUsers();
        if ($users !== [] && $this->deniesXmlrpc()) {
            return new Report(
                State::Critical,
                \sprintf(__('The root .htaccess denies xmlrpc.php, but %s uses it.', 'wp-hardening'), implode(', ', $users)),
                [__('Remove the <Files xmlrpc.php> section. `wp harden htaccess` prints the block without it while the integration is detected.', 'wp-hardening')],
            );
        }
        if (!$enabled) {
            return new Report(
                State::Recommended,
                __('Server rules are not tracked. PHP files in uploads/ may run, and folders without an index may be listed.', 'wp-hardening'),
                [__('Run `wp harden htaccess` to print the blocks for this server.', 'wp-hardening')],
            );
        }
        if ($server === 'nginx') {
            return new Report(
                State::Recommended,
                __('This server is nginx, which does not read .htaccess, and the plugin cannot see its configuration.', 'wp-hardening'),
                [__('Add the nginx rules from `wp harden htaccess --server=nginx` to the server block and check them from outside.', 'wp-hardening')],
            );
        }
        $installed = $this->installed();
        $missing = [];
        if (!$installed['root']) {
            $missing[] = __('the site root .htaccess', 'wp-hardening');
        }
        if (!$installed['uploads']) {
            $missing[] = __('the uploads/ .htaccess', 'wp-hardening');
        }
        if ($missing === []) {
            return new Report(State::Good, __('Both generated blocks are in place: the site root and uploads/.', 'wp-hardening'), [
                __('This checks the files, not the server: request a .php file placed in uploads/ on a staging copy and expect a 403.', 'wp-hardening'),
            ]);
        }
        return new Report(
            State::Recommended,
            \sprintf(__('The generated block is missing from: %s.', 'wp-hardening'), implode(', ', $missing)),
            [__('Print it with `wp harden htaccess`, copy the file, paste the block, and load the site at once. A 500 means the host does not allow the rule: put the copy back.', 'wp-hardening')],
        );
    }

    public function plan(): array
    {
        return [
            'Writes nothing. Site Health starts checking that the generated blocks are in the root and uploads/ .htaccess.',
            'Print the blocks with `wp harden htaccess` (or --server=nginx).',
            'On nginx the uploads rule is a ^~ location, so the usual `location ~ \.php$` block cannot run PHP from uploads/ ahead of it.',
        ];
    }
}
