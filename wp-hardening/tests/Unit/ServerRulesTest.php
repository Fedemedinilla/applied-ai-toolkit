<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use WpHardening\Controls\ServerRules;
use WpHardening\Env\Paths;
use WpHardening\Integrations;
use WpHardening\Settings;
use WpHardening\State;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\TestCase;

final class ServerRulesTest extends TestCase
{
    private string $root;

    protected function setUp(): void
    {
        parent::setUp();
        $this->root = $this->tempDir();
        mkdir($this->root . '/wp-content/uploads', 0755, true);
    }

    /**
     * @param array<string, mixed> $constants
     * @param array<string, string> $server
     */
    private function rules(array $constants = [], array $server = ['SERVER_SOFTWARE' => 'Apache/2.4.62']): ServerRules
    {
        $paths = new Paths($this->root, $this->root . '/wp-content', $this->root . '/wp-content/uploads', $this->root . '/wp-content/mu-plugins');
        return new ServerRules($paths, new Integrations(new FakeConstants($constants), Settings::fromArray([])), $server);
    }

    public function testRootBlock(): void
    {
        $block = $this->rules()->rootBlock();
        self::assertStringStartsWith(ServerRules::BEGIN . "\n", $block);
        self::assertStringEndsWith(ServerRules::END . "\n", $block);
        self::assertStringContainsString('Options -Indexes', $block);
        self::assertStringContainsString('<Files readme.html>', $block);
        self::assertStringContainsString('<Files xmlrpc.php>', $block);
        self::assertStringContainsString('Require all denied', $block);
        self::assertStringContainsString('Deny from all', $block);
        self::assertSame(substr_count($block, '<IfModule'), substr_count($block, '</IfModule>'));
        self::assertSame(substr_count($block, '<Files '), substr_count($block, '</Files>'));
    }

    public function testGuardXmlrpcIsNotBlockedWhenJetpackUsesIt(): void
    {
        $rules = $this->rules(['JETPACK__VERSION' => '14.0']);
        self::assertStringNotContainsString('xmlrpc.php', $rules->rootBlock());
        self::assertStringNotContainsString('xmlrpc.php', $rules->nginxBlock());
    }

    public function testUploadsPatternMatchesPhpVariantsAndNotImages(): void
    {
        $block = $this->rules()->uploadsBlock();
        self::assertSame(1, preg_match('/<FilesMatch "(.+)">/', $block, $m));
        $pattern = '/' . $m[1] . '/';
        foreach (['shell.php', 'shell.PHP', 'a.php5', 'a.php7', 'x.phtml', 'x.phar', 'x.pht', 'x.phps'] as $name) {
            self::assertSame(1, preg_match($pattern, $name), $name);
        }
        foreach (['photo.jpg', 'doc.pdf', 'php.png', 'notes.phpx', 'a.php.jpg'] as $name) {
            self::assertSame(0, preg_match($pattern, $name), $name);
        }
        self::assertStringContainsString('X-Content-Type-Options "nosniff"', $block);
    }

    public function testNginxBlock(): void
    {
        $block = $this->rules()->nginxBlock();
        self::assertStringContainsString('autoindex off;', $block);
        self::assertStringContainsString('location = /readme.html { deny all; }', $block);
        self::assertStringContainsString('location = /xmlrpc.php { deny all; }', $block);
        self::assertSame(substr_count($block, '{'), substr_count($block, '}'));
    }

    /**
     * nginx uses the first regex location that matches, so a plain regex deny placed after the
     * usual `location ~ \.php$` would never run. A ^~ prefix location wins wherever it sits.
     */
    public function testGuardTheNginxUploadsRuleIsAPrefixLocationThatBeatsRegexes(): void
    {
        $block = $this->rules()->nginxBlock();
        self::assertStringContainsString("location ^~ /wp-content/uploads/ {\n    location ~* \\.(?:php\\d?|phtml|pht|phps|phar)$ { deny all; }\n}", $block);
        self::assertStringNotContainsString('location ~* ^/wp-content/uploads', $block);
        self::assertStringContainsString('wins over regex locations', $block);
    }

    public function testTheNginxUploadsPathComesFromTheSite(): void
    {
        $paths = new Paths($this->root, $this->root . '/app', $this->root . '/app/media', $this->root . '/app/mu', null, '/app/media/');
        $rules = new ServerRules($paths, new Integrations(new FakeConstants(), Settings::fromArray([])), []);
        self::assertStringContainsString('location ^~ /app/media/ {', $rules->nginxBlock());
        $odd = new Paths($this->root, $this->root, $this->root, $this->root, null, '/up loads;}');
        self::assertSame('/wp-content/uploads', $odd->uploadsUri, 'a path nginx would need quoted falls back to the default');
    }

    public function testGuardAnInstalledXmlrpcDenyIsCriticalWhenJetpackUsesIt(): void
    {
        // The root block was pasted before Jetpack was installed, so it still denies xmlrpc.php.
        file_put_contents($this->root . '/.htaccess', $this->rules()->rootBlock());
        $jetpack = $this->rules(['JETPACK__VERSION' => '14.0']);
        self::assertTrue($jetpack->deniesXmlrpc());
        foreach ([true, false] as $enabled) {
            $report = $jetpack->report($enabled);
            self::assertSame(State::Critical, $report->state);
            self::assertStringContainsString('Jetpack', $report->summary);
        }
        file_put_contents($this->root . '/.htaccess', $jetpack->rootBlock());
        self::assertFalse($jetpack->deniesXmlrpc());
        self::assertNotSame(State::Critical, $jetpack->report(true)->state);
    }

