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
 *   Cleanup exists in two flavors: synchronous (startup path, before the stdio
 *   transport serves requests — blocking is acceptable there) and async
 *   (periodic reaper — must never block the event loop, or in-flight MCP tool
 *   calls freeze while lsof/ps/curl run).
 *
 * Data flow:
 *   Server binds port → writes /tmp/figma-console-mcp-{port}.json
 *   Server heartbeat → refreshes lastSeen every 30s
 *   Plugin scans ports 9223-9232 → connects to first responding server
 *   External tools read port files for discovery
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, devNull } from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { createChildLogger } from './logger.js';

const execFileAsync = promisify(execFile);

const logger = createChildLogger({ component: 'port-discovery' });

/** Default preferred WebSocket port */
export const DEFAULT_WS_PORT = 9223;

/** Number of ports in the fallback range (9223-9232 = 10 ports) */
export const PORT_RANGE_SIZE = 10;

/** Prefix for port advertisement files in /tmp */
const PORT_FILE_PREFIX = 'figma-console-mcp-';

/** Directory for port advertisement files.
 * Use /tmp on macOS/Linux so the Figma plugin (which hardcodes /tmp) can
 * discover port files even when os.tmpdir() returns /var/folders/... on macOS.
 */
const PORT_FILE_DIR = process.platform === 'win32' ? tmpdir() : '/tmp';

/** Maximum age before a port file without heartbeat is considered stale (4 hours) */
export const MAX_PORT_FILE_AGE_MS = 4 * 60 * 60 * 1000;

/** Maximum time since last heartbeat before a process is considered stale (5 minutes) */
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/** Grace period after SIGTERM before escalating to SIGKILL (ms) */
export const TERMINATE_GRACE_MS = 400;

/**
 * Minimum process age before an orphan may be reaped (ms). Protects a sibling
 * server that is mid-startup — it has bound a port but not yet written its
 * advertisement file, so it would otherwise look like an orphan. By the time a
 * real server is this old it has advertised and is in the known-PID set.
 */
export const ORPHAN_MIN_AGE_MS = 60 * 1000;

/** Interval for the periodic background reaper (ms) */
export const REAP_INTERVAL_MS = 5 * 60 * 1000;

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
 * Extra staleness margin required before a live-but-stale instance becomes
 * kill-eligible: it must have missed at least 2 further heartbeats PAST the
 * stale threshold. After a laptop sleeps, every instance's lastSeen is old
 * simultaneously — this margin gives freshly-woken siblings time to refresh
 * their advertisement files before any reaper considers killing them.
 */
export const KILL_ELIGIBLE_EXTRA_STALE_MS = 2 * HEARTBEAT_INTERVAL_MS;

/**
 * Whether a stale instance has been stale long enough to be kill-eligible.
 * Pre-v1.12 files (no lastSeen) already use the conservative 4-hour age
 * ceiling, so plain staleness is sufficient there.
 */
function isKillEligible(data: PortFileData): boolean {
  if (!data.lastSeen) return isStaleInstance(data);
  const lastSeenAge = Date.now() - new Date(data.lastSeen).getTime();
  return lastSeenAge > HEARTBEAT_STALE_MS + KILL_ELIGIBLE_EXTRA_STALE_MS;
}

/**
 * Ports reaching the probes come from JSON port files in a world-writable
 * temp dir, so treat them as untrusted input. A garbage port means a garbage
 * file — verdict is inconclusive (do NOT kill), same as any other ambiguity.
 */
function isValidProbePort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535;
}

/** curl arguments for the /health liveness probe against a sibling's port.
 * `devNull` (not a literal /dev/null) — Windows ships curl.exe, and a bad
 * output path there makes curl exit non-zero, which reads as "nothing
 * responding" and would let the reaper kill a healthy sibling. */
function healthProbeArgs(port: number): string[] {
  return ['-s', '-o', devNull, '-m', '1', `http://127.0.0.1:${port}/health`];
}

