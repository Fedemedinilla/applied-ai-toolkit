# wp-hardening

A WordPress plugin with seven hardening controls that can be set from PHP, each behind a toggle, with a guard that keeps it from breaking the site. It adds a Site Health test per control, a `wp harden` command for WP-CLI and a read-only audit.

The controls come from the hardening checklist I use for WordPress maintenance work, and so do the guards, because each control on that list has a known way of breaking a site. Turning off the whole REST API takes the block editor with it. HSTS preload strands a subdomain still on HTTP, a strict CSP blanks a page built with Elementor, and closing XML-RPC disconnects Jetpack. Each control here carries the guard against its own failure, and a unit test that checks the guard. Rules that only the web server can apply (PHP in uploads, directory listing) are generated and checked, never written.

## Run it

PHP 8.1 or newer and Composer. Composer is only for the tests; the plugin itself ships without `vendor/` and loads its classes with its own autoloader.

```sh
cd wp-hardening
composer install          # PHPUnit 10.5.66, Brain Monkey 2.7.0, Mockery 1.6.15, from composer.lock
vendor/bin/phpunit        # offline; no WordPress, no database, no network
```

The suite stubs WordPress functions with Brain Monkey and uses temporary directories for the file checks, so it needs neither a WordPress install nor a database. On 2026-11-04 it ran 171 tests with 649 assertions on PHP 8.3.6. That run was as root, so the one test that needs an unreadable directory was skipped; it runs under a normal user, as in CI.

To try it on a site, copy the folder (without `vendor/`) to `wp-content/plugins/wp-hardening` and activate it. Activation changes nothing. Then:

```sh
wp harden status                                  # each control: toggle, Site Health state, what is in force
wp harden apply --only=file_edit --dry-run        # what turning it on does here, guards included
wp harden apply --only=file_edit,version          # turn on, one or a few at a time
wp harden revert --only=version                   # the way back
wp harden htaccess                                # print the server rules (--server=nginx for nginx); writes nothing
wp harden audit                                   # read-only checks; exit 1 if any check fails
wp harden audit --fast --format=json              # only the checks Site Health also runs
```

The same toggles are under Settings > Hardening, and each control and each fast audit check shows up in Tools > Site Health.

## The controls