    public function testServerHeadersAreFoundInTheRootHtaccess(): void
    {
        self::assertSame([], $this->rules()->serverHeaders());
        file_put_contents($this->root . '/.htaccess', "<IfModule mod_headers.c>\n  Header always set Strict-Transport-Security \"max-age=31536000\"\n  Header set X-Frame-Options \"SAMEORIGIN\"\n  # Header set Referrer-Policy no-referrer\n</IfModule>\n");
        self::assertSame(['Strict-Transport-Security', 'X-Frame-Options'], $this->rules()->serverHeaders());
    }

    public function testTheRootHtaccessIsReadFromTheHomeDirectory(): void
    {
        // WordPress in its own directory: core in /wp, the site and its .htaccess one level up.
        mkdir($this->root . '/wp');
        $paths = new Paths($this->root . '/wp', $this->root . '/wp-content', $this->root . '/wp-content/uploads', $this->root . '/wp-content/mu-plugins', $this->root);
        $rules = new ServerRules($paths, new Integrations(new FakeConstants(), Settings::fromArray([])), []);
        file_put_contents($this->root . '/.htaccess', $rules->rootBlock());
        self::assertTrue($rules->installed()['root']);
    }

    public function testHomeRoot(): void
    {
        self::assertSame('/srv/site', Paths::homeRoot('/srv/site/wp/', 'https://site.example', 'https://site.example/wp'));
        self::assertSame('/srv/site', Paths::homeRoot('/srv/site/', 'https://site.example', 'https://site.example'));
        self::assertSame('/srv/site/blog', Paths::homeRoot('/srv/site/blog/core', 'https://site.example/blog/', 'https://site.example/blog/core'));
        self::assertSame('/srv/other', Paths::homeRoot('/srv/other', 'https://site.example', 'https://site.example/wp'));
        self::assertSame('/srv/site', Paths::homeRoot('/srv/site', 'https://site.example/a', 'https://site.example/b'));
    }

    public function testAClosureForThePathsIsCalledOnlyWhenAPathIsNeeded(): void
    {
        $calls = 0;
        $rules = new ServerRules(function () use (&$calls): Paths {
            $calls++;
            return new Paths($this->root, $this->root . '/wp-content', $this->root . '/wp-content/uploads', $this->root . '/wp-content/mu-plugins');
        }, new Integrations(new FakeConstants(), Settings::fromArray([])), []);
        $rules->rootBlock();
        $rules->uploadsBlock();
        self::assertSame(0, $calls);
        $rules->installed();
        $rules->nginxBlock();
        self::assertSame(1, $calls);
    }

    public function testServerDetection(): void
    {
        self::assertSame('apache', $this->rules()->server());
        self::assertSame('apache', $this->rules([], ['SERVER_SOFTWARE' => 'LiteSpeed'])->server());
        self::assertSame('nginx', $this->rules([], ['SERVER_SOFTWARE' => 'nginx/1.27.0'])->server());
        self::assertSame('unknown', $this->rules([], [])->server());
    }

    public function testInstalledReadsBothFiles(): void
    {
        $rules = $this->rules();
        self::assertSame(['root' => false, 'uploads' => false], $rules->installed());
        file_put_contents($this->root . '/.htaccess', "# BEGIN WordPress\n# END WordPress\n" . $rules->rootBlock());
        self::assertSame(['root' => true, 'uploads' => false], $rules->installed());
        file_put_contents($this->root . '/wp-content/uploads/.htaccess', ServerRules::BEGIN . "\nhalf a block\n");
        self::assertFalse($rules->installed()['uploads']);
        file_put_contents($this->root . '/wp-content/uploads/.htaccess', $rules->uploadsBlock());
        self::assertSame(['root' => true, 'uploads' => true], $rules->installed());
    }

    public function testGuardReportingNeverWrites(): void
    {
        $rules = $this->rules();
        $before = self::listing($this->root);
        $rules->register();
        $rules->report(true);
        $rules->report(false);
        $rules->installed();
        $rules->plan();
        self::assertSame($before, self::listing($this->root));
        self::assertFalse(file_exists($this->root . '/.htaccess'));
    }

    public function testReportStates(): void
    {
        $rules = $this->rules();
        self::assertSame(State::Recommended, $rules->report(false)->state);
        $missing = $rules->report(true);
        self::assertSame(State::Recommended, $missing->state);
        self::assertStringContainsString('uploads/', $missing->summary);
        file_put_contents($this->root . '/.htaccess', $rules->rootBlock());
        file_put_contents($this->root . '/wp-content/uploads/.htaccess', $rules->uploadsBlock());
        self::assertSame(State::Good, $rules->report(true)->state);
        $nginx = $this->rules([], ['SERVER_SOFTWARE' => 'nginx']);
        self::assertStringContainsString('nginx', $nginx->report(true)->summary);
    }

    /** @return list<string> */
    private static function listing(string $dir): array
    {
        $out = [];
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::SELF_FIRST);
        foreach ($it as $file) {
            \assert($file instanceof \SplFileInfo);
            $out[] = $file->getPathname() . ':' . $file->getSize() . ':' . $file->getMTime();
        }
        sort($out);
        return $out;
    }
}
