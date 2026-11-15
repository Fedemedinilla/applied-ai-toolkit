/**
 * Checks for the values a gateway is built with. They run when the gateway or the client is
 * created, so a bad deploy fails at startup instead of on the first call.
 */
import { SetupError } from './errors.ts';

export function requireSecret(value: string, name: string): string {
  if (value.trim() === '') throw new SetupError(`Missing ${name}`);
  return value;
}

/** Timeouts and limits are whole milliseconds or counts: zero, negative or fractional values fail. */
export function requirePositiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SetupError(`${name} must be a positive integer (got ${value})`);
  }
  return value;
}

/** The longest delay setTimeout holds. Node fires anything longer after 1 ms. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** A timeout in whole milliseconds, from 1 to MAX_TIMEOUT_MS. */
export function requireTimeoutMs(value: number, name: string): number {
  requirePositiveInt(value, name);
  if (value > MAX_TIMEOUT_MS) throw new SetupError(`${name} must be at most ${MAX_TIMEOUT_MS} ms, the setTimeout limit (got ${value})`);
  return value;
}

/** An IANA zone that Intl knows. */
export function requireTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch (error) {
    throw new SetupError(`Unknown time zone: ${zone}`, { cause: error });
  }
  return zone;
}
