import * as functions from 'firebase-functions';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

/**
 * Shape accepted by non-error log methods. We intentionally keep the
 * permissive `Record<string, unknown>` type so callers can pass any
 * structured payload, while still rejecting primitives (strings,
 * numbers, bare arrays) at compile time.
 */
export type LogData = Record<string, unknown>;

/**
 * SEC-M4: keys that commonly hold PII or secret material. Any log payload
 * key matching this regex has its value redacted before it is forwarded to
 * the underlying logger. Matching is case-insensitive and done on the key
 * name only — nested objects are recursed, so `{user: {email: ...}}` still
 * redacts `email`.
 */
const PII_KEY_RE = /email|phone|card|token|secret|password|otp|ssn|aadhar/i;

/**
 * Return a deep-copied payload with PII keys redacted. Pure function —
 * never mutates the caller's object. Arrays are preserved as-is (we do not
 * descend into arrays, since positional values don't carry a PII key name).
 */
export function scrubPII(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (PII_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrubPII(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  /**
   * Coerce an untyped payload (historically `any`) into a spread-safe
   * `LogData` shape. Primitives become `{ error: String(value) }`;
   * Errors are normalised to name/message/stack. Objects pass through
   * untouched. `undefined` → `undefined` so we can skip the spread.
   */
  private coerceData(data: Error | LogData | unknown): LogData | undefined {
    if (data === undefined || data === null) return undefined;
    if (data instanceof Error) {
      return { name: data.name, message: data.message, stack: data.stack };
    }
    if (typeof data === 'object') return data as LogData;
    return { value: String(data) };
  }

  private log(level: LogLevel, message: string, data?: Error | LogData | unknown): void {
    const coerced = this.coerceData(data);
    // SEC-M4: scrub PII keys (email, phone, token, secret, etc.) before we
    // forward the payload to the underlying structured logger. We scrub at
    // the entry point so every call-site (info/warn/error) benefits without
    // needing to remember to redact.
    const scrubbed = scrubPII(coerced);
    const logEntry = {
      level,
      context: this.context,
      message,
      timestamp: new Date().toISOString(),
      ...(scrubbed ?? {}),
    };

    switch (level) {
      case LogLevel.DEBUG:
        functions.logger.debug(logEntry);
        break;
      case LogLevel.INFO:
        functions.logger.info(logEntry);
        break;
      case LogLevel.WARN:
        functions.logger.warn(logEntry);
        break;
      case LogLevel.ERROR:
        functions.logger.error(logEntry);
        break;
    }
  }

  debug(message: string, data?: LogData | unknown): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: LogData | unknown): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: LogData | unknown): void {
    this.log(LogLevel.WARN, message, data);
  }

  /**
   * Error logging accepts either a native `Error` (in which case we extract
   * name/message/stack) or a structured record. Continues to accept
   * `unknown` so it can be called directly inside `catch (err) { ... }`
   * blocks without an instanceof narrowing.
   */
  error(message: string, error?: Error | LogData | unknown): void {
    this.log(LogLevel.ERROR, message, error);
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}
