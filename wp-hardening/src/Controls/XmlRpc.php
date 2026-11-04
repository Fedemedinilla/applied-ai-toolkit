<?php

declare(strict_types=1);

namespace WpHardening\Controls;

use WpHardening\Control;
use WpHardening\Integrations;
use WpHardening\Report;
use WpHardening\State;

/**
 * SEG-07. Empties the XML-RPC method table and drops the X-Pingback header and the RSD link.
 * With no methods, xmlrpc.php still answers but can do nothing: no password guessing through
 * system.multicall, no pingbacks used to send traffic at another site.
 *
 * Guard: when an integration that uses XML-RPC is detected (Jetpack) or declared (the mobile
 * app), the control stands down and says why. Every check happens when the hook fires. If a
 * server rule pasted earlier still denies xmlrpc.php, Site Health reports it as critical.
 */
final class XmlRpc implements Control
{
    /** @param ServerRules|null $rules Reads the root .htaccess, so report() can see a server-level deny. */
    public function __construct(private readonly Integrations $integrations, private readonly ?ServerRules $rules = null)
    {
    }

    public function id(): string
    {
        return 'xmlrpc';
    }

    public function title(): string
    {
        return __('XML-RPC closed when nothing uses it', 'wp-hardening');
    }

    public function register(): void
    {
        add_filter('xmlrpc_enabled', [$this, 'filterEnabled']);
        add_filter('xmlrpc_methods', [$this, 'filterMethods'], PHP_INT_MAX);
        add_filter('wp_headers', [$this, 'filterHeaders']);
        add_action('wp_head', [$this, 'removeRsdLink'], 0);
    }

    public function blocking(): bool
    {
        return $this->integrations->xmlrpcUsers() === [];
    }

    public function filterEnabled(mixed $enabled): mixed
    {
        return $this->blocking() ? false : $enabled;
    }

    /** @return array<array-key, mixed>|mixed */
    public function filterMethods(mixed $methods): mixed
    {
        return $this->blocking() ? [] : $methods;
    }

    public function filterHeaders(mixed $headers): mixed
    {
        if (\is_array($headers) && $this->blocking()) {
            foreach (array_keys($headers) as $name) {
                if (\is_string($name) && strcasecmp($name, 'X-Pingback') === 0) {
                    unset($headers[$name]);
                }
            }
        }
        return $headers;
    }

    public function removeRsdLink(): void
    {
        if ($this->blocking()) {
            remove_action('wp_head', 'rsd_link');
        }
    }

    public function report(bool $enabled): Report
    {
        $users = $this->integrations->xmlrpcUsers();
        if ($users !== [] && $this->rules?->deniesXmlrpc() === true) {
            return new Report(
                State::Critical,
                \sprintf(__('%s uses XML-RPC, but the root .htaccess denies xmlrpc.php, so the server refuses it before WordPress runs.', 'wp-hardening'), implode(', ', $users)),
                [__('Remove the <Files xmlrpc.php> section from the .htaccess block. `wp harden htaccess` prints the block without it while the integration is detected.', 'wp-hardening')],
            );
        }
        if ($users !== []) {
            return new Report(
                State::Good,
                \sprintf(__('XML-RPC stays open because %s uses it.', 'wp-hardening'), implode(', ', $users)),
                [__('Closing it would disconnect that integration. Limit login attempts instead (the login control counts XML-RPC logins too).', 'wp-hardening')],
            );
        }
        if ($enabled) {
            return new Report(State::Good, __('XML-RPC answers with no methods, and the X-Pingback header and RSD link are gone.', 'wp-hardening'));
        }
        return new Report(
            State::Recommended,
            __('XML-RPC is open and no integration that needs it was found. It accepts many password guesses in one request.', 'wp-hardening'),
            [__('If the WordPress mobile app publishes to this site, declare it in the settings before turning this on.', 'wp-hardening')],
        );
    }

    public function plan(): array
    {
        $users = $this->integrations->xmlrpcUsers();
        if ($users !== []) {
            return ['Guard: ' . implode(', ', $users) . ' uses XML-RPC, so it stays open. The toggle is saved and takes effect if that changes.'];
        }
        return [
            'Empties the XML-RPC method table; xmlrpc.php answers but runs nothing.',
            'Removes the X-Pingback header and the RSD link from pages.',
            'For a 403 at the server as well, add the xmlrpc.php block from `wp harden htaccess`.',
        ];
    }
}
