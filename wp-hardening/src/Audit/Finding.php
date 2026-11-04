<?php

declare(strict_types=1);

namespace WpHardening\Audit;

final class Finding
{
    /** @param list<string> $evidence Short items (file names, option names, counts), never file contents. */
    public function __construct(
        public readonly string $id,
        public readonly string $title,
        public readonly Verdict $verdict,
        public readonly string $detail,
        public readonly array $evidence = [],
    ) {
    }

    /** @return array{id: string, title: string, verdict: string, detail: string, evidence: list<string>} */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'title' => $this->title,
            'verdict' => $this->verdict->value,
            'detail' => $this->detail,
            'evidence' => $this->evidence,
        ];
    }
}
