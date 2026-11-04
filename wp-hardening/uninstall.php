<?php

declare(strict_types=1);

// Removes the plugin's option. Login counters are transients and expire on their own.
if (!\defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('wp_hardening');
