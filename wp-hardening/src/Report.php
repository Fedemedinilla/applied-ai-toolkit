<?php

declare(strict_types=1);

namespace WpHardening;

/** What a control reports about itself: to Site Health, to `wp harden status` and to the settings page. */
final class Report
{
    /**
     * @param string $summary One plain sentence, no markup.
     * @param list<string> $details Further sentences, no markup.
     */
    public function __construct(
        public readonly State $state,
        public readonly string $summary,
        public readonly array $details = [],
    ) {
    }
}
