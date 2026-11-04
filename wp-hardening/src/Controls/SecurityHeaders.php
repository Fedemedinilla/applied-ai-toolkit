<?php

declare(strict_types=1);

namespace WpHardening\Controls;

use WpHardening\Control;
use WpHardening\Env\Headers;
use WpHardening\Integrations;
use WpHardening\Report;
use WpHardening\Settings;
use WpHardening\State;

/**
 * SEG-09. Sends HSTS, X-Content-Type-Options, Referrer-Policy, X-Frame-Options and a
 * Content-Security-Policy-Report-Only on pages, the dashboard and the login screen.
 *
 * Guards:
 * - HSTS goes out only over HTTPS, and without includeSubDomains or preload unless the owner
 *   turns them on (preload also needs a year and includeSubDomains). A preloaded domain with one
 *   subdomain still on HTTP makes that subdomain unreachable, and leaving the list takes months.
 * - The CSP is only ever Report-Only. This plugin has no setting that enforces it, because page
 *   builders depend on inline scripts and styles that a strict policy blocks.
 * - A header already set from PHP (WordPress core, another plugin) is not sent again: two
 *   X-Frame-Options or two HSTS values are an error in some browsers. Headers the web server adds
 *   (Apache `Header always set`, nginx `add_header`) are invisible to PHP, so report() reads the
 *   root .htaccess for them and asks the owner to keep one of the two.
 * - X-Frame-Options is not sent on embed views (/embed/, ?embed=true), which other sites frame on
 *   purpose to show a post card.
 */
final class SecurityHeaders implements Control
{
    public function __construct(
        private readonly Settings $settings,
        private readonly Headers $headers,
        private readonly Integrations $integrations,
        private readonly ?ServerRules $rules = null,
    ) {
    }

    public function id(): string
    {
        return 'headers';
    }

    public function title(): string
    {
        return __('Security headers', 'wp-hardening');
    }

    public function register(): void
    {
        add_action('send_headers', [$this, 'send'], 10, 1);
        add_action('admin_init', [$this, 'send']);
        add_action('login_init', [$this, 'send']);
    }

    /**
     * The headers this site should send, in order.
     *
     * @return array<string, string>
     */
    public function headers(bool $https, bool $embed = false): array
    {
        $out = [];
        $age = $this->settings->int('hsts_max_age');
        if ($https && $age > 0) {
            $hsts = 'max-age=' . $age;
            if ($this->settings->bool('hsts_subdomains')) {
                $hsts .= '; includeSubDomains';
                if ($this->settings->bool('hsts_preload') && $age >= Settings::PRELOAD_MIN_AGE) {
                    $hsts .= '; preload';
                }
            }
            $out['Strict-Transport-Security'] = $hsts;
        }
        $out['X-Content-Type-Options'] = 'nosniff';
        $out['Referrer-Policy'] = 'strict-origin-when-cross-origin';
        if (!$embed) {
            $out['X-Frame-Options'] = 'SAMEORIGIN';
        }
        $csp = $this->settings->string('csp_report_only');
        if ($csp !== '') {
            $uri = $this->settings->string('csp_report_uri');
            $out['Content-Security-Policy-Report-Only'] = $uri === '' ? $csp : rtrim($csp, '; ') . '; report-uri ' . $uri;
        }
        $filtered = apply_filters('wp_hardening_headers', $out, $https);
        if (!\is_array($filtered)) {
            return $out;
        }
        $clean = [];
        foreach ($filtered as $name => $value) {
            // A filter may drop a header but not turn the report-only policy into an enforced one,
            // and nothing with a line break reaches header().
            if (!\is_string($name) || !\is_string($value) || strcasecmp($name, 'Content-Security-Policy') === 0) {
                continue;
            }
            if (preg_match('/[\r\n\x00]/', $name . $value) === 1) {
                continue;
            }
            $clean[$name] = $value;
        }
        return $clean;
    }

    /** send_headers passes the WP object, whose query vars are parsed by then; admin_init and login_init pass nothing. */
    public static function isEmbed(mixed $wp): bool
    {
        if (!\is_object($wp) || !isset($wp->query_vars) || !\is_array($wp->query_vars)) {
            return false;
        }
        $embed = $wp->query_vars['embed'] ?? null;
        return $embed !== null && $embed !== '' && $embed !== false;
    }

    public function send(mixed $wp = null): void
    {
        if (!$this->headers->canSend()) {
            return;
        }
        $already = array_map('strtolower', $this->headers->sent());
        foreach ($this->headers(is_ssl(), self::isEmbed($wp)) as $name => $value) {
            if (!\in_array(strtolower($name), $already, true)) {
                $this->headers->send($name, $value);
            }
        }
    }

    public function report(bool $enabled): Report
    {
        $details = [];
        $builders = $this->integrations->pageBuilders();
        if ($builders !== []) {
            $details[] = \sprintf(
                __('%s is active. It uses inline scripts and styles, so the CSP stays Report-Only: read the browser console reports before tightening a directive.', 'wp-hardening'),
                implode(', ', $builders),
            );
        }
        if (!$enabled) {
            return new Report(
                State::Recommended,
                __('No security headers are sent by this plugin.', 'wp-hardening'),
                $details,
            );
        }
        $https = is_ssl();
        if (\defined('WP_CLI') && WP_CLI) {
            $details[] = __('Run from WP-CLI: HSTS is sent only on HTTPS page requests.', 'wp-hardening');
        } elseif (!$https) {
            $details[] = __('This request is not HTTPS, so HSTS is not sent. Browsers ignore it over HTTP anyway.', 'wp-hardening');
        }
        $details[] = __('X-Frame-Options is left off embed views (/embed/), which other sites frame on purpose.', 'wp-hardening');
        $names = implode(', ', array_keys($this->headers($https)));
        $twice = $this->rules?->serverHeaders() ?? [];
        if ($twice !== []) {
            return new Report(
                State::Recommended,
                \sprintf(__('The root .htaccess already sets %s, and this plugin sends them again from PHP, so responses carry two copies.', 'wp-hardening'), implode(', ', $twice)),
                [__('Keep one source: remove those Header lines from .htaccess, or turn this control off.', 'wp-hardening'), ...$details],
            );
        }
        return new Report(State::Good, \sprintf(__('Sent on pages, the dashboard and the login screen: %s.', 'wp-hardening'), $names), $details);
    }

    public function plan(): array
    {
        $lines = [];
        foreach ($this->headers(true) as $name => $value) {
            $lines[] = "{$name}: {$value}";
        }
        $lines[] = 'Strict-Transport-Security is sent only on HTTPS requests; X-Frame-Options is not sent on /embed/ views.';
        $lines[] = 'A header already set from PHP is left as it is. Headers the web server adds are invisible to PHP: if the server configuration already sends these, remove them there or leave this control off, or responses carry two copies.';
        $twice = $this->rules?->serverHeaders() ?? [];
        if ($twice !== []) {
            $lines[] = 'Found in the root .htaccess: ' . implode(', ', $twice) . '. Remove those Header lines before turning this on.';
        }
        $builders = $this->integrations->pageBuilders();
        if ($builders !== []) {
            $lines[] = 'Guard: ' . implode(', ', $builders) . ' detected; the CSP is Report-Only and this plugin never enforces it.';
        }
        return $lines;
    }
}
