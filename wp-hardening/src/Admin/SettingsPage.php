<?php

declare(strict_types=1);

namespace WpHardening\Admin;

use WpHardening\Control;
use WpHardening\Settings;

/**
 * Settings, Hardening. One checkbox per control with its current state next to it, then the
 * values the controls read. Uses WordPress's own form markup and styles, so labels, focus and
 * keyboard order follow the rest of the dashboard.
 */
final class SettingsPage
{
    public const SLUG = 'wp-hardening';

    /** @param list<Control> $controls */
    public function __construct(private readonly array $controls, private readonly Settings $settings)
    {
    }

    public function register(): void
    {
        add_action('admin_menu', [$this, 'addPage']);
        add_action('admin_init', [$this, 'registerSetting']);
    }

    public function addPage(): void
    {
        add_options_page(__('Hardening', 'wp-hardening'), __('Hardening', 'wp-hardening'), 'manage_options', self::SLUG, [$this, 'render']);
    }

    public function registerSetting(): void
    {
        register_setting(self::SLUG, Settings::OPTION, [
            'type' => 'array',
            'sanitize_callback' => [$this, 'sanitize'],
            'default' => Settings::DEFAULTS,
            'show_in_rest' => false,
        ]);
    }

    /** @return array<string, mixed> */
    public function sanitize(mixed $input): array
    {
        $result = Settings::sanitize($input);
        foreach ($result['errors'] as $i => $message) {
            add_settings_error(Settings::OPTION, 'wp_hardening_' . $i, $message, 'warning');
        }
        return $result['values'];
    }

    public function render(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        echo $this->html();
    }

    public function html(): string
    {
        $s = $this->settings;
        $o = Settings::OPTION;
        $h = '<div class="wrap"><h1>' . esc_html__('Hardening', 'wp-hardening') . '</h1>';
        $h .= '<p>' . esc_html__('Every control starts off. Turn on one at a time and load the site after each, so a problem points to one change.', 'wp-hardening') . '</p>';
        $h .= '<form method="post" action="options.php">';
        ob_start();
        settings_fields(self::SLUG);
        $h .= (string) ob_get_clean();

        $h .= '<h2>' . esc_html__('Controls', 'wp-hardening') . '</h2><table class="form-table" role="presentation"><tbody>';
        foreach ($this->controls as $control) {
            $id = $control->id();
            $field = 'wph-' . $id;
            $report = $control->report($s->enabled($id));
            $h .= '<tr><th scope="row"><label for="' . esc_attr($field) . '">' . esc_html($control->title()) . '</label></th><td>';
            $h .= '<input type="checkbox" id="' . esc_attr($field) . '" name="' . esc_attr("{$o}[enabled][{$id}]") . '" value="1"' . ($s->enabled($id) ? ' checked' : '') . ' aria-describedby="' . esc_attr($field . '-state') . '"> ';
            $h .= '<p class="description" id="' . esc_attr($field . '-state') . '">' . esc_html($report->summary) . '</p></td></tr>';
        }
        $h .= '</tbody></table>';

        $h .= '<h2>' . esc_html__('XML-RPC', 'wp-hardening') . '</h2><table class="form-table" role="presentation"><tbody>';
        $h .= $this->checkbox('xmlrpc_keep_for_app', __('The WordPress mobile app publishes here', 'wp-hardening'), __('Keeps XML-RPC open. The app cannot be detected from the server.', 'wp-hardening'));
        $h .= '</tbody></table>';

        $h .= '<h2>' . esc_html__('Security headers', 'wp-hardening') . '</h2><table class="form-table" role="presentation"><tbody>';
        $h .= $this->number('hsts_max_age', __('HSTS max-age (seconds)', 'wp-hardening'), 0, Settings::MAX_HSTS_AGE, __('0 sends no HSTS. 15552000 is 180 days.', 'wp-hardening'));
        $h .= $this->checkbox('hsts_subdomains', __('HSTS includeSubDomains', 'wp-hardening'), __('Only once every subdomain answers over HTTPS. A subdomain on plain HTTP becomes unreachable.', 'wp-hardening'));
        $h .= $this->checkbox('hsts_preload', __('HSTS preload', 'wp-hardening'), __('Needs includeSubDomains and a year. Leaving the preload list takes months.', 'wp-hardening'));
        $h .= $this->textarea('csp_report_only', __('Content-Security-Policy-Report-Only', 'wp-hardening'), __('Reported, never enforced. Empty sends nothing.', 'wp-hardening'));
        $h .= $this->text('csp_report_uri', __('CSP report URI', 'wp-hardening'), __('Optional https:// endpoint that receives the reports.', 'wp-hardening'));
        $h .= '</tbody></table>';

        $h .= '<h2>' . esc_html__('Login attempts', 'wp-hardening') . '</h2><table class="form-table" role="presentation"><tbody>';
        $h .= $this->number('login_max_attempts', __('Failed logins before a lockout', 'wp-hardening'), 3, 50, '');
        $h .= $this->number('login_window_minutes', __('Counting window (minutes)', 'wp-hardening'), 1, 1440, '');
        $h .= $this->number('login_lockout_minutes', __('Lockout (minutes)', 'wp-hardening'), 1, 1440, '');
        $h .= $this->textarea('login_allowlist', __('Never lock these addresses', 'wp-hardening'), __('One IP address or range per line, such as 203.0.113.7 or 2001:db8::/48.', 'wp-hardening'), implode("\n", $s->allowlist()));
        $h .= $this->select('login_proxy_header', __('Client address comes from', 'wp-hardening'), [
            '' => 'REMOTE_ADDR (no proxy)',
            'HTTP_CF_CONNECTING_IP' => 'CF-Connecting-IP',
            'HTTP_X_REAL_IP' => 'X-Real-IP',
            'HTTP_X_FORWARDED_FOR' => 'X-Forwarded-For (last entry)',
        ], __('Pick a header only if a proxy you control sets it. Otherwise a client can choose its own address.', 'wp-hardening'));
        $h .= '</tbody></table>';

        ob_start();
        submit_button();
        $h .= (string) ob_get_clean();
        return $h . '</form></div>';
    }

