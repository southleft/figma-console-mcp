/**
 * Port Discovery Module
 *
 * Handles dynamic WebSocket port assignment with range-based fallback.
 * When the preferred port (default 9223) is taken by another MCP server instance
 * (e.g., Claude Desktop Chat tab vs Code tab), the server automatically tries
 * the next port in a fixed range (9223-9232).
 *
 * Port advertisement files are written to /tmp so the Figma plugin can discover
 * which port to connect to. Each instance writes its own file with PID for
 * stale-file detection.
 *
 * Data flow:
 *   Server binds port → writes /tmp/figma-console-mcp-{port}.json
 *   Plugin scans ports 9223-9232 → connects to first responding server
 *   External tools read port files for discovery
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'port-discovery' });

/** Default preferred WebSocket port */
export const DEFAULT_WS_PORT = 9223;

/** Number of ports in the fallback range (9223-9232 = 10 ports) */
export const PORT_RANGE_SIZE = 10;

/** Prefix for port advertisement files in /tmp */
const PORT_FILE_PREFIX = 'figma-console-mcp-';

/** Directory for port advertisement files */
const PORT_FILE_DIR = tmpdir();

export interface PortFileData {
  port: number;
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * Try to bind a WebSocket server to ports in a range, starting from the preferred port.
 * Returns the first port that binds successfully.
 *
 * @param preferredPort - The port to try first (default 9223)
 * @param host - The host to bind to (default 'localhost')
 * @returns The actual port that was bound
 * @throws If all ports in the range are exhausted
 */
export function getPortRange(preferredPort: number = DEFAULT_WS_PORT): number[] {
  const ports: number[] = [];
  for (let i = 0; i < PORT_RANGE_SIZE; i++) {
    ports.push(preferredPort + i);
  }
  return ports;
}

/**
 * Get the file path for a port advertisement file.
 */
export function getPortFilePath(port: number): string {
  return join(PORT_FILE_DIR, `${PORT_FILE_PREFIX}${port}.json`);
}

/**
 * Write a port advertisement file so clients can discover this server instance.
 * Includes PID for stale-file detection.
 */
export function advertisePort(port: number, host: string = 'localhost'): void {
  const data: PortFileData = {
    port,
    pid: process.pid,
    host,
    startedAt: new Date().toISOString(),
  };

  const filePath = getPortFilePath(port);
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    logger.info({ port, filePath }, 'Port advertised');
  } catch (error) {
    logger.warn({ port, filePath, error }, 'Failed to write port advertisement file');
  }
}

/**
 * Remove the port advertisement file for this instance.
 * Call on clean shutdown.
 */
export function unadvertisePort(port: number): void {
  const filePath = getPortFilePath(port);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      logger.debug({ port, filePath }, 'Port advertisement removed');
    }
  } catch {
    // Best-effort cleanup — file may already be gone
  }
}

/**
 * Check if a PID is still alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate a port advertisement file.
 * Returns null if the file doesn't exist, is invalid, or the owning process is dead.
 */
export function readPortFile(port: number): PortFileData | null {
  const filePath = getPortFilePath(port);

  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data: PortFileData = JSON.parse(raw);

    // Validate the owning process is still alive
    if (!isProcessAlive(data.pid)) {
      logger.debug({ port, pid: data.pid }, 'Stale port file detected (process dead), cleaning up');
      try { unlinkSync(filePath); } catch { /* best-effort */ }
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Discover all active Figma Console MCP server instances by scanning port files.
 * Validates each file's PID to filter out stale entries.
 */
export function discoverActiveInstances(preferredPort: number = DEFAULT_WS_PORT): PortFileData[] {
  const instances: PortFileData[] = [];

  for (const port of getPortRange(preferredPort)) {
    const data = readPortFile(port);
    if (data) {
      instances.push(data);
    }
  }

  return instances;
}

/**
 * Clean up all stale port files (dead PIDs).
 * Useful for maintenance and debugging.
 */
export function cleanupStalePortFiles(): number {
  let cleaned = 0;

  try {
    const files = readdirSync(PORT_FILE_DIR);
    for (const file of files) {
      if (file.startsWith(PORT_FILE_PREFIX) && file.endsWith('.json')) {
        const filePath = join(PORT_FILE_DIR, file);
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const data: PortFileData = JSON.parse(raw);
          if (!isProcessAlive(data.pid)) {
            unlinkSync(filePath);
            cleaned++;
            logger.debug({ port: data.port, pid: data.pid }, 'Cleaned up stale port file');
          }
        } catch {
          // Corrupt file — remove it
          try { unlinkSync(filePath); cleaned++; } catch { /* ignore */ }
        }
      }
    }
  } catch {
    // Can't read /tmp — unusual but not fatal
  }

  return cleaned;
}

/**
 * Register process exit handlers to clean up port advertisement file.
 * Should be called once after the port is successfully bound.
 */
export function registerPortCleanup(port: number): void {
  const cleanup = () => unadvertisePort(port);

  process.on('exit', cleanup);

  // Re-register SIGINT/SIGTERM to ensure cleanup runs before the
  // existing handlers in local.ts main() call process.exit()
  const originalSigintListeners = process.listeners('SIGINT');
  const originalSigtermListeners = process.listeners('SIGTERM');

  // Prepend our cleanup — it runs first, then existing handlers take over
  process.prependListener('SIGINT', cleanup);
  process.prependListener('SIGTERM', cleanup);
}