| Control (id) | What it does | The guard | Why |
|---|---|---|---|
| File editor (`file_edit`) | Defines `DISALLOW_FILE_EDIT` as true, which removes the theme and plugin editors from the dashboard. | A value already in `wp-config.php` wins, including an explicit `false`, and `wp-config.php` is never edited. | A stolen administrator session can otherwise write PHP from the dashboard. Editing `wp-config.php` by hand is the usual way to make this change, and a syntax error there blanks the site. |
| XML-RPC (`xmlrpc`) | Empties the XML-RPC method table and drops the `X-Pingback` header and the RSD link. `xmlrpc.php` still answers, with nothing to run. | Stands down while Jetpack is active (`JETPACK__VERSION` or the `Jetpack` class), while the owner declares that the mobile app publishes to the site, or while any plugin lists itself in the `wp_hardening_xmlrpc_integrations` filter. The check runs when the hook fires, not when the plugin loads. | `system.multicall` lets one request try hundreds of passwords, and pingbacks can be used to send traffic at another site. Jetpack's connection runs over XML-RPC, so closing it disconnects Jetpack. |
| User names (`user_enumeration`) | For anonymous visitors: a 401 from `/wp/v2/users` and `/wp/v2/users/<id>`, a 404 for `?author=N` (as a GET or a POST parameter, both of which WordPress reads) before it redirects to `/author/<login>/`, and no users sitemap. | Only those routes. Every other REST route answers as before, and logged-in users keep `/wp/v2/users`, which the block editor uses for the author picker. | A login name is half of what a password-guessing script needs. The common fix in the wild turns off the whole REST API, which breaks the block editor and Elementor. |
| Security headers (`headers`) | HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN` and a `Content-Security-Policy-Report-Only`, on pages, the dashboard and the login screen. | HSTS only over HTTPS, at 180 days, with no `includeSubDomains` and no `preload` unless the owner turns them on. Preload also needs a year and `includeSubDomains`, or the setting is refused. The CSP is only ever Report-Only: there is no setting that enforces it, and a filter that adds an enforcing `Content-Security-Policy` is dropped. A header already set from PHP (WordPress core, another plugin) is not sent again, and Site Health reports the same headers set in the root `.htaccess`. No `X-Frame-Options` on `/embed/` views, which other sites frame on purpose. | A preloaded domain makes every subdomain HTTPS-only for months, so one subdomain still on plain HTTP becomes unreachable. Page builders depend on inline scripts and styles that a strict CSP blocks. Two `X-Frame-Options` values are treated as an error by some browsers, and `X-Frame-Options` on an embed view blanks this site's post cards wherever they are embedded. |
| Version (`version`) | Removes the generator meta tag from pages and feeds, and replaces `?ver=` on this site's scripts and styles with the first 10 hex digits of an HMAC of the value. | `?ver=` keeps changing with each version, so browser and CDN caches still refresh after an update. Third-party URLs are left as they are. | Removing `?ver=` outright keeps visitors on stale CSS and JavaScript after an update. A plain hash of "6.8.3" can be reversed by hashing every released version, so the hash is keyed with a site salt. |
| Login attempts (`login`) | Counts failed logins per client address; at the limit (5 in 15 minutes by default) every login from that address is refused for 15 minutes. Covers `wp-login.php` and XML-RPC, which both go through `wp_authenticate()`. | An allowlist of addresses and ranges that are never counted. The lock is per address, never per user name, and a successful login does not reset the count. An IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) is counted, and matched against the allowlist, as the IPv4 address it carries. The address is `REMOTE_ADDR` unless the owner picks the header a proxy in front sets. A request with no valid address is not counted. | Locking a user name lets anyone lock the real administrator out by typing wrong passwords for it. A reset on login would let anyone with one valid account (a shop customer) guess four times, log in as themselves and repeat. Some dual-stack servers report every IPv4 client in the mapped form, which would otherwise put all of them in one IPv6 /64 and lock them out together. Reading `X-Forwarded-For` by default lets a script choose a new address on every request. Counting requests with no address under one key would lock everyone out at once. |
| Server rules (`server_rules`) | `wp harden htaccess` prints a root block (`Options -Indexes`, deny `readme.html`, deny `xmlrpc.php`) and an uploads block (deny PHP, `nosniff` on uploaded files), or the nginx equivalent. With the toggle on, Site Health checks that both blocks are in place. The root file is looked up where the home URL is served, which is one level above core when WordPress sits in its own directory. | The plugin never writes `.htaccess`. The `xmlrpc.php` rule is left out while an XML-RPC integration is detected, and an `xmlrpc.php` deny already in the root `.htaccess` while one is detected is reported as critical, toggle on or off. Each deny has the Apache 2.4 and 2.2 forms side by side. On nginx the uploads rule is a `^~` prefix location built from the site's uploads path. | A syntax error in `.htaccess`, or `Options` on a host that does not allow it, turns every page into a 500. The owner adds the block with a copy of the file and loads the site right after. A deny pasted before Jetpack was installed keeps Jetpack disconnected while the XML-RPC control says it is open. nginx uses the first regex location that matches, so a regex deny placed after the usual `location ~ \.php$` never runs and PHP in uploads still executes; a `^~` location wins wherever it sits. |

## The audit

`wp harden audit` runs the indicators from that checklist that can be computed from inside WordPress without network access and without changing anything. The SEG and INT numbers in the code are item ids from my own WordPress maintenance checklist, which is not published. They are kept so each control and check traces back to the item it came from. Evidence lists file names, option names and counts, never file contents or secret values; the salts check names a weak key but never prints it.

| Id | Check | Where it runs |
|---|---|---|
| INT-11 | Open registration (fails when new accounts get a role above subscriber); `WP_DEBUG` on, and whether errors reach the page or the log sits in the web root | Site Health and CLI |
| INT-16 | All eight keys and salts set, at least 32 characters, distinct, not the placeholder | Site Health and CLI |
| INT-05, INT-13 | Administrator count, shared or default logins, application passwords on administrator accounts that were never used | Site Health and CLI |
| INT-10, INT-18 | Inactive plugins, more than three themes, child theme in use | Site Health and CLI |
| INT-25, INT-12, INT-24 | PHP older than 8.2 or `memory_limit` under 256M; `?p=` permalinks; pingbacks open by default | Site Health and CLI |
| INT-17 | `wp-config.php` readable or writable by every account on the server | Site Health and CLI |
| INT-04 | Autoloaded options over 800 KB (CLI also: options holding `<?php`, `base64_decode(` or `eval(`) | Site Health and CLI |
| INT-02 | PHP files, and images with PHP inside, under `uploads/` | CLI |
| INT-03 | Must-use plugins without a `Plugin Name:` header; drop-ins present | CLI |
| INT-14 | PHP files under `wp-content` changed in the last 30 days | CLI |
| INT-15 | `.htaccess` lines that rewrite to another host, branch on the user agent, prepend PHP or map PHP to an image extension (the plugin's own block is skipped) | CLI |
| INT-20 | Scheduled tasks with no code attached | CLI |
| INT-21 | Posts with `<script`, `<iframe` or `javascript:` | CLI |
| INT-01 | Core file integrity | Reported as skipped, see Limits |

The file walks stop after 20,000 files, and a walk that stopped early, or hit a directory it could not open, is reported as a warning, never as a pass. The two SQL checks are `SELECT ... LIMIT 20`.

## Design decisions

**Nothing changes on activation.** Every toggle starts off, and `wp harden apply` needs `--only=<ids>` or an explicit `--all`. A plugin that turns on seven controls at once leaves no way to tell which one broke a checkout page. The source checklist adds one measure and checks the site before the next one.

**A control that is off adds no hooks.** Otherwise a control the owner turned off could still change a response, and the toggle would not be the way back. `register()` is called only for controls whose toggle is on, and Site Health calls the read-only `report()`. A test boots the plugin with default settings and checks that none of the control hooks exist.

**Detection happens when the hook fires.** Plugins load in an order this plugin does not control, so "is Jetpack active" asked at load time can answer no on a site that runs Jetpack. The XML-RPC filters ask on each call. For the same reason the directory paths are built only when Site Health or WP-CLI needs them. `wp_upload_dir()` caches its result for the request, so calling it while plugins load would fix the upload paths before an offload plugin hooks `upload_dir`.

**Constants and headers go through seams.** A PHP constant cannot be undefined once a process defines it, and `header()` cannot be read back in a test. `Constants` and `Headers` are two small interfaces with a PHP implementation and a fake, so the guards on `DISALLOW_FILE_EDIT` and on headers set earlier in PHP are tested in one process. Without them, the explicit-false guard on `DISALLOW_FILE_EDIT` could only be tested in a separate process per case.

**The plugin writes only its own option and the login counters.** Settings live in one option, saved only by the settings form and `wp harden apply`/`revert`; the login limiter keeps its counters in transients that expire on their own. A test reads every source file and fails if any file calls a write function (`file_put_contents`, `fopen`, `unlink`, `chmod`, `insert_with_markers`, `update_option`, `set_transient`, `$wpdb->query` and others) outside three places: the settings save, the transients in the login limiter and `delete_option` in `uninstall.php`. The detector itself is tested against sample lines, `$wpdb->query(` among them. Another runs `report()`, `installed()` and the whole audit over a temporary site and checks that no file appeared or changed.

**Settings are validated as header values.** The CSP and the report URI end up in a response header. A value with a line break or another control character is refused and reset to the default, so it never reaches `header()` as a second header. The proxy header must be one of four fixed names. The allowlist keeps valid addresses and ranges and reports each line it drops.

**IPv6 is counted per /64, and mapped IPv4 as IPv4.** One host usually holds a whole /64 and can rotate addresses inside it, so counting per address would give it millions of fresh tries. An address in the `::ffff:a.b.c.d` form is turned back into IPv4 first. Lock keys are a hash of the address bucket, which keeps them under the transient name limit and keeps client addresses out of option names.

**A lockout has a fixed end.** Failures during a lockout are not counted, so a script that keeps trying does not extend it indefinitely, and the message can say when to try again.

## What the tests cover

`vendor/bin/phpunit` runs one test class per control and per surface (Site Health, settings page, WP-CLI command, plugin wiring, bootstrap file):

- Each guard named in the table above, as its own test. The XML-RPC and file editor tests cover Jetpack, the declared mobile app and an explicit `false` in `wp-config.php`. The REST tests list the routes that must keep answering, and check that `/WP/V2/Users` is blocked too, because WordPress matches routes regardless of case. The header tests cover HTTP requests, a short max-age, an enforcing CSP added by a filter, a header already sent, embed views and the same headers set in `.htaccess`. The author tests cover `author` in `$_GET`, in `$_POST` and in the parsed query, and leave `/author/<slug>/` alone. The login tests cover the allowlist, per-address locking, a successful login that does not reset the count, IPv4-mapped addresses, `X-Forwarded-For` ignored by default and requests with no address. The server rules tests cover an `xmlrpc.php` deny left in place after Jetpack arrived, the nginx `^~` form and a root `.htaccess` above a core directory.
- The login limiter on a fake clock. Lockout after the limit even for a correct password, lockout expiry, a fixed counting window that starts at the first failure and its transient expiry, one shared counter per IPv6 /64.
- The uploads rule applied as a regex to sample file names (`shell.PHP` and `a.php7` match, `a.php.jpg` and `php.png` do not), and balanced `<IfModule>` and `<Files>` tags in every generated block.
- Every audit check against a temporary site tree, including `wp-config.php` one level above the root, and the two SQL checks against a recording `$wpdb` that asserts each query is a `SELECT` with a limit.
- The settings page parsed as HTML. Every input has a `<label for>`, and every `aria-describedby` points to an element that exists.
- The CLI. `apply` refuses to run without a selection, `--dry-run` saves nothing and prints the guards, an unknown id stops before any save, `audit` exits 1 on a failing check.
- `wp-hardening.php` loaded in a separate process the way WordPress loads it, with its own autoloader.

## Limits

- Not run against a live WordPress here. The tests stub WordPress functions, so a change in a core function's behavior (for example, how `rest_pre_dispatch` treats embedded requests) would not show up in them. The hooks used exist in WordPress 6.0 and later.
- PHPUnit ran on PHP 8.3 only. The code uses nothing newer than 8.1, and `composer.json` pins the platform to 8.1 so the lock resolves for it, but no 8.1 run was made.
- Core and plugin checksums (INT-01) need api.wordpress.org, which the audit does not contact; the check is reported as skipped. Where the site can reach wordpress.org, `wp core verify-checksums` and `wp plugin verify-checksums --all` cover it.
- Checks that need the hosting panel or the access log (backups, cron jobs on the server, FTP and SSH accounts, mail forwarders, brute-force bursts in the log) are outside WordPress and outside this plugin.
- Application-password logins over the REST API are not counted: WordPress checks them outside `wp_authenticate()`. Those passwords are 24 random characters, so guessing them is not the risk the limiter addresses.
- Headers set in the server configuration are invisible to PHP. Site Health looks for them in the root `.htaccess` only; if an nginx `add_header` or an Apache virtual host already sends them, leave the headers control off, or the response carries two copies.
- The login counter is a read and a write on a transient, not an atomic increment. Failures that land at the same moment can count as one, so a script that sends many attempts in parallel gets more than the limit before the lock starts. Sequential attempts are counted exactly.
- The address from a proxy header is trusted as configured. If the site is reachable both through the proxy and directly, a client that skips the proxy can set the header itself.
- User names still appear where WordPress prints them on purpose, in author archive slugs, oEmbed responses and comment classes. This control closes enumeration by id, not every place a slug is shown.
- `X-Content-Type-Options` sent from PHP does not reach files the web server serves directly; that is why the uploads block sets it at the server.
- `.htaccess` checks look for the generated block in the file, not at what the server does. A 403 for a `.php` file placed in `uploads/` on a staging copy is the real test.
- MIT, like the rest of the repository ([LICENSE](../LICENSE)), declared in `composer.json` and in the plugin header. MIT is compatible with the GPL, so the plugin can run next to GPL code in WordPress, and wordpress.org accepts GPL-compatible licenses.
