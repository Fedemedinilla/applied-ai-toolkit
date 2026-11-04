<?php

declare(strict_types=1);

namespace WpHardening;

/** The three statuses Site Health knows. */
enum State: string
{
    case Good = 'good';
    case Recommended = 'recommended';
    case Critical = 'critical';
}