/**
 * Liveness probe against a sibling server's HTTP `/health` endpoint (the
 * WebSocket server serves it on the same port). Synchronous via curl —
 * startup-path only; the periodic reaper uses probeServerHealthAsync.
 * execFileSync (no shell) so the untrusted port can never be interpreted
 * as shell syntax.
 *
 * @returns true  — server responded (alive, do NOT kill)
 *          false — probe ran and failed (nothing responding on the port)
 *          null  — inconclusive (curl missing / probe ambiguous — do NOT kill)
 */
function probeServerHealth(port: number): boolean | null {
  if (!isValidProbePort(port)) return null;
  try {
    execFileSync('curl', healthProbeArgs(port), {
      timeout: 3000,
      stdio: 'ignore',
    });
    return true;
  } catch (error: any) {
    // curl binary not found (no shell, so ENOENT instead of exit 127/9009) — inconclusive
    if (error?.code === 'ENOENT') return null;
    // execFileSync-level timeout (killed by signal, no exit status) — inconclusive
    if (error?.signal) return null;
    // curl ran and exited non-zero (connection refused, curl -m timeout, …)
    if (typeof error?.status === 'number') return false;
    return null; // unknown failure — err on the side of NOT killing
  }
}

/**
 * Async variant of probeServerHealth for the periodic reaper — identical
 * verdict semantics, but never blocks the event loop (execFile, no shell).
 */
async function probeServerHealthAsync(port: number): Promise<boolean | null> {
  if (!isValidProbePort(port)) return null;
  try {
    await execFileAsync('curl', healthProbeArgs(port), { timeout: 3000 });
    return true;
  } catch (error: any) {
    // curl binary not found (no shell, so ENOENT instead of exit 127) — inconclusive
    if (error?.code === 'ENOENT') return null;
    // execFile-level timeout (process killed by signal) — inconclusive
    if (error?.killed || error?.signal) return null;
    // curl ran and exited non-zero (connection refused, curl -m timeout, …)
    if (typeof error?.code === 'number') return false;
    return null; // unknown failure — err on the side of NOT killing
  }
}

/**
 * Block the current thread for `ms` milliseconds (synchronous).
 * Used between SIGTERM and SIGKILL so terminateProcess can stay synchronous
 * (its callers — the startup-path cleanup functions — are synchronous).
 */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  try {
    // Cross-platform, no child process. SharedArrayBuffer/Atomics are standard in Node 18+.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* best-effort spin fallback */ }
  }
}

/**
 * Non-blocking sleep for the async reaper path. The timer is unref'd so an
 * in-flight reaper wait never keeps the process alive on its own.
 */
function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Parse `ps -o etime=` output into milliseconds.
 * `etime` (formatted elapsed time) is portable across macOS and Linux;
 * `etimes` (seconds) is Linux-only — macOS ps rejects it. Format is
 * [[DD-]HH:]MM:SS, e.g. "05:51", "55:27", "01:13:31", "09-14:15:41".
 */
function parseEtimeMs(out: string): number | null {
  const m = out.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = parseInt(m[1] || '0', 10);
  const hours = parseInt(m[2] || '0', 10);
  const mins = parseInt(m[3], 10);
  const secs = parseInt(m[4], 10);
  return ((((days * 24 + hours) * 60 + mins) * 60) + secs) * 1000;
}

/**
 * Elapsed time since a process started, in milliseconds. Returns null if it
 * cannot be determined (process gone, or `ps` unavailable/unparseable).
 */
function getProcessAgeMs(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const { execSync } = require('child_process');
    const out = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 2000,
    });
    return parseEtimeMs(out);
  } catch {
    return null;
  }
}

/** Async variant of getProcessAgeMs for the periodic reaper. */
async function getProcessAgeMsAsync(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'etime='], {
      timeout: 2000,
    });
    return parseEtimeMs(stdout);
  } catch {
    return null;
  }
}

