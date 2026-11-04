<?php

declare(strict_types=1);

namespace WpHardening;

use WpHardening\Env\Constants;

/**
 * Detects the plugins that change what a control may do. Detection runs when a hook fires, not
 * when this plugin loads, because plugins load in an order this plugin does not control.
 */
final class Integrations
{
    /** Constant that each known page builder defines when it loads. */
    private const PAGE_BUILDERS = [
        'ELEMENTOR_VERSION' => 'Elementor',
        'FUSION_BUILDER_VERSION' => 'Avada (Fusion Builder)',
        'AVADA_VERSION' => 'Avada',
        'ET_BUILDER_VERSION' => 'Divi',
        'WPB_VC_VERSION' => 'WPBakery',
        'FL_BUILDER_VERSION' => 'Beaver Builder',
    ];

    public function __construct(private readonly Constants $constants, private readonly Settings $settings)
    {
    }

    /**
     * The integrations that need XML-RPC on this site. Jetpack is detected; the WordPress mobile
     * app cannot be, so the owner declares it in the settings. Other plugins can add themselves
     * through the `wp_hardening_xmlrpc_integrations` filter.
     *
     * @return list<string>
     */
    public function xmlrpcUsers(): array
    {
        $found = [];
        if ($this->constants->defined('JETPACK__VERSION') || class_exists('Jetpack', false)) {
            $found[] = 'Jetpack';
        }
        if ($this->settings->bool('xmlrpc_keep_for_app')) {
            $found[] = 'WordPress mobile app (declared in the settings)';
        }
        $filtered = apply_filters('wp_hardening_xmlrpc_integrations', $found);
        if (!\is_array($filtered)) {
            return $found;
        }
        return array_values(array_unique(array_filter($filtered, static fn ($v): bool => \is_string($v) && $v !== '')));
    }

    /** @return list<string> */
    public function pageBuilders(): array
    {
        $found = [];
        foreach (self::PAGE_BUILDERS as $constant => $name) {
            if ($this->constants->defined($constant)) {
                $found[] = $name;
            }
        }
        return array_values(array_unique($found));
    }
}
