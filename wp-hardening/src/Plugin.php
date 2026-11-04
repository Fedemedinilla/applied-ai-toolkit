<?php

declare(strict_types=1);

namespace WpHardening;

use WpHardening\Admin\SettingsPage;
use WpHardening\Audit\Audit;
use WpHardening\Cli\HardenCommand;
use WpHardening\Cli\WpCliOutput;
use WpHardening\Controls\FileEditing;
use WpHardening\Controls\LoginLimiter;
use WpHardening\Controls\SecurityHeaders;
use WpHardening\Controls\ServerRules;
use WpHardening\Controls\UserEnumeration;
use WpHardening\Controls\VersionDisclosure;
use WpHardening\Controls\XmlRpc;
use WpHardening\Env\Constants;
use WpHardening\Env\Headers;
use WpHardening\Env\Paths;
use WpHardening\Env\PhpConstants;
use WpHardening\Env\PhpHeaders;

/** Wires the controls to WordPress. Holds no state of its own beyond the settings it loaded. */
final class Plugin
{
    /** @var list<Control> */
    public readonly array $controls;

    public readonly ServerRules $rules;

    public readonly Audit $audit;

    /** @param Paths|\Closure(): Paths $paths A closure defers wp_upload_dir() until Site Health or WP-CLI needs a path. */
    public function __construct(
        public readonly Settings $settings,
        Constants $constants,
        Headers $headers,
        Paths|\Closure $paths,
    ) {
        $integrations = new Integrations($constants, $settings);
        $this->rules = new ServerRules($paths, $integrations);
        $this->controls = [
            new FileEditing($constants),
            new XmlRpc($integrations, $this->rules),
            new UserEnumeration(),
            new SecurityHeaders($settings, $headers, $integrations, $this->rules),
            new VersionDisclosure(),
            new LoginLimiter($settings),
            $this->rules,
        ];
        $this->audit = new Audit($paths, $constants);
    }

    public static function boot(): self
    {
        $plugin = new self(Settings::load(), new PhpConstants(), new PhpHeaders(), Paths::fromWordPress(...));
        $plugin->register();
        return $plugin;
    }

    /** Adds the hooks of every control whose toggle is on, then the read-only surfaces. */
    public function register(): void
    {
        foreach ($this->controls as $control) {
            if ($this->settings->enabled($control->id())) {
                $control->register();
            }
        }
        (new SiteHealth($this->controls, $this->settings, $this->audit))->register();
        if (is_admin()) {
            (new SettingsPage($this->controls, $this->settings))->register();
        }
        if (\defined('WP_CLI') && WP_CLI && class_exists('WP_CLI')) {
            \WP_CLI::add_command('harden', $this->command(new WpCliOutput()));
        }
    }

    public function command(Cli\Output $out): HardenCommand
    {
        return new HardenCommand(
            $this->controls,
            static fn (): Settings => Settings::load(),
            static function (Settings $settings): void {
                update_option(Settings::OPTION, $settings->toArray());
            },
            $this->audit,
            $this->rules,
            $out,
        );
    }
}
