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
 * Zombie process detection:
 *   Active servers refresh their port file every 30s (heartbeat).
 *   On startup, cleanupStalePortFiles() detects zombies via:
 *     1. Dead PID — process no longer exists (existing behavior)
 *     2. Stale heartbeat — lastSeen older than 5 minutes (process frozen/hung)
 *     3. Age ceiling — startedAt older than 4 hours with no heartbeat (pre-v1.12 compat)
 *   Zombie processes are terminated with SIGTERM to free their ports.
 *
 * Data flow:
 *   Server binds port → writes /tmp/figma-console-mcp-{port}.json
 *   Server heartbeat → refreshes lastSeen every 30s
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

/** Maximum age before a port file without heartbeat is considered stale (4 hours) */
export const MAX_PORT_FILE_AGE_MS = 4 * 60 * 60 * 1000;

/** Maximum time since last heartbeat before a process is considered stale (5 minutes) */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/** Minimum age before an instance can be evicted as last resort (2 minutes) */
export const EVICTION_MIN_AGE_MS = 2 * 60 * 1000;

/** Interval between heartbeat refreshes (30 seconds) */
export const HEARTBEAT_INTERVAL_MS = 30 * 1000;

export interface PortFileData {
  port: number;
  pid: number;
  host: string;
  startedAt: string;
  /** Updated by heartbeat every 30s. Missing in port files from pre-v1.12 instances. */
  lastSeen?: string;
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
 * Includes PID for stale-file detection and lastSeen for heartbeat tracking.
 */
export function advertisePort(port: number, host: string = 'localhost'): void {
  const now = new Date().toISOString();
  const data: PortFileData = {
    port,
    pid: process.pid,
    host,
    startedAt: now,
    lastSeen: now,
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
 * Refresh the lastSeen timestamp in a port advertisement file.
 * Called periodically as a heartbeat to prove this server is still active.
 * Non-fatal — heartbeat failures are silently ignored.
 */
export function refreshPortAdvertisement(port: number): void {
  const filePath = getPortFilePath(port);
  try {
    if (!existsSync(filePath)) return;
    const raw = readFileSync(filePath, 'utf-8');
    const data: PortFileData = JSON.parse(raw);
    // Only refresh our own port file
    if (data.pid !== process.pid) return;
    data.lastSeen = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — heartbeat failures are non-fatal
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
 * Determine if a port file represents a zombie/stale MCP instance.
 *
 * Detection layers:
 *   1. If lastSeen exists (v1.12+): stale if older than HEARTBEAT_STALE_MS (5 min)
 *   2. If lastSeen is missing (pre-v1.12): stale if startedAt older than MAX_PORT_FILE_AGE_MS (4h)
 *
 * Assumes the owning process IS alive (PID check should happen before calling this).
 */
export function isStaleInstance(data: PortFileData): boolean {
  const now = Date.now();

  // If heartbeat exists, use it — active servers refresh every 30s
  if (data.lastSeen) {
    const lastSeenAge = now - new Date(data.lastSeen).getTime();
    return lastSeenAge > HEARTBEAT_STALE_MS;
  }

  // No heartbeat (pre-v1.12 instance) — fall back to startup age
  const startedAge = now - new Date(data.startedAt).getTime();
  return startedAge > MAX_PORT_FILE_AGE_MS;
}

/**
 * Attempt to terminate a process by PID.
 * Uses SIGTERM for graceful shutdown. On Windows, this calls TerminateProcess
 * which is immediate and cannot be caught.
 *
 * @returns true if the signal was sent successfully, false if the process was already gone
 */
function terminateProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false; // Process may have already exited
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
 * Clean up stale port files and terminate zombie MCP processes.
 *
 * Runs at startup before port binding. Detects stale instances via:
 *   1. Dead PID — process no longer exists → delete file
 *   2. Zombie process — alive but stale (no heartbeat or expired heartbeat)
 *      → send SIGTERM to free the port, then delete file
 *   3. Corrupt file — invalid JSON → delete file
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
            // Dead PID — just clean up the file
            unlinkSync(filePath);
            cleaned++;
            logger.debug({ port: data.port, pid: data.pid }, 'Cleaned up stale port file (dead process)');
          } else if (data.pid !== process.pid && isStaleInstance(data)) {
            // Live PID but stale — zombie process, terminate it to free the port
            logger.info(
              { port: data.port, pid: data.pid, startedAt: data.startedAt, lastSeen: data.lastSeen },
              'Detected zombie MCP process — sending SIGTERM to free port',
            );
            terminateProcess(data.pid);
            try { unlinkSync(filePath); } catch { /* best-effort */ }
            cleaned++;
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
 * Deep scan for orphaned MCP server processes that hold ports but have no port files.
 * These are processes left behind by Claude Desktop when tabs close without proper cleanup.
 *
 * Uses lsof (macOS/Linux) to find PIDs listening on each port in the range,
 * then verifies they're figma-console-mcp before terminating.
 *
 * Call AFTER cleanupStalePortFiles() — that handles the port-file-based cleanup first,
 * then this catches any remaining ghosts.
 */
export function cleanupOrphanedProcesses(preferredPort: number = DEFAULT_WS_PORT): number {
  // Only supported on macOS/Linux (lsof)
  if (process.platform === 'win32') return 0;

  let cleaned = 0;
  const myPid = process.pid;
  const ports = getPortRange(preferredPort);

  // Collect PIDs that have valid port files (known-good servers)
  const knownPids = new Set<number>();
  for (const port of ports) {
    const data = readPortFile(port);
    if (data) knownPids.add(data.pid);
  }
  knownPids.add(myPid); // Never kill ourselves

  for (const port of ports) {
    try {
      // Find PIDs listening on this port via lsof
      const { execSync } = require('child_process');
      const output = execSync(`lsof -i :${port} -sTCP:LISTEN -t 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();

      if (!output) continue;

      const pids = output.split('\n').map(Number).filter(Boolean);

      for (const pid of pids) {
        if (knownPids.has(pid)) continue; // Skip known-good servers

        // Verify this is actually a figma-console-mcp process before killing
        try {
          const cmdline = execSync(`ps -p ${pid} -o command= 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 2000,
          }).trim();

          if (cmdline.includes('figma-console-mcp') || cmdline.includes('figma_console_mcp') || cmdline.includes('local.js')) {
            logger.info(
              { port, pid, command: cmdline.substring(0, 120) },
              'Terminating orphaned MCP server (no port file, holding port)',
            );
            terminateProcess(pid);
            cleaned++;
          }
        } catch {
          // Can't read process info — skip to be safe
        }
      }
    } catch {
      // lsof failed for this port — skip
    }
  }

  if (cleaned > 0) {
    // Give terminated processes a moment to release their ports
    try {
      const { execSync } = require('child_process');
      execSync('sleep 0.5', { timeout: 2000 });
    } catch { /* non-critical */ }
    logger.info({ cleaned }, `Cleaned up ${cleaned} orphaned MCP server process(es)`);
  }

  return cleaned;
}

/**
 * Last-resort eviction: terminate the oldest MCP server instance to free a port.
 *
 * Called ONLY when all ports in the range are exhausted after both cleanup phases
 * (cleanupStalePortFiles + cleanupOrphanedProcesses) have already run. This handles
 * the case where old instances are still alive and heartbeating but no longer needed
 * (e.g., from yesterday's Claude Desktop session that was closed without terminating
 * the MCP server process).
 *
 * Safety guards:
 *   - Only evicts instances older than EVICTION_MIN_AGE_MS (2 min) to prevent cascade
 *   - Never evicts our own PID
 *   - Re-reads port file before kill to avoid TOCTOU race
 *   - Uses SIGTERM for graceful shutdown
 *   - Waits briefly for port release before returning
 *
 * @returns true if an instance was evicted (caller should retry port binding), false otherwise
 */
export function evictOldestInstance(preferredPort: number = DEFAULT_WS_PORT): boolean {
  const myPid = process.pid;
  const ports = getPortRange(preferredPort);
  const candidates: (PortFileData & { filePath: string })[] = [];

  // Collect all valid port file entries that aren't us
  for (const port of ports) {
    const filePath = getPortFilePath(port);
    try {
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, 'utf-8');
      const data: PortFileData = JSON.parse(raw);
      if (data.pid === myPid) continue; // Never evict ourselves
      if (!isProcessAlive(data.pid)) {
        // Dead process — just clean up the file (port should already be free)
        try { unlinkSync(filePath); } catch { /* best-effort */ }
        continue;
      }
      candidates.push({ ...data, filePath });
    } catch {
      // Corrupt or unreadable — skip
    }
  }

  if (candidates.length === 0) {
    logger.debug('No eviction candidates — ports may be held by non-MCP processes');
    return false;
  }

  // Sort by startedAt ascending — oldest first
  candidates.sort((a, b) =>
    new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  const oldest = candidates[0];
  const ageMs = Date.now() - new Date(oldest.startedAt).getTime();

  // Safety: don't evict instances that started recently (prevents cascade)
  if (ageMs < EVICTION_MIN_AGE_MS) {
    logger.info(
      { port: oldest.port, pid: oldest.pid, ageSeconds: Math.round(ageMs / 1000) },
      'Oldest instance is too recent to evict — skipping',
    );
    return false;
  }

  // Re-read the port file to avoid TOCTOU race
  try {
    const raw = readFileSync(oldest.filePath, 'utf-8');
    const freshData: PortFileData = JSON.parse(raw);
    if (freshData.pid !== oldest.pid) {
      // PID changed between reads — another process took over, skip
      return false;
    }
  } catch {
    // File disappeared — port may already be free
    return true;
  }

  logger.info(
    { port: oldest.port, pid: oldest.pid, startedAt: oldest.startedAt, ageHours: Math.round(ageMs / 3600000 * 10) / 10 },
    'Evicting oldest MCP server instance to free port (all ports exhausted)',
  );

  terminateProcess(oldest.pid);
  try { unlinkSync(oldest.filePath); } catch { /* best-effort */ }

  // Brief wait for the port to be released by the OS
  try {
    const { execSync } = require('child_process');
    execSync('sleep 0.5', { timeout: 2000 });
  } catch { /* non-critical */ }

  return true;
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