/**
 * Terminate a process by PID, escalating to SIGKILL if it ignores SIGTERM.
 *
 * A hung MCP server can catch SIGTERM (its shutdown handler runs) yet never
 * reach process.exit() — e.g. when graceful WebSocket/HTTP close blocks on a
 * lingering connection. SIGTERM alone then leaves a zombie holding its port
 * (often with its advertisement file already removed by the handler). We send
 * SIGTERM, wait briefly, and force-kill with SIGKILL if it is still alive.
 *
 * @returns true if the process is confirmed gone afterwards, false if it survived.
 */
function terminateProcess(pid: number, graceMs: number = TERMINATE_GRACE_MS): boolean {
  // SIGTERM first — give the process a chance to shut down gracefully.
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true; // already gone — nothing to terminate
  }

  // Windows: SIGTERM maps to TerminateProcess (immediate, uncatchable).
  if (process.platform === 'win32') return !isProcessAlive(pid);

  // POSIX: let the graceful handler run, then force-kill if it ignored SIGTERM.
  sleepSyncMs(graceMs);
  if (!isProcessAlive(pid)) return true;

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return true; // exited between the check and the kill
  }
  sleepSyncMs(Math.min(graceMs, 200));
  return !isProcessAlive(pid);
}

/**
 * Async variant of terminateProcess for the periodic reaper — identical
 * SIGTERM→SIGKILL escalation, but the grace waits yield the event loop
 * instead of blocking it.
 *
 * @returns true if the process is confirmed gone afterwards, false if it survived.
 */
async function terminateProcessAsync(pid: number, graceMs: number = TERMINATE_GRACE_MS): Promise<boolean> {
  // SIGTERM first — give the process a chance to shut down gracefully.
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true; // already gone — nothing to terminate
  }

  // Windows: SIGTERM maps to TerminateProcess (immediate, uncatchable).
  if (process.platform === 'win32') return !isProcessAlive(pid);

  // POSIX: let the graceful handler run, then force-kill if it ignored SIGTERM.
  await sleepMs(graceMs);
  if (!isProcessAlive(pid)) return true;

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return true; // exited between the check and the kill
  }
  await sleepMs(Math.min(graceMs, 200));
  return !isProcessAlive(pid);
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
            // Live PID but stale heartbeat. Staleness alone is NOT proof of
            // death — after the machine sleeps longer than HEARTBEAT_STALE_MS,
            // ALL instances look stale at once and whichever reaper ticks first
            // would kill healthy siblings. Verify actual deadness before
            // terminating: extra staleness margin + failed liveness probe.
            if (!isKillEligible(data)) {
              logger.debug(
                { port: data.port, pid: data.pid, lastSeen: data.lastSeen },
                'Stale instance within kill-eligibility margin — skipping',
              );
            } else {
              const health = probeServerHealth(data.port);
              if (health !== false) {
                logger.debug(
                  { port: data.port, pid: data.pid, probe: health === true ? 'responding' : 'inconclusive' },
                  'Stale-looking instance not confirmed dead by liveness probe — skipping kill',
                );
              } else {
                logger.info(
                  { port: data.port, pid: data.pid, startedAt: data.startedAt, lastSeen: data.lastSeen },
                  'Detected zombie MCP process (stale heartbeat, health probe failed) — sending SIGTERM to free port',
                );
                terminateProcess(data.pid);
                try { unlinkSync(filePath); } catch { /* best-effort */ }
                cleaned++;
              }
            }
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
 * Async variant of cleanupStalePortFiles for the periodic reaper.
 *
 * Same detection layers and kill-safety gates as the sync version (dead PID →
 * delete file; live-but-stale → kill-eligibility margin + failed liveness
 * probe before terminating; corrupt → delete file), but the probe and the
 * SIGTERM→SIGKILL grace waits are non-blocking so a slow pass never stalls
 * the stdio MCP transport.
 */
