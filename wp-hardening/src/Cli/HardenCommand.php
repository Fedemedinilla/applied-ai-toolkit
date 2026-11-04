<?php

declare(strict_types=1);

namespace WpHardening\Cli;

use WpHardening\Audit\Audit;
use WpHardening\Audit\Verdict;
use WpHardening\Control;
use WpHardening\Controls\ServerRules;
use WpHardening\Settings;

/**
 * Reports and toggles the hardening controls, and runs the read-only audit.
 *
 * ## EXAMPLES
 *
 *     wp harden status
 *     wp harden apply --only=file_edit,version --dry-run
 *     wp harden revert --only=headers
 *     wp harden audit --format=json
 *     wp harden htaccess --server=nginx
 */
final class HardenCommand
{
    /**
     * @param list<Control> $controls
     * @param \Closure(): Settings $load
     * @param \Closure(Settings): void $save
     */
    public function __construct(
        private readonly array $controls,
        private readonly \Closure $load,
        private readonly \Closure $save,
        private readonly Audit $audit,
        private readonly ServerRules $rules,
        private readonly Output $out,
    ) {
    }

    /**
     * Shows each control: its toggle, its state and what is in force.
     *
     * ## OPTIONS
     *
     * [--format=<format>]
     * : table or json.
     * ---
     * default: table
     * ---
     *
     * @param list<string> $args
     * @param array<string, string|bool> $assoc
     */
    public function status(array $args = [], array $assoc = []): void
    {
        $settings = ($this->load)();
        $rows = [];
        foreach ($this->controls as $control) {
            $report = $control->report($settings->enabled($control->id()));
            $rows[] = [
                'control' => $control->id(),
                'toggle' => $settings->enabled($control->id()) ? 'on' : 'off',
                'state' => $report->state->value,
                'summary' => $report->summary,
            ];
        }
        $this->emit($rows, ['control', 'toggle', 'state', 'summary'], $assoc);
    }

    /**
     * Turns controls on. Names them one by one, or all of them with --all.
     *
     * ## OPTIONS
     *
     * [--only=<ids>]
     * : Comma-separated control ids, as `wp harden status` lists them.
     *
     * [--all]
     * : Every control. Turning on one at a time makes a problem easier to trace.
     *
     * [--dry-run]
     * : Print what would change, guards included, and save nothing.
     *
     * @param list<string> $args
     * @param array<string, string|bool> $assoc
     */
    public function apply(array $args = [], array $assoc = []): void
    {
        $this->toggle(true, $assoc);
    }

    /**
     * Turns controls off: the way back for `apply`.
     *
     * ## OPTIONS
     *
     * [--only=<ids>]
     * : Comma-separated control ids.
     *
     * [--all]
     * : Every control.
     *
     * [--dry-run]
     * : Print what would change and save nothing.
     *
     * @param list<string> $args
     * @param array<string, string|bool> $assoc
     */
    public function revert(array $args = [], array $assoc = []): void
    {
        $this->toggle(false, $assoc);
    }

    /**
     * Runs the read-only audit. Exits with 1 when any check fails.
     *
     * ## OPTIONS
     *
     * [--format=<format>]
     * : table or json.
     * ---
     * default: table
     * ---
     *
     * [--fast]
     * : Only the checks Site Health also runs; no file walks or table scans.
     *
     * @param list<string> $args
     * @param array<string, string|bool> $assoc
     */
    public function audit(array $args = [], array $assoc = []): void
    {
        $findings = $this->audit->run(($assoc['fast'] ?? false) !== false);
        $rows = [];
        foreach ($findings as $finding) {
            $rows[] = [
                'id' => $finding->id,
                'check' => $finding->title,
                'verdict' => $finding->verdict->value,
                'detail' => $finding->detail,
                'evidence' => implode('; ', $finding->evidence),
            ];
        }
        if (($assoc['format'] ?? 'table') === 'json') {
            $this->out->json(array_map(static fn ($f): array => $f->toArray(), $findings));
        } else {
            $this->out->table($rows, ['id', 'check', 'verdict', 'detail', 'evidence']);
        }
        $failed = array_filter($findings, static fn ($f): bool => $f->verdict === Verdict::Fail);
        if ($failed !== []) {
            $this->out->halt(1);
        }
    }

