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

/** An IANA zone that Intl knows. */
export function requireTimeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch (error) {
    throw new SetupError(`Unknown time zone: ${zone}`, { cause: error });
  }
  return zone;
}
