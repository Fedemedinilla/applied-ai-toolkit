<?php

declare(strict_types=1);

namespace WpHardening\Audit;

use WpHardening\Controls\ServerRules;
use WpHardening\Env\Constants;
use WpHardening\Env\Paths;

/**
 * Read-only indicators from the internal checklist (INT-xx) that can be computed from inside
 * WordPress without network access and without changing anything. Nothing here writes a file, an
 * option or a row. Evidence names files, options and counts, never their contents or secrets.
 *
 * The fast checks (settings, constants, counts) also run as Site Health tests. The file walks
 * and table scans run only from `wp harden audit`, where a slow run does not hold a dashboard page.
 */
final class Audit
{
    /** A file walk stops after this many files and says so; a partial walk is never a pass. */
    public const MAX_FILES = 20000;

    /** Bytes read from one file when looking for PHP inside it. */
    public const MAX_READ = 1048576;

    public const MIN_RECOMMENDED_PHP = '8.2';

    /** 800 KB, the size at which WordPress core's own autoload notice starts. */
    public const AUTOLOAD_LIMIT = 819200;

    private const SALTS = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];

    private const GENERIC_LOGINS = ['admin', 'administrator', 'webmaster', 'root', 'test', 'demo', 'wordpress'];

    private const PRIVILEGED_ROLES = ['administrator', 'editor', 'author', 'shop_manager'];

    private const DROPINS = ['advanced-cache.php', 'object-cache.php', 'db.php', 'db-error.php', 'sunrise.php', 'maintenance.php', 'install.php', 'php-error.php', 'fatal-error-handler.php'];

    private const PHP_EXTENSION = '/\.(?:php\d?|phtml|pht|phps|phar)$/i';

    private const IMAGE_EXTENSION = '/\.(?:ico|png|jpe?g|gif|webp|bmp|svg)$/i';

    /** Labels for the Site Health list, shown before each test has run. */
    public const FAST_TITLES = [
        'registration' => 'INT-11 Open registration',
        'debug' => 'INT-11 Debug mode in production',
        'salts' => 'INT-16 Keys and salts',
        'admins' => 'INT-05 Administrators',
        'app_passwords' => 'INT-13 Application passwords of administrators',
        'unused_code' => 'INT-10 Inactive plugins and themes',
        'child_theme' => 'INT-18 Child theme',
        'php' => 'INT-25 PHP version and memory',
        'permalinks' => 'INT-12 Permalinks',
        'pingbacks' => 'INT-24 Pingbacks',
        'wp_config_mode' => 'INT-17 wp-config.php permissions',
        'autoload' => 'INT-04 Autoloaded options',
    ];

    private ?Paths $resolved = null;

    /**
     * @param Paths|\Closure(): Paths $paths A closure is called the first time a path is needed.
     * @param \Closure(): int|null $now
     */
    public function __construct(
        private readonly Paths|\Closure $paths,
        private readonly Constants $constants,
        private readonly string $phpVersion = PHP_VERSION,
        private readonly string $memoryLimit = '',
        private readonly ?\Closure $now = null,
    ) {
    }

    /** @return array<string, callable(): Finding> */
    public function fastChecks(): array
    {
        return [
            'registration' => $this->registration(...),
            'debug' => $this->debug(...),
            'salts' => $this->salts(...),
            'admins' => $this->administrators(...),
            'app_passwords' => $this->applicationPasswords(...),
            'unused_code' => $this->unusedCode(...),
            'child_theme' => $this->childTheme(...),
            'php' => $this->php(...),
            'permalinks' => $this->permalinks(...),
            'pingbacks' => $this->pingbacks(...),
            'wp_config_mode' => $this->wpConfigMode(...),
            'autoload' => $this->autoloadSize(...),
        ];
    }

    /** @return array<string, callable(): Finding> */
    public function slowChecks(): array
    {
        return [
            'core_checksums' => $this->coreChecksums(...),
            'uploads_php' => $this->uploadsPhp(...),
            'mu_plugins' => $this->muPlugins(...),
            'recent_php' => $this->recentPhp(...),
            'htaccess' => $this->htaccessRules(...),
            'options_code' => $this->optionsWithCode(...),
            'cron' => $this->orphanCron(...),
            'injected' => $this->injectedContent(...),
        ];
    }

    /** @return list<Finding> */
    public function run(bool $fastOnly = false): array
    {
        $checks = $fastOnly ? $this->fastChecks() : [...$this->fastChecks(), ...$this->slowChecks()];
        $out = [];
        foreach ($checks as $check) {
            $out[] = $check();
        }
        return $out;
    }

    public function registration(): Finding
    {
        $title = 'Open registration';
        if (!self::truthy(get_option('users_can_register'))) {
            return new Finding('INT-11', $title, Verdict::Pass, 'Registration is closed.');
        }
        $role = (string) get_option('default_role');
        if (\in_array($role, self::PRIVILEGED_ROLES, true)) {
            return new Finding('INT-11', $title, Verdict::Fail, "Anyone can register, and new accounts get the {$role} role.", ["default_role={$role}"]);
        }
        return new Finding('INT-11', $title, Verdict::Warn, "Anyone can register, as {$role}. Confirm the site needs it.", ["default_role={$role}"]);
    }

    public function debug(): Finding
    {
        $title = 'Debug mode in production';
        if ($this->constants->value('WP_DEBUG') !== true) {
            return new Finding('INT-11', $title, Verdict::Pass, 'WP_DEBUG is off.');
        }
        $display = $this->constants->defined('WP_DEBUG_DISPLAY') ? $this->constants->value('WP_DEBUG_DISPLAY') : true;
        if ($display !== false) {
            return new Finding('INT-11', $title, Verdict::Fail, 'WP_DEBUG is on and errors are printed into pages, with file paths in them.', ['WP_DEBUG=true', 'WP_DEBUG_DISPLAY not false']);
        }
        $log = $this->constants->value('WP_DEBUG_LOG');
        $file = \is_string($log) && $log !== '' && !\in_array(strtolower($log), ['1', 'true'], true) ? $log : $this->paths()->content . '/debug.log';
        if ($log !== false && $log !== null && is_file($file) && str_starts_with($file, $this->paths()->root)) {
            return new Finding('INT-11', $title, Verdict::Warn, 'WP_DEBUG is on and the log is inside the web root. Check from outside that it is not served.', [self::relative($file, $this->paths()->root)]);
        }
        return new Finding('INT-11', $title, Verdict::Warn, 'WP_DEBUG is on, with display off. Turn it off once the problem it was on for is fixed.', ['WP_DEBUG=true']);
    }

    public function salts(): Finding
    {
        $bad = [];
        $seen = [];
        foreach (self::SALTS as $name) {
            $value = $this->constants->value($name);
            if (!\is_string($value) || \strlen($value) < 32 || stripos($value, 'put your unique phrase here') !== false) {
                $bad[] = $name;
                continue;
            }
            $hash = hash('sha256', $value);
            if (isset($seen[$hash])) {
                $bad[] = $name . ' (same as ' . $seen[$hash] . ')';
            }
            $seen[$hash] = $name;
        }
        if ($bad === []) {
            return new Finding('INT-16', 'Keys and salts', Verdict::Pass, 'All eight keys and salts are set, distinct and at least 32 characters.');
        }
        return new Finding(
            'INT-16',
            'Keys and salts',
            Verdict::Warn,
            'Some keys or salts are missing, short, repeated or still the placeholder. Replacing them logs every user out: do it with notice.',
            $bad,
        );
    }

    public function administrators(): Finding
    {
        $users = get_users(['role' => 'administrator', 'fields' => ['ID', 'user_login']]);
        $users = \is_array($users) ? $users : [];
        $generic = [];
        foreach ($users as $user) {
            $login = \is_object($user) && isset($user->user_login) && \is_string($user->user_login) ? $user->user_login : '';
            if (\in_array(strtolower($login), self::GENERIC_LOGINS, true)) {
                $generic[] = $login;
            }
        }
        $count = \count($users);
        if ($generic !== []) {
            return new Finding('INT-05', 'Administrators', Verdict::Warn, "{$count} administrators, some with a shared or default login. Give each person their own account; reassign content before removing one.", $generic);
        }
        return new Finding('INT-05', 'Administrators', Verdict::Info, "{$count} administrators. Each should be one person who still needs the role.", ["count={$count}"]);
    }

    public function applicationPasswords(): Finding
    {
        $title = 'Application passwords of administrators';
        if (!class_exists('WP_Application_Passwords')) {
            return new Finding('INT-13', $title, Verdict::Skip, 'This WordPress has no application passwords API.');
        }
        $users = get_users(['role' => 'administrator', 'fields' => 'ID']);
        $total = 0;
        $unused = 0;
        foreach (\is_array($users) ? $users : [] as $id) {
            $list = \WP_Application_Passwords::get_user_application_passwords((int) $id);
            foreach (\is_array($list) ? $list : [] as $item) {
                $total++;
                if (!\is_array($item) || empty($item['last_used'])) {
                    $unused++;
                }
            }
        }
        if ($total === 0) {
            return new Finding('INT-13', $title, Verdict::Pass, 'No administrator has an application password.');
        }
        if ($unused > 0) {
            return new Finding('INT-13', $title, Verdict::Warn, "{$total} application passwords on administrator accounts, {$unused} never used. Revoke the ones nobody can explain.", ["total={$total}", "never_used={$unused}"]);
        }
        return new Finding('INT-13', $title, Verdict::Info, "{$total} application passwords on administrator accounts, all used. Each should have a known owner.", ["total={$total}"]);
    }

    public function unusedCode(): Finding
    {
        if (!\function_exists('get_plugins') && \defined('ABSPATH') && is_file(ABSPATH . 'wp-admin/includes/plugin.php')) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }
        if (!\function_exists('get_plugins')) {
            return new Finding('INT-10', 'Inactive plugins and themes', Verdict::Skip, 'The plugin list is not available here.');
        }
        $plugins = get_plugins();
        $active = get_option('active_plugins', []);
        $active = \is_array($active) ? $active : [];
        if (is_multisite()) {
            $network = get_site_option('active_sitewide_plugins', []);
            $active = [...$active, ...array_keys(\is_array($network) ? $network : [])];
        }
        $inactive = array_values(array_diff(array_keys(\is_array($plugins) ? $plugins : []), $active));
        $themes = wp_get_themes();
        $themeCount = \is_array($themes) ? \count($themes) : 0;
        $evidence = [...array_slice($inactive, 0, 20), "themes={$themeCount}"];
        if ($inactive === [] && $themeCount <= 3) {
            return new Finding('INT-10', 'Inactive plugins and themes', Verdict::Pass, "No inactive plugins; {$themeCount} themes.", $evidence);
        }
        return new Finding(
            'INT-10',
            'Inactive plugins and themes',
            Verdict::Warn,
            \count($inactive) . " inactive plugins and {$themeCount} themes. Inactive code is still reachable and still needs updates. Deactivated plugins that hold data (forms, orders) need a copy before they are deleted.",
            $evidence,
        );
    }

    public function childTheme(): Finding
    {
        if (is_child_theme()) {
            return new Finding('INT-18', 'Child theme', Verdict::Pass, 'The active theme is a child theme; edits survive a parent update.');
        }
        return new Finding('INT-18', 'Child theme', Verdict::Info, 'The active theme is not a child theme. Theme edits belong in a child theme or a plugin, never in the parent.');
    }

    public function php(): Finding
    {
        $evidence = ["php={$this->phpVersion}"];
        $limit = $this->memoryLimit !== '' ? $this->memoryLimit : (string) ini_get('memory_limit');
        $bytes = self::bytes($limit);
        $evidence[] = "memory_limit={$limit}";
        $problems = [];
        if (version_compare($this->phpVersion, self::MIN_RECOMMENDED_PHP, '<')) {
            $problems[] = 'PHP is older than ' . self::MIN_RECOMMENDED_PHP . '; check php.net/supported-versions and test plugins on a copy before upgrading';
        }
        if ($bytes > 0 && $bytes < 268435456) {
            $problems[] = 'memory_limit is under 256M';
        }
        if ($problems === []) {
            return new Finding('INT-25', 'PHP version and memory', Verdict::Pass, 'PHP and memory are within the checklist values.', $evidence);
        }
        return new Finding('INT-25', 'PHP version and memory', Verdict::Warn, ucfirst(implode('; ', $problems)) . '.', $evidence);
    }

    public function permalinks(): Finding
    {
        if ((string) get_option('permalink_structure') === '') {
            return new Finding('INT-12', 'Permalinks', Verdict::Warn, 'Links use ?p=<id>. Changing that needs a redirect plan first, or every old link turns into a 404.');
        }
        return new Finding('INT-12', 'Permalinks', Verdict::Pass, 'Links use a named structure.');
    }

    public function pingbacks(): Finding
    {
        if (get_option('default_ping_status') === 'open') {
            return new Finding('INT-24', 'Pingbacks', Verdict::Warn, 'New posts accept pingbacks by default. Close them in Settings, Discussion, unless the site uses them.');
        }
        return new Finding('INT-24', 'Pingbacks', Verdict::Pass, 'New posts do not accept pingbacks.');
    }

    public function wpConfigMode(): Finding
    {
        $title = 'wp-config.php permissions';
        if (DIRECTORY_SEPARATOR === '\\') {
            return new Finding('INT-17', $title, Verdict::Skip, 'File modes do not apply on Windows.');
        }
        $file = $this->paths()->wpConfig();
        if ($file !== null) {
            clearstatcache(true, $file);
        }
        $perms = $file === null ? false : @fileperms($file);
        if ($file === null || $perms === false) {
            return new Finding('INT-17', $title, Verdict::Skip, 'wp-config.php was not found in the root or one level above it.');
        }
        $mode = \sprintf('%o', $perms & 0777);
        if (($perms & 0002) !== 0) {
            return new Finding('INT-17', $title, Verdict::Fail, "wp-config.php is writable by every account on the server (mode {$mode}).", ["mode={$mode}"]);
        }
        if (($perms & 0004) !== 0) {
            return new Finding('INT-17', $title, Verdict::Warn, "wp-config.php is readable by every account on the server (mode {$mode}); 640 or 600 is enough on most hosts.", ["mode={$mode}"]);
        }
        return new Finding('INT-17', $title, Verdict::Pass, "wp-config.php has mode {$mode}.", ["mode={$mode}"]);
    }

    public function autoloadSize(): Finding
    {
        $options = wp_load_alloptions();
        $sizes = [];
        foreach (\is_array($options) ? $options : [] as $name => $value) {
            $sizes[(string) $name] = \is_string($value) ? \strlen($value) : \strlen(serialize($value));
        }
        $total = array_sum($sizes);
        arsort($sizes);
        $kb = round($total / 1024, 1);
        $top = [];
        foreach (\array_slice($sizes, 0, 5, true) as $name => $size) {
            $top[] = $name . ' ' . round($size / 1024, 1) . ' KB';
        }
        if ($total > self::AUTOLOAD_LIMIT) {
            return new Finding('INT-04', 'Autoloaded options', Verdict::Warn, "{$kb} KB of options load on every request, over the 800 KB mark. Never delete core or active plugin options.", $top);
        }
        return new Finding('INT-04', 'Autoloaded options', Verdict::Pass, "{$kb} KB of options load on every request.", $top);
    }

    public function coreChecksums(): Finding
    {
        return new Finding(
            'INT-01',
            'Core file integrity',
            Verdict::Skip,
            'Needs the checksums from api.wordpress.org, which this audit does not contact. Run `wp core verify-checksums` and `wp plugin verify-checksums --all` where the site can reach wordpress.org.',
        );
    }

    public function uploadsPhp(): Finding
    {
        $title = 'PHP inside uploads';
        if (!is_dir($this->paths()->uploads)) {
            return new Finding('INT-02', $title, Verdict::Skip, 'The uploads folder was not found.');
        }
        $hits = [];
        $walk = self::walk($this->paths()->uploads, function (\SplFileInfo $file) use (&$hits): void {
            $name = $file->getFilename();
            if (preg_match(self::PHP_EXTENSION, $name) === 1) {
                $hits[] = self::relative($file->getPathname(), $this->paths()->uploads);
            } elseif (preg_match(self::IMAGE_EXTENSION, $name) === 1 && self::containsPhp($file->getPathname())) {
                $hits[] = self::relative($file->getPathname(), $this->paths()->uploads) . ' (image with PHP inside)';
            }
        });
        if ($hits !== []) {
            return new Finding('INT-02', $title, Verdict::Fail, \count($hits) . ' files in uploads/ are PHP or hold PHP. Keep a copy as evidence before removing anything.', \array_slice($hits, 0, 20));
        }
        if ($walk['truncated']) {
            return new Finding('INT-02', $title, Verdict::Warn, "Nothing found in the first {$walk['files']} files, but the walk stopped there; the rest was not checked.", ["files={$walk['files']}"]);
        }
        return new Finding('INT-02', $title, Verdict::Pass, "No PHP in {$walk['files']} files under uploads/.", ["files={$walk['files']}"]);
    }

    public function muPlugins(): Finding
    {
        $headerless = [];
        $dir = $this->paths()->muPlugins;
        foreach (is_dir($dir) ? (scandir($dir) ?: []) : [] as $name) {
            $path = $dir . '/' . $name;
            if (preg_match('/\.php$/i', $name) === 1 && is_file($path)) {
                $head = (string) @file_get_contents($path, false, null, 0, 8192);
                if (stripos($head, 'Plugin Name:') === false) {
                    $headerless[] = 'mu-plugins/' . $name;
                }
            }
        }
        $dropins = [];
        foreach (self::DROPINS as $name) {
            if (is_file($this->paths()->content . '/' . $name)) {
                $dropins[] = $name;
            }
        }
        if ($headerless !== []) {
            return new Finding('INT-03', 'Must-use plugins and drop-ins', Verdict::Warn, 'Must-use plugins load on every request and cannot be deactivated from the dashboard. These have no "Plugin Name:" header; read each one.', [...$headerless, ...$dropins]);
        }
        if ($dropins !== []) {
            return new Finding('INT-03', 'Must-use plugins and drop-ins', Verdict::Info, 'Drop-ins present. Each should belong to a known cache or object-cache plugin.', $dropins);
        }
        return new Finding('INT-03', 'Must-use plugins and drop-ins', Verdict::Pass, 'No headerless must-use plugins and no drop-ins.');
    }

    public function recentPhp(int $days = 30): Finding
    {
        $title = 'PHP files changed recently';
        if (!is_dir($this->paths()->content)) {
            return new Finding('INT-14', $title, Verdict::Skip, 'wp-content was not found.');
        }
        $since = $this->now() - $days * 86400;
        $recent = [];
        $walk = self::walk($this->paths()->content, function (\SplFileInfo $file) use (&$recent, $since): void {
            if (preg_match('/\.php$/i', $file->getFilename()) === 1 && $file->getMTime() >= $since) {
                $recent[] = self::relative($file->getPathname(), $this->paths()->content);
            }
        });
        sort($recent);
        $suffix = $walk['truncated'] ? " The walk stopped after {$walk['files']} files." : '';
        return new Finding(
            'INT-14',
            $title,
            $walk['truncated'] ? Verdict::Warn : Verdict::Info,
            \count($recent) . " PHP files under wp-content changed in the last {$days} days. Each should match an update or a known change.{$suffix}",
            \array_slice($recent, 0, 20),
        );
    }

    public function htaccessRules(): Finding
    {
        $files = ['.htaccess' => $this->paths()->home . '/.htaccess', 'uploads/.htaccess' => $this->paths()->uploads . '/.htaccess'];
        $hits = [];
        foreach ($files as $label => $file) {
            if (!is_file($file)) {
                continue;
            }
            $inUploads = $label === 'uploads/.htaccess';
            foreach (self::suspiciousLines((string) file_get_contents($file, false, null, 0, self::MAX_READ), $inUploads) as [$line, $kind]) {
                $hits[] = "{$label} line {$line}: {$kind}";
            }
        }
        if ($hits === []) {
            return new Finding('INT-15', '.htaccess rules', Verdict::Pass, 'No external redirects, user-agent conditions, PHP prepends or handler changes found.');
        }
        return new Finding('INT-15', '.htaccess rules', Verdict::Warn, 'Rules that injected spam and backdoors often use. Each one needs a known author; keep a copy of the file before removing a rule.', \array_slice($hits, 0, 20));
    }

    /**
     * Lines outside this plugin's own block that match a known injection pattern.
     *
     * @return list<array{0: int, 1: string}>
     */
    public static function suspiciousLines(string $text, bool $inUploads): array
    {
        $out = [];
        $inside = false;
        foreach (preg_split('/\r\n|\r|\n/', $text) ?: [] as $index => $line) {
            if (str_starts_with(trim($line), ServerRules::BEGIN)) {
                $inside = true;
            }
            if ($inside) {
                $inside = !str_starts_with(trim($line), ServerRules::END);
                continue;
            }
            $kind = match (true) {
                preg_match('#^\s*RewriteRule\s+\S+\s+https?://#i', $line) === 1 => 'rewrite to another host',
                preg_match('/HTTP_USER_AGENT/i', $line) === 1 => 'condition on the user agent',
                preg_match('/auto_(?:prepend|append)_file/i', $line) === 1 => 'PHP prepend or append file',
                preg_match('/^\s*(?:AddHandler|AddType|SetHandler)\b.*\.(?:jpe?g|png|gif|ico|txt|svg)\b/i', $line) === 1 => 'PHP handler for an image or text extension',
                $inUploads && preg_match('/^\s*(?:AddHandler|AddType|SetHandler)\b.*php/i', $line) === 1 => 'PHP handler inside uploads',
                default => null,
            };
            if ($kind !== null) {
                $out[] = [$index + 1, $kind];
            }
        }
        return $out;
    }

    public function optionsWithCode(): Finding
    {
        global $wpdb;
        if (!\is_object($wpdb) || !method_exists($wpdb, 'get_col')) {
            return new Finding('INT-04', 'Options holding code', Verdict::Skip, 'No database connection.');
        }
        $sql = $wpdb->prepare(
            "SELECT option_name FROM {$wpdb->options} WHERE option_value LIKE %s OR option_value LIKE %s OR option_value LIKE %s LIMIT 20",
            '%<?php%',
            '%base64_decode(%',
            '%eval(%',
        );
        $names = $wpdb->get_col($sql);
        $names = \is_array($names) ? array_values(array_filter($names, 'is_string')) : [];
        if ($names === []) {
            return new Finding('INT-04', 'Options holding code', Verdict::Pass, 'No option holds PHP tags, base64_decode( or eval(.');
        }
        return new Finding('INT-04', 'Options holding code', Verdict::Warn, 'Options that hold PHP tags, base64_decode( or eval(. Some plugins store code legitimately; each needs a known owner.', $names);
    }

    public function orphanCron(): Finding
    {
        $cron = \function_exists('_get_cron_array') ? _get_cron_array() : [];
        $orphans = [];
        foreach (\is_array($cron) ? $cron : [] as $hooks) {
            foreach (\is_array($hooks) ? array_keys($hooks) : [] as $hook) {
                if (\is_string($hook) && !has_action($hook)) {
                    $orphans[$hook] = true;
                }
            }
        }
        $list = array_keys($orphans);
        sort($list);
        if ($list === []) {
            return new Finding('INT-20', 'Scheduled tasks', Verdict::Pass, 'Every scheduled task has code that handles it.');
        }
        return new Finding('INT-20', 'Scheduled tasks', Verdict::Warn, \count($list) . ' scheduled tasks have no code attached: left by a removed plugin, or added by something that is not a plugin. Find who registers each before removing it.', \array_slice($list, 0, 20));
    }

    public function injectedContent(): Finding
    {
        global $wpdb;
        if (!\is_object($wpdb) || !method_exists($wpdb, 'get_results')) {
            return new Finding('INT-21', 'Scripts in content', Verdict::Skip, 'No database connection.');
        }
        $sql = $wpdb->prepare(
            "SELECT ID, post_type FROM {$wpdb->posts} WHERE post_status <> 'trash' AND post_type <> 'revision' AND (post_content LIKE %s OR post_content LIKE %s OR post_content LIKE %s) LIMIT 20",
            '%<script%',
            '%<iframe%',
            '%javascript:%',
        );
        $rows = $wpdb->get_results($sql, 'ARRAY_A');
        $items = [];
        foreach (\is_array($rows) ? $rows : [] as $row) {
            if (\is_array($row)) {
                $items[] = 'post ' . (int) ($row['ID'] ?? 0) . ' (' . (string) ($row['post_type'] ?? '') . ')';
            }
        }
        if ($items === []) {
            return new Finding('INT-21', 'Scripts in content', Verdict::Pass, 'No post holds <script, <iframe or javascript:.');
        }
        return new Finding('INT-21', 'Scripts in content', Verdict::Warn, 'Posts with scripts, iframes or javascript: links. Embeds (video, maps) are normal; anything else is checked against INT-02 and INT-19.', $items);
    }

    /**
     * Walks a tree without following directory links and stops after MAX_FILES files. A
     * directory that cannot be opened throws UnexpectedValueException, which ends the walk as
     * truncated: skipping it quietly would let a partial walk report a pass.
     *
     * @param callable(\SplFileInfo): void $visit
     * @return array{files: int, truncated: bool}
     */
    private static function walk(string $dir, callable $visit): array
    {
        $files = 0;
        try {
            $iterator = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
                \RecursiveIteratorIterator::LEAVES_ONLY,
            );
            foreach ($iterator as $file) {
                if (!$file instanceof \SplFileInfo || !$file->isFile()) {
                    continue;
                }
                if ($files >= self::MAX_FILES) {
                    return ['files' => $files, 'truncated' => true];
                }
                $files++;
                $visit($file);
            }
        } catch (\UnexpectedValueException) {
            return ['files' => $files, 'truncated' => true];
        }
        return ['files' => $files, 'truncated' => false];
    }

    private static function containsPhp(string $path): bool
    {
        $head = @file_get_contents($path, false, null, 0, self::MAX_READ);
        return \is_string($head) && stripos($head, '<?php') !== false;
    }

    private static function relative(string $path, string $base): string
    {
        return str_starts_with($path, $base . '/') ? substr($path, \strlen($base) + 1) : basename($path);
    }

    private static function truthy(mixed $value): bool
    {
        return $value === true || $value === 1 || $value === '1';
    }

    /** "256M" to bytes; -1 for no limit; 0 for something unreadable. */
    public static function bytes(string $value): int
    {
        $value = trim($value);
        if ($value === '-1') {
            return -1;
        }
        if (preg_match('/^(\d+)\s*([kmg]?)$/i', $value, $m) !== 1) {
            return 0;
        }
        $n = (int) $m[1];
        return match (strtolower($m[2])) {
            'g' => $n * 1073741824,
            'm' => $n * 1048576,
            'k' => $n * 1024,
            default => $n,
        };
    }

    private function paths(): Paths
    {
        return $this->resolved ??= $this->paths instanceof Paths ? $this->paths : ($this->paths)();
    }

    private function now(): int
    {
        return $this->now !== null ? ($this->now)() : time();
    }
}