    /**
     * Prints the server rules this plugin cannot apply from PHP. Writes nothing.
     *
     * ## OPTIONS
     *
     * [--server=<server>]
     * : apache (also LiteSpeed) or nginx. Defaults to the detected server.
     *
     * @param list<string> $args
     * @param array<string, string|bool> $assoc
     */
    public function htaccess(array $args = [], array $assoc = []): void
    {
        $server = \is_string($assoc['server'] ?? null) ? $assoc['server'] : $this->rules->server();
        if ($server === 'nginx') {
            $this->out->line($this->rules->nginxBlock());
        } elseif ($server === 'apache' || $server === 'unknown') {
            $this->out->line('# Add to .htaccess in the site root, outside the WordPress block:');
            $this->out->line($this->rules->rootBlock());
            $this->out->line('# Add to wp-content/uploads/.htaccess (create it if missing):');
            $this->out->line($this->rules->uploadsBlock());
        } else {
            $this->out->error("Unknown server: {$server}. Use apache or nginx.");
        }
        $this->out->line('Nothing was written. Copy each file first, paste the block, and load the site right after: a 500 means the host refuses a rule, so put the copy back.');
    }

    /** @param array<string, string|bool> $assoc */
    private function toggle(bool $on, array $assoc): void
    {
        $ids = $this->selection($assoc);
        $dry = ($assoc['dry-run'] ?? false) !== false;
        $settings = ($this->load)();
        $changed = false;
        foreach ($ids as $id) {
            $control = $this->control($id);
            $was = $settings->enabled($id);
            if ($was === $on) {
                $this->out->line("{$id}: already " . ($on ? 'on' : 'off') . '.');
                continue;
            }
            $verb = $on ? 'turn on' : 'turn off';
            $this->out->line($dry ? "{$id}: would {$verb}." : "{$id}: " . ($on ? 'turned on' : 'turned off') . '.');
            if ($on) {
                foreach ($control->plan() as $line) {
                    $this->out->line('  ' . $line);
                }
            }
            $settings = $settings->withEnabled($id, $on);
            $changed = true;
        }
        if ($dry) {
            $this->out->line('Dry run: nothing was saved.');
            return;
        }
        if ($changed) {
            ($this->save)($settings);
        }
    }

    /**
     * @param array<string, string|bool> $assoc
     * @return list<string>
     */
    private function selection(array $assoc): array
    {
        $all = array_map(static fn (Control $c): string => $c->id(), $this->controls);
        $only = $assoc['only'] ?? null;
        if (($assoc['all'] ?? false) !== false) {
            if ($only !== null) {
                $this->out->error('Use --only or --all, not both.');
            }
            return $all;
        }
        if (!\is_string($only) || trim($only) === '') {
            $this->out->error('Name the controls with --only=<ids> (see `wp harden status`), or pass --all.');
        }
        $ids = array_values(array_unique(array_filter(array_map('trim', explode(',', $only)), static fn (string $s): bool => $s !== '')));
        $unknown = array_diff($ids, $all);
        if ($unknown !== []) {
            $this->out->error('Unknown control: ' . implode(', ', $unknown) . '. Known: ' . implode(', ', $all) . '.');
        }
        return $ids;
    }

    private function control(string $id): Control
    {
        foreach ($this->controls as $control) {
            if ($control->id() === $id) {
                return $control;
            }
        }
        $this->out->error("Unknown control: {$id}.");
    }

    /**
     * @param list<array<string, string>> $rows
     * @param list<string> $fields
     * @param array<string, string|bool> $assoc
     */
    private function emit(array $rows, array $fields, array $assoc): void
    {
        if (($assoc['format'] ?? 'table') === 'json') {
            $this->out->json($rows);
            return;
        }
        $this->out->table($rows, $fields);
    }
}
