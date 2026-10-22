/**
 * Logging infrastructure using pino
 */

import pino from 'pino';

/**
 * Log levels
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Create logger instance
 * Note: In Cloudflare Workers, console methods are automatically captured
 */
export function createLogger(level: LogLevel = 'info'): pino.Logger {
  // Check if running in Cloudflare Workers environment
  const isWorkers = typeof (globalThis as any).caches !== 'undefined';

  if (isWorkers) {
    // Cloudflare Workers: use simple console-based logging
    return pino({
      level: process.env.LOG_LEVEL || level,
      browser: {
        asObject: true,
      },
    });
  }

  // Node.js environment: detect MCP stdio mode
  // When stdout is not a TTY, we're likely in MCP stdio mode
  const isMCPStdio = !process.stdout.isTTY;

  // MCP stdio mode: NO pretty printing, stderr only.
  // Sync writes: with sync: false pino flushes leftover lines on exit, and once
  // the client is gone that flush retries EPIPE forever (sonic-boom 4.x), so the
  // process never exits. Sync mode has no exit flush and stops logging on EPIPE.
  if (isMCPStdio) {
    return pino(
      { level: process.env.LOG_LEVEL || level },
      pino.destination({ dest: 2, sync: true })
    );
  }

  // Development/terminal mode: use pretty printing
  return pino(
    {
      level: process.env.LOG_LEVEL || level,
      transport:
        process.env.NODE_ENV !== 'production'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss',
                ignore: 'pid,hostname',
                destination: 2, // Explicit stderr for transport
              },
            }
          : undefined,
    }
  );
}

/**
 * Default logger instance
 */
export const logger = createLogger();

/**
 * Create child logger with additional context
 */
export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
