// Minimal console-based logger with no external dependencies.
// Provides a consistent, timestamped, level-prefixed log format that the rest
// of the API can rely on. Replace or extend with a structured logger later if
// the project grows.

type LogArgs = readonly unknown[];

/** Build a uniform log line prefix: ISO timestamp + level tag. */
function prefix(level: string): string {
  return `${new Date().toISOString()} [${level}]`;
}

export const logger = {
  /** Informational messages about normal operation. */
  info(message: string, ...args: LogArgs): void {
    console.log(prefix('INFO'), message, ...args);
  },
  /** Recoverable problems or noteworthy conditions. */
  warn(message: string, ...args: LogArgs): void {
    console.warn(prefix('WARN'), message, ...args);
  },
  /** Errors and failures that need attention. */
  error(message: string, ...args: LogArgs): void {
    console.error(prefix('ERROR'), message, ...args);
  },
};

export type Logger = typeof logger;
