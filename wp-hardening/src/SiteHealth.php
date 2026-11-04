<?php

declare(strict_types=1);

namespace WpHardening;

use WpHardening\Audit\Audit;
use WpHardening\Audit\Finding;

/**
 * Adds one direct Site Health test per control and one per fast audit check. Every test is
 * read-only: it calls report() or an audit check, never register().
 */
final class SiteHealth
{
    /** @param list<Control> $controls */
    public function __construct(
        private readonly array $controls,
        private readonly Settings $settings,
        private readonly Audit $audit,
    ) {
    }

    public function register(): void
    {
        add_filter('site_status_tests', [$this, 'addTests']);
    }

    public function addTests(mixed $tests): mixed
    {
        if (!\is_array($tests)) {
            return $tests;
        }
        $direct = \is_array($tests['direct'] ?? null) ? $tests['direct'] : [];
        foreach ($this->controls as $control) {
            $direct['wp_hardening_' . $control->id()] = [
                'label' => $control->title(),
                'test' => fn (): array => $this->controlResult($control),
            ];
        }
        foreach ($this->audit->fastChecks() as $key => $check) {
            $direct['wp_hardening_audit_' . $key] = [
                'label' => \sprintf(__('Hardening audit: %s', 'wp-hardening'), Audit::FAST_TITLES[$key] ?? $key),
                'test' => fn (): array => $this->findingResult($key, $check()),
            ];
        }
        $tests['direct'] = $direct;
        return $tests;
    }

    /** @return array<string, mixed> */
    public function controlResult(Control $control): array
    {
        $report = $control->report($this->settings->enabled($control->id()));
        $label = $report->state === State::Good
            ? $control->title()
            : \sprintf(__('%s: not in force', 'wp-hardening'), $control->title());
        return $this->result('wp_hardening_' . $control->id(), $label, $report->state, $report->summary, $report->details, []);
    }

    /** @return array<string, mixed> */
    public function findingResult(string $key, Finding $finding): array
    {
        return $this->result(
            'wp_hardening_audit_' . $key,
            $finding->id . ' ' . $finding->title,
            $finding->verdict->state(),
            $finding->detail,
            [],
            $finding->evidence,
        );
    }

    /**
     * @param list<string> $details
     * @param list<string> $evidence
     * @return array<string, mixed>
     */
    private function result(string $test, string $label, State $state, string $summary, array $details, array $evidence): array
    {
        $html = '<p>' . esc_html($summary) . '</p>';
        foreach ($details as $detail) {
            $html .= '<p>' . esc_html($detail) . '</p>';
        }
        if ($evidence !== []) {
            $html .= '<ul>';
            foreach ($evidence as $item) {
                $html .= '<li><code>' . esc_html($item) . '</code></li>';
            }
            $html .= '</ul>';
        }
        return [
            'label' => $label,
            'status' => $state->value,
            'badge' => ['label' => __('Security', 'wp-hardening'), 'color' => 'blue'],
            'description' => $html,
            'actions' => '<p><a href="' . esc_url(admin_url('options-general.php?page=wp-hardening')) . '">' . esc_html__('Hardening settings', 'wp-hardening') . '</a></p>',
            'test' => $test,
        ];
    }
}
