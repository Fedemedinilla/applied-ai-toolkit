<?php

declare(strict_types=1);

namespace WpHardening\Tests;

/** Thrown by BufferOutput where WP-CLI would exit. The code is the exit code. */
final class CliStop extends \RuntimeException
{
}
