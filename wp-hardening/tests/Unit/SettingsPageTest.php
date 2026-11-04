<?php

declare(strict_types=1);

namespace WpHardening\Tests\Unit;

use Brain\Monkey\Functions;
use WpHardening\Admin\SettingsPage;
use WpHardening\Env\Paths;
use WpHardening\Plugin;
use WpHardening\Settings;
use WpHardening\Tests\FakeConstants;
use WpHardening\Tests\FakeHeaders;
use WpHardening\Tests\TestCase;

final class SettingsPageTest extends TestCase
{
    private function page(array $stored = []): SettingsPage
    {
        $root = $this->tempDir();
        $plugin = new Plugin(Settings::fromArray($stored), new FakeConstants(), new FakeHeaders(), new Paths($root, $root . '/wp-content', $root . '/wp-content/uploads', $root . '/wp-content/mu-plugins'));
        Functions\when('settings_fields')->alias(static function (): void {
            echo '<input type="hidden" name="option_page" value="wp-hardening">';
        });
        Functions\when('submit_button')->alias(static function (): void {
            echo '<input type="submit" class="button button-primary" value="Save Changes">';
        });
        Functions\when('esc_textarea')->alias(static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES));
        return new SettingsPage($plugin->controls, $plugin->settings);
    }

    public function testEveryInputHasALabel(): void
    {
        $html = $this->page()->html();
        $doc = new \DOMDocument();
        self::assertTrue(@$doc->loadHTML('<!doctype html><html><body>' . $html . '</body></html>'));
        $xpath = new \DOMXPath($doc);
        $labels = [];
        foreach ($xpath->query('//label[@for]') ?: [] as $label) {
            \assert($label instanceof \DOMElement);
            $labels[] = $label->getAttribute('for');
        }
        $fields = $xpath->query('//input[not(@type="hidden") and not(@type="submit")] | //textarea | //select');
        self::assertNotFalse($fields);
        self::assertGreaterThan(15, $fields->length);
        foreach ($fields as $field) {
            \assert($field instanceof \DOMElement);
            self::assertContains($field->getAttribute('id'), $labels, $field->getAttribute('name'));
            $described = $field->getAttribute('aria-describedby');
            if ($described !== '') {
                self::assertNotNull($doc->getElementById($described), $described);
            }
        }
        self::assertSame(\count($labels), \count(array_unique($labels)));
    }

    public function testCheckedStateAndValuesReflectTheSettings(): void
    {
        $html = $this->page(['enabled' => ['login' => true], 'login_allowlist' => ['203.0.113.7', '2001:db8::/48'], 'login_proxy_header' => 'HTTP_X_REAL_IP'])->html();
        self::assertMatchesRegularExpression('/id="wph-login" name="wp_hardening\[enabled\]\[login\]" value="1" checked/', $html);
        self::assertDoesNotMatchRegularExpression('/id="wph-xmlrpc" name="wp_hardening\[enabled\]\[xmlrpc\]" value="1" checked/', $html);
        self::assertStringContainsString("203.0.113.7\n2001:db8::/48</textarea>", $html);
        self::assertStringContainsString('<option value="HTTP_X_REAL_IP" selected>', $html);
        self::assertStringContainsString('&#039;self&#039;', $html);
    }

    public function testSanitizeReportsEachCorrection(): void
    {
        Functions\expect('add_settings_error')->twice();
        $values = $this->page()->sanitize(['login_allowlist' => 'nope', 'login_proxy_header' => 'HTTP_FAKE']);
        self::assertSame([], $values['login_allowlist']);
    }

    public function testRenderNeedsManageOptions(): void
    {
        Functions\when('current_user_can')->justReturn(false);
        ob_start();
        $this->page()->render();
        self::assertSame('', ob_get_clean());
    }

    public function testRegisterHooksTheMenuAndTheSetting(): void
    {
        $page = $this->page();
        $page->register();
        self::assertNotFalse(has_action('admin_menu', [$page, 'addPage']));
        Functions\expect('register_setting')->once()->with('wp-hardening', 'wp_hardening', \Mockery::on(static fn (array $a): bool => $a['show_in_rest'] === false && \is_callable($a['sanitize_callback'])));
        $page->registerSetting();
    }
}
