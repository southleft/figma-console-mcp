/**
 * Tests for the port discovery module.
 * Covers: port range generation, port file lifecycle, PID validation,
 * stale file cleanup, and multi-instance discovery.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WebSocketServer as WSServer } from 'ws';
import {
  DEFAULT_WS_PORT,
  PORT_RANGE_SIZE,
  getPortRange,
  getPortFilePath,
  advertisePort,
  unadvertisePort,
  readPortFile,
  discoverActiveInstances,
  cleanupStalePortFiles,
} from '../src/core/port-discovery.js';
import { FigmaWebSocketServer } from '../src/core/websocket-server.js';

// Use high port numbers for tests to avoid conflicts with real instances
const TEST_PORT_BASE = 29223;

describe('Port Discovery Module', () => {
  // Clean up test port files after each test
  afterEach(() => {
    for (let i = 0; i < PORT_RANGE_SIZE + 5; i++) {
      const filePath = getPortFilePath(TEST_PORT_BASE + i);
      try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
    }
    // Also clean up default port files in case any test uses them
    for (let i = 0; i < PORT_RANGE_SIZE; i++) {
      const filePath = getPortFilePath(DEFAULT_WS_PORT + i);
      try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
    }
  });

  describe('getPortRange', () => {
    it('should return a range starting from the default port', () => {
      const range = getPortRange();
      expect(range).toHaveLength(PORT_RANGE_SIZE);
      expect(range[0]).toBe(DEFAULT_WS_PORT);
      expect(range[range.length - 1]).toBe(DEFAULT_WS_PORT + PORT_RANGE_SIZE - 1);
    });

    it('should return a range starting from a custom port', () => {
      const range = getPortRange(TEST_PORT_BASE);
      expect(range).toHaveLength(PORT_RANGE_SIZE);
      expect(range[0]).toBe(TEST_PORT_BASE);
      expect(range[range.length - 1]).toBe(TEST_PORT_BASE + PORT_RANGE_SIZE - 1);
    });

    it('should return exactly PORT_RANGE_SIZE ports', () => {
      const range = getPortRange(5000);
      expect(range).toHaveLength(PORT_RANGE_SIZE);
      expect(range).toEqual(expect.arrayContaining([5000, 5001, 5002]));
    });
  });

  describe('getPortFilePath', () => {
    it('should return a path in the temp directory', () => {
      const path = getPortFilePath(9223);
      expect(path).toContain(tmpdir());
      expect(path).toContain('figma-console-mcp-9223.json');
    });

    it('should include the port number in the filename', () => {
      const path = getPortFilePath(TEST_PORT_BASE);
      expect(path).toContain(`figma-console-mcp-${TEST_PORT_BASE}.json`);
    });
  });

  describe('advertisePort / readPortFile', () => {
    it('should write and read a port file with correct data', () => {
      advertisePort(TEST_PORT_BASE, 'localhost');

      const data = readPortFile(TEST_PORT_BASE);
      expect(data).not.toBeNull();
      expect(data!.port).toBe(TEST_PORT_BASE);
      expect(data!.pid).toBe(process.pid);
      expect(data!.host).toBe('localhost');
      expect(data!.startedAt).toBeTruthy();
    });

    it('should return null for non-existent port file', () => {
      const data = readPortFile(TEST_PORT_BASE + 99);
      expect(data).toBeNull();
    });

    it('should use localhost as default host', () => {
      advertisePort(TEST_PORT_BASE);

      const data = readPortFile(TEST_PORT_BASE);
      expect(data!.host).toBe('localhost');
    });

    it('should detect stale port files (dead PID)', () => {
      // Write a port file with a PID that definitely doesn't exist
      const filePath = getPortFilePath(TEST_PORT_BASE);
      writeFileSync(filePath, JSON.stringify({
        port: TEST_PORT_BASE,
        pid: 999999999, // Almost certainly not running
        host: 'localhost',
        startedAt: new Date().toISOString(),
      }));

      const data = readPortFile(TEST_PORT_BASE);
      expect(data).toBeNull();

      // File should have been cleaned up
      expect(existsSync(filePath)).toBe(false);
    });

    it('should handle corrupt port files gracefully', () => {
      const filePath = getPortFilePath(TEST_PORT_BASE);
      writeFileSync(filePath, 'not valid json!!!');

      const data = readPortFile(TEST_PORT_BASE);
      expect(data).toBeNull();
    });
  });

  describe('unadvertisePort', () => {
    it('should remove the port file', () => {
      advertisePort(TEST_PORT_BASE);
      expect(existsSync(getPortFilePath(TEST_PORT_BASE))).toBe(true);

      unadvertisePort(TEST_PORT_BASE);
      expect(existsSync(getPortFilePath(TEST_PORT_BASE))).toBe(false);
    });

    it('should not throw when file does not exist', () => {
      expect(() => unadvertisePort(TEST_PORT_BASE + 99)).not.toThrow();
    });
  });

  describe('discoverActiveInstances', () => {
    it('should find advertised ports with live PIDs', () => {
      advertisePort(TEST_PORT_BASE, 'localhost');
      advertisePort(TEST_PORT_BASE + 1, 'localhost');

      const instances = discoverActiveInstances(TEST_PORT_BASE);
      expect(instances).toHaveLength(2);
      expect(instances[0].port).toBe(TEST_PORT_BASE);
      expect(instances[1].port).toBe(TEST_PORT_BASE + 1);
    });

    it('should skip stale port files', () => {
      // Write one live and one stale
      advertisePort(TEST_PORT_BASE, 'localhost');

      const staleFilePath = getPortFilePath(TEST_PORT_BASE + 1);
      writeFileSync(staleFilePath, JSON.stringify({
        port: TEST_PORT_BASE + 1,
        pid: 999999999,
        host: 'localhost',
        startedAt: new Date().toISOString(),
      }));

      const instances = discoverActiveInstances(TEST_PORT_BASE);
      expect(instances).toHaveLength(1);
      expect(instances[0].port).toBe(TEST_PORT_BASE);
    });

    it('should return empty array when no instances are running', () => {
      const instances = discoverActiveInstances(TEST_PORT_BASE);
      expect(instances).toHaveLength(0);
    });
  });

  describe('cleanupStalePortFiles', () => {
    it('should clean up files with dead PIDs', () => {
      const filePath = getPortFilePath(TEST_PORT_BASE);
      writeFileSync(filePath, JSON.stringify({
        port: TEST_PORT_BASE,
        pid: 999999999,
        host: 'localhost',
        startedAt: new Date().toISOString(),
      }));

      const cleaned = cleanupStalePortFiles();
      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(existsSync(filePath)).toBe(false);
    });

    it('should not remove files with live PIDs', () => {
      advertisePort(TEST_PORT_BASE, 'localhost');

      const cleaned = cleanupStalePortFiles();
      // Our own port file should survive
      expect(existsSync(getPortFilePath(TEST_PORT_BASE))).toBe(true);
    });

    it('should clean up corrupt files', () => {
      const filePath = getPortFilePath(TEST_PORT_BASE);
      writeFileSync(filePath, 'corrupt data');

      const cleaned = cleanupStalePortFiles();
      expect(cleaned).toBeGreaterThanOrEqual(1);
      expect(existsSync(filePath)).toBe(false);
    });
  });
});

describe('FigmaWebSocketServer address()', () => {
  let server: FigmaWebSocketServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('should return null before server starts', () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT_BASE + 5 });
    expect(server.address()).toBeNull();
  });

  it('should return correct port after server starts', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT_BASE + 5, host: 'localhost' });
    await server.start();

    const addr = server.address();
    expect(addr).not.toBeNull();
    expect(addr!.port).toBe(TEST_PORT_BASE + 5);
  });

  it('should return OS-assigned port when using port 0', async () => {
    server = new FigmaWebSocketServer({ port: 0, host: 'localhost' });
    await server.start();

    const addr = server.address();
    expect(addr).not.toBeNull();
    expect(addr!.port).toBeGreaterThan(0);
    expect(addr!.port).not.toBe(0);
  });
});

describe('Port Range Fallback Integration', () => {
  const servers: FigmaWebSocketServer[] = [];

  afterEach(async () => {
    // Stop all servers in reverse order
    for (const s of servers.reverse()) {
      try { await s.stop(); } catch { /* ignore */ }
    }
    servers.length = 0;

    // Clean up port files
    for (let i = 0; i < PORT_RANGE_SIZE; i++) {
      try { unadvertisePort(TEST_PORT_BASE + i); } catch { /* ignore */ }
    }
  });

  it('should bind to preferred port when available', async () => {
    const server = new FigmaWebSocketServer({ port: TEST_PORT_BASE + 6, host: 'localhost' });
    await server.start();
    servers.push(server);

    const addr = server.address();
    expect(addr!.port).toBe(TEST_PORT_BASE + 6);
  });

  it('should fail with EADDRINUSE when port is taken', async () => {
    // First server takes the port
    const server1 = new FigmaWebSocketServer({ port: TEST_PORT_BASE + 7, host: 'localhost' });
    await server1.start();
    servers.push(server1);

    // Second server should fail
    const server2 = new FigmaWebSocketServer({ port: TEST_PORT_BASE + 7, host: 'localhost' });
    await expect(server2.start()).rejects.toThrow();
  });

  it('should allow multiple servers on different ports in the range', async () => {
    const ports = [TEST_PORT_BASE + 8, TEST_PORT_BASE + 9, TEST_PORT_BASE + 10];

    for (const port of ports) {
      const server = new FigmaWebSocketServer({ port, host: 'localhost' });
      await server.start();
      servers.push(server);

      const addr = server.address();
      expect(addr!.port).toBe(port);
    }

    expect(servers).toHaveLength(3);
  });

  it('should simulate the port range fallback pattern', async () => {
    // Simulate what local.ts does: try ports in range until one works
    const preferredPort = TEST_PORT_BASE + 11;

    // Block the first two ports
    const blocker1 = new FigmaWebSocketServer({ port: preferredPort, host: 'localhost' });
    await blocker1.start();
    servers.push(blocker1);

    const blocker2 = new FigmaWebSocketServer({ port: preferredPort + 1, host: 'localhost' });
    await blocker2.start();
    servers.push(blocker2);

    // Now try the range — should land on preferredPort + 2
    const portsToTry = [preferredPort, preferredPort + 1, preferredPort + 2, preferredPort + 3];
    let boundPort: number | null = null;

    for (const port of portsToTry) {
      try {
        const server = new FigmaWebSocketServer({ port, host: 'localhost' });
        await server.start();
        servers.push(server);
        boundPort = server.address()!.port;
        break;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') continue;
        throw err;
      }
    }

    expect(boundPort).toBe(preferredPort + 2);
  });
});
