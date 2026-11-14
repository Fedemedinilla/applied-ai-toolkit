/** Finds and reads the config file. The only part of the config that touches the file system. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILE, ConfigError, validateConfig, type Config } from './config.ts';

export interface LoadedConfig {
  /** Absolute path of the file. */
  path: string;
  /** The folder the globs are relative to. */
  dir: string;
  config: Config;
}

/**
 * The nearest slop-lint.config.json, from `cwd` upward. The search stops after the folder that
 * holds .git (the repository root) and at the file system root, so a config file of another
 * project further up is never picked.
 */
export function findConfig(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Reads and validates a config file. Throws an Error whose message starts with the file's path. */
export function loadConfig(path: string): LoadedConfig {
  const full = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(full, 'utf8').replace(/^﻿/u, '');
  } catch (error) {
    throw new Error(`cannot read the config file ${path}: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path}: not valid JSON: ${(error as Error).message}`);
  }
  try {
    return { path: full, dir: dirname(full), config: validateConfig(value) };
  } catch (error) {
    if (error instanceof ConfigError) throw new Error(`${path}: ${error.message}`);
    throw error;
  }
}

/**
 * A file's path relative to the folder of the config file, with forward slashes, which is what
 * the globs match. Undefined for a file outside that folder: it matches no glob.
 */
export function configPath(dir: string, file: string, cwd: string): string | undefined {
  const rel = relative(dir, resolve(cwd, file));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}