    private function name(string $key): string
    {
        return Settings::OPTION . '[' . $key . ']';
    }

    private function row(string $key, string $label, string $control, string $help): string
    {
        $id = 'wph-' . $key;
        $out = '<tr><th scope="row"><label for="' . esc_attr($id) . '">' . esc_html($label) . '</label></th><td>' . $control;
        if ($help !== '') {
            $out .= '<p class="description" id="' . esc_attr($id . '-help') . '">' . esc_html($help) . '</p>';
        }
        return $out . '</td></tr>';
    }

    private function describedBy(string $key, string $help): string
    {
        return $help === '' ? '' : ' aria-describedby="' . esc_attr('wph-' . $key . '-help') . '"';
    }

    private function checkbox(string $key, string $label, string $help): string
    {
        $input = '<input type="checkbox" id="' . esc_attr('wph-' . $key) . '" name="' . esc_attr($this->name($key)) . '" value="1"'
            . ($this->settings->bool($key) ? ' checked' : '') . $this->describedBy($key, $help) . '>';
        return $this->row($key, $label, $input, $help);
    }

    private function number(string $key, string $label, int $min, int $max, string $help): string
    {
        $input = '<input type="number" class="small-text" id="' . esc_attr('wph-' . $key) . '" name="' . esc_attr($this->name($key)) . '" min="' . $min . '" max="' . $max . '" value="'
            . esc_attr((string) $this->settings->int($key)) . '"' . $this->describedBy($key, $help) . '>';
        return $this->row($key, $label, $input, $help);
    }

    private function text(string $key, string $label, string $help): string
    {
        $input = '<input type="url" class="regular-text" id="' . esc_attr('wph-' . $key) . '" name="' . esc_attr($this->name($key)) . '" value="'
            . esc_attr($this->settings->string($key)) . '"' . $this->describedBy($key, $help) . '>';
        return $this->row($key, $label, $input, $help);
    }

    private function textarea(string $key, string $label, string $help, ?string $value = null): string
    {
        $input = '<textarea class="large-text code" rows="3" id="' . esc_attr('wph-' . $key) . '" name="' . esc_attr($this->name($key)) . '"' . $this->describedBy($key, $help) . '>'
            . esc_textarea($value ?? $this->settings->string($key)) . '</textarea>';
        return $this->row($key, $label, $input, $help);
    }

    /** @param array<string, string> $choices */
    private function select(string $key, string $label, array $choices, string $help): string
    {
        $current = $this->settings->string($key);
        $input = '<select id="' . esc_attr('wph-' . $key) . '" name="' . esc_attr($this->name($key)) . '"' . $this->describedBy($key, $help) . '>';
        foreach ($choices as $value => $text) {
            $input .= '<option value="' . esc_attr($value) . '"' . ($value === $current ? ' selected' : '') . '>' . esc_html($text) . '</option>';
        }
        return $this->row($key, $label, $input . '</select>', $help);
    }
}
