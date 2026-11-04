<?php
/**
 * Plugin Name:       WP Hardening
 * Description:       Applies the hardening controls that can be set in code, one toggle at a time, with a Site Health test for each, a WP-CLI command (wp harden) and a read-only audit.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      8.1
 * Author:            Federico Medinilla
 * Author URI:        https://federicomedinilla.com
 * Text Domain:       wp-hardening
 */

declare(strict_types=1);

namespace WpHardening;

if (!\defined('ABSPATH')) {
    exit;
}

// This file has to parse on old PHP so it can say why it stops; the code under src/ needs 8.1.
if (version_compare(PHP_VERSION, '8.1', '<')) {
    add_action('admin_notices', static function () {
        echo '<div class="notice notice-error"><p>' . esc_html__('WP Hardening needs PHP 8.1 or newer and has not loaded.', 'wp-hardening') . '</p></div>';
    });
    return;
}

// The plugin ships without vendor/: Composer is only for the tests, so this loader maps the namespace to src/.
spl_autoload_register(static function (string $class): void {
    $prefix = __NAMESPACE__ . '\\';
    if (strncmp($class, $prefix, \strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, \strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

Plugin::boot();