export async function cleanupStalePortFilesAsync(): Promise<number> {
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
            // Live PID but stale heartbeat. Staleness alone is NOT proof of
            // death — after the machine sleeps longer than HEARTBEAT_STALE_MS,
            // ALL instances look stale at once and whichever reaper ticks first
            // would kill healthy siblings. Verify actual deadness before
            // terminating: extra staleness margin + failed liveness probe.
            if (!isKillEligible(data)) {
              logger.debug(
                { port: data.port, pid: data.pid, lastSeen: data.lastSeen },
                'Stale instance within kill-eligibility margin — skipping',
              );
            } else {
              const health = await probeServerHealthAsync(data.port);
              if (health !== false) {
                logger.debug(
                  { port: data.port, pid: data.pid, probe: health === true ? 'responding' : 'inconclusive' },
                  'Stale-looking instance not confirmed dead by liveness probe — skipping kill',
                );
              } else {
                logger.info(
                  { port: data.port, pid: data.pid, startedAt: data.startedAt, lastSeen: data.lastSeen },
                  'Detected zombie MCP process (stale heartbeat, health probe failed) — sending SIGTERM to free port',
                );
                await terminateProcessAsync(data.pid);
                try { unlinkSync(filePath); } catch { /* best-effort */ }
                cleaned++;
              }
            }
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
export function cleanupOrphanedProcesses(
  preferredPort: number = DEFAULT_WS_PORT,
  options: { minAgeMs?: number } = {},
): number {
  // Only supported on macOS/Linux (lsof)
  if (process.platform === 'win32') return 0;

  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
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

          if (isMcpServerCommand(cmdline)) {
            // Don't reap a sibling that is still starting up (bound a port but
            // hasn't advertised yet). Real orphans are far older than this.
            const ageMs = getProcessAgeMs(pid);
            if (minAgeMs > 0 && ageMs !== null && ageMs < minAgeMs) {
              continue;
            }

            logger.info(
              { port, pid, command: cmdline.substring(0, 120) },
              'Terminating orphaned MCP server (no port file, holding port)',
            );
            // terminateProcess escalates SIGTERM -> SIGKILL. Only count it as
            // cleaned when the process is confirmed gone, so the log reflects
            // reality (the old code counted attempts and reported success even
            // when a SIGTERM-ignoring zombie survived).
            if (terminateProcess(pid)) {
              cleaned++;
            } else {
              logger.warn({ port, pid }, 'Failed to terminate orphaned MCP server (survived SIGKILL)');
            }
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

/** Whether a process command line identifies a figma-console-mcp server. */
function isMcpServerCommand(cmdline: string): boolean {
  return cmdline.includes('figma-console-mcp') || cmdline.includes('figma_console_mcp') || cmdline.includes('local.js');
}

/**
 * List PIDs listening on ports in the range via a single batched lsof call.
 * Returns a map of pid → first listening port seen (for logging). The sync
 * startup path runs lsof once per port; batching matters here because the
 * periodic reaper must not hold the event loop across 10 sequential calls.
 */
async function listListeningPidsAsync(ports: number[]): Promise<Map<number, number>> {
  const pidToPort = new Map<number, number>();
  const low = ports[0];
  const high = ports[ports.length - 1];

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${low}-${high}`, '-sTCP:LISTEN', '-Fpn'],
      { timeout: 5000 },
    ));
  } catch (error: any) {
    // lsof exits 1 when nothing matches; any partial output is still usable
    stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  }

  // -F output: `p<pid>` starts a process group, `n<host:port>` lines follow
  let currentPid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(pid) ? pid : null;
    } else if (line.startsWith('n') && currentPid !== null) {
      const m = line.match(/:(\d+)(?:\s|$)/);
      if (!m) continue;
      const port = parseInt(m[1], 10);
      if (ports.includes(port) && !pidToPort.has(currentPid)) {
        pidToPort.set(currentPid, port);
      }
    }
  }

  return pidToPort;
}

/**
 * Async variant of cleanupOrphanedProcesses for the periodic reaper.
 *
 * Same safety guards as the sync version (known-PID skip, MCP command-line
 * check, ORPHAN_MIN_AGE_MS age guard, confirmed-kill counting), but all child
 * processes run via async execFile and the lsof scan is a single batched call
 * over the port range — a slow tick no longer freezes in-flight tool calls on
 * the stdio transport.
 */
export async function cleanupOrphanedProcessesAsync(
  preferredPort: number = DEFAULT_WS_PORT,
  options: { minAgeMs?: number } = {},
): Promise<number> {
  // Only supported on macOS/Linux (lsof)
  if (process.platform === 'win32') return 0;

  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
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

  const pidToPort = await listListeningPidsAsync(ports);

  for (const [pid, port] of pidToPort) {
    if (knownPids.has(pid)) continue; // Skip known-good servers

    // Verify this is actually a figma-console-mcp process before killing
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
        timeout: 2000,
      });
      const cmdline = stdout.trim();

      if (isMcpServerCommand(cmdline)) {
        // Don't reap a sibling that is still starting up (bound a port but
        // hasn't advertised yet). Real orphans are far older than this.
        const ageMs = await getProcessAgeMsAsync(pid);
        if (minAgeMs > 0 && ageMs !== null && ageMs < minAgeMs) {
          continue;
        }

        logger.info(
          { port, pid, command: cmdline.substring(0, 120) },
          'Terminating orphaned MCP server (no port file, holding port)',
        );
        // Only count confirmed kills, matching the sync path.
        if (await terminateProcessAsync(pid)) {
          cleaned++;
        } else {
          logger.warn({ port, pid }, 'Failed to terminate orphaned MCP server (survived SIGKILL)');
        }
      }
    } catch {
      // Can't read process info — skip to be safe
    }
  }

  if (cleaned > 0) {
    // Give terminated processes a moment to release their ports
    await sleepMs(500);
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

  // Prepend our cleanup — it runs first before the existing SIGINT/SIGTERM
  // handlers in local.ts main() call process.exit()
  process.prependListener('SIGINT', cleanup);
  process.prependListener('SIGTERM', cleanup);
}

/**
 * Start a periodic background reaper that re-runs the cleanup passes while this
 * server is alive. Startup-only reaping leaves orphans to accumulate between
 * launches (a sibling client that closes without its server exiting cleanly
 * keeps holding a port until the *next* server starts). Periodic reaping keeps
 * the range clean continuously.
 *
 * Safe against live siblings: they hold fresh advertisement files (heartbeat
 * every 30s) so they are in the known-PID set and skipped, and the age guard in
 * cleanupOrphanedProcesses protects mid-startup siblings.
 *
 * The tick runs the fully-async cleanup variants — the sync ones issue
 * blocking lsof/ps/curl calls (seconds each under load), which would stall
 * the stdio MCP transport and freeze in-flight tool calls. Only the startup
 * path (before the transport is serving requests) uses the sync variants.
 *
 * The interval is unref'd so it never keeps the process alive on its own.
 *
 * @returns a stop function that clears the interval.
 */
export function startPeriodicReaper(preferredPort: number = DEFAULT_WS_PORT): () => void {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running) return; // previous tick still in flight — skip this one
    running = true;
    try {
      // Refresh our OWN advertisement first so sibling reapers see us fresh.
      // Post-sleep, every instance's lastSeen is stale simultaneously — the
      // first reaper to tick must not look like a zombie to the others.
      // refreshPortAdvertisement is a no-op for files owned by other PIDs,
      // so scanning the whole range only touches our own file.
      for (const port of getPortRange(preferredPort)) {
        refreshPortAdvertisement(port);
      }
      await cleanupStalePortFilesAsync();
      if (stopped) return;
      await cleanupOrphanedProcessesAsync(preferredPort);
    } catch (error) {
      logger.warn({ error }, 'Periodic reaper tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => { void tick(); }, REAP_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
