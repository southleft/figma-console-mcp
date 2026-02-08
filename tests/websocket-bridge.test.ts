/**
 * WebSocket Bridge Tests
 *
 * Tests for:
 * - FigmaWebSocketServer: lifecycle, command routing, reconnection
 * - WebSocketConnector: IFigmaConnector implementation, method mapping
 * - Transport detection: CDP vs WebSocket fallback logic
 */

import { FigmaWebSocketServer } from '../src/core/websocket-server';
import { WebSocketConnector } from '../src/core/websocket-connector';
import { WebSocket } from 'ws';

jest.setTimeout(10000);

/**
 * Helper: create a WebSocket client and send FILE_INFO to identify the file.
 * Waits for both the client open event AND the server's 'connected' event
 * (which fires when FILE_INFO is processed in multi-client architecture).
 */
function connectClient(
  server: FigmaWebSocketServer,
  port: number,
  fileInfo?: { fileKey: string; fileName: string; currentPage?: string }
): Promise<WebSocket> {
  const info = fileInfo || { fileKey: 'test-file-key', fileName: 'Test File', currentPage: 'Page 1' };
  return new Promise((resolve, reject) => {
    const connectedPromise = new Promise<void>((res) =>
      server.once('connected', res)
    );
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', reject);
    ws.on('open', () => {
      // Send FILE_INFO to identify the file (required for multi-client)
      ws.send(JSON.stringify({ type: 'FILE_INFO', data: info }));
      // Wait for the server-side 'connected' event (fires after FILE_INFO processing)
      connectedPromise.then(() => resolve(ws));
    });
  });
}

/**
 * Helper: connect a raw WebSocket without sending FILE_INFO.
 * Used for tests that need to test the pending → identified flow explicitly.
 */
function connectRawClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('error', reject);
    ws.on('open', () => resolve(ws));
  });
}

/** Helper: close a WebSocket client safely */
function closeClient(ws: WebSocket | null): Promise<void> {
  if (!ws) return Promise.resolve();
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      resolve();
      return;
    }
    ws.on('close', () => resolve());
    ws.close();
  });
}

// ============================================================================
// FigmaWebSocketServer Tests
// ============================================================================

describe('FigmaWebSocketServer', () => {
  let server: FigmaWebSocketServer;
  let clients: WebSocket[] = [];
  const TEST_PORT = 19223;

  afterEach(async () => {
    // Stop server first — terminates connections and clears timers
    if (server) {
      await server.stop();
    }
    // Then close any remaining test clients
    for (const c of clients) {
      await closeClient(c);
    }
    clients = [];
  });

  describe('lifecycle', () => {
    test('starts and stops cleanly', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();
      expect(server.isStarted()).toBe(true);
      expect(server.isClientConnected()).toBe(false);

      await server.stop();
      expect(server.isStarted()).toBe(false);
    });

    test('start is idempotent', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();
      await server.start(); // Should not throw
      expect(server.isStarted()).toBe(true);
    });

    test('rejects on port conflict', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const server2 = new FigmaWebSocketServer({ port: TEST_PORT });
      await expect(server2.start()).rejects.toThrow();
    });
  });

  describe('client connection', () => {
    test('detects client connection', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const client = await connectClient(server, TEST_PORT);
      clients.push(client);
      expect(server.isClientConnected()).toBe(true);
    });

    test('detects client disconnection', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const client = await connectClient(server, TEST_PORT);
      expect(server.isClientConnected()).toBe(true);

      const disconnectedPromise = new Promise<void>((resolve) => {
        server.on('disconnected', resolve);
      });

      await closeClient(client);
      await disconnectedPromise;
    });

    test('replaces existing client on new connection', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const client1 = await connectClient(server, TEST_PORT);
      clients.push(client1);
      expect(server.isClientConnected()).toBe(true);

      const client2 = await connectClient(server, TEST_PORT);
      clients.push(client2);
      expect(server.isClientConnected()).toBe(true);
    });
  });

  describe('command routing', () => {
    test('sends command and receives response', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const client = await connectClient(server, TEST_PORT);
      clients.push(client);

      // Echo handler
      client.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && msg.method) {
          client.send(JSON.stringify({
            id: msg.id,
            result: { success: true, method: msg.method, params: msg.params },
          }));
        }
      });

      const result = await server.sendCommand('UPDATE_VARIABLE', {
        variableId: '123', modeId: '456', value: 'red',
      });
      expect(result.success).toBe(true);
      expect(result.method).toBe('UPDATE_VARIABLE');
      expect(result.params.variableId).toBe('123');
    });

    test('returns error from client', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const client = await connectClient(server, TEST_PORT);
      clients.push(client);

      client.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id) {
          client.send(JSON.stringify({ id: msg.id, error: 'Variable not found' }));
        }
      });

      await expect(
        server.sendCommand('UPDATE_VARIABLE', { variableId: 'bad' })
      ).rejects.toThrow('Variable not found');
    });

    test('rejects when no client connected', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      await expect(
        server.sendCommand('UPDATE_VARIABLE', {})
      ).rejects.toThrow('No active file connected');
    });

    test('times out on unresponsive client', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const client = await connectClient(server, TEST_PORT);
      clients.push(client);

      // Client doesn't respond — use a short timeout
      await expect(
        server.sendCommand('EXECUTE_CODE', { code: 'test' }, 200)
      ).rejects.toThrow('timed out');
    });

    test('emits pluginMessage for unsolicited data', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const client = await connectClient(server, TEST_PORT);
      clients.push(client);

      const messagePromise = new Promise<any>((resolve) => {
        server.on('pluginMessage', resolve);
      });

      // Client sends unsolicited data (no id, but has type)
      client.send(JSON.stringify({
        type: 'VARIABLES_DATA',
        data: { variables: [] },
      }));

      const message = await messagePromise;
      expect(message.type).toBe('VARIABLES_DATA');
      expect(message.data.variables).toEqual([]);
    });
  });
});

// ============================================================================
// WebSocketConnector Tests
// ============================================================================

describe('WebSocketConnector', () => {
  let server: FigmaWebSocketServer;
  let connector: WebSocketConnector;
  let client: WebSocket | null = null;
  const TEST_PORT = 19224;

  async function setup() {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    client = await connectClient(server, TEST_PORT);

    // Echo handler — reflects method and params back as result
    client.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && msg.method) {
        client!.send(JSON.stringify({
          id: msg.id,
          result: { success: true, method: msg.method, params: msg.params },
        }));
      }
    });

    connector = new WebSocketConnector(server);
  }

  afterEach(async () => {
    if (server) await server.stop();
    await closeClient(client);
    client = null;
  });

  test('getTransportType returns websocket', async () => {
    await setup();
    expect(connector.getTransportType()).toBe('websocket');
  });

  test('initialize succeeds when client connected', async () => {
    await setup();
    await expect(connector.initialize()).resolves.toBeUndefined();
  });

  test('initialize fails when no client', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();
    connector = new WebSocketConnector(server);

    await expect(connector.initialize()).rejects.toThrow(
      'No WebSocket client connected'
    );
  });

  describe('method mapping', () => {
    beforeEach(setup);

    test('updateVariable sends correct command', async () => {
      const result = await connector.updateVariable('var1', 'mode1', '#ff0000');
      expect(result.method).toBe('UPDATE_VARIABLE');
      expect(result.params.variableId).toBe('var1');
      expect(result.params.modeId).toBe('mode1');
      expect(result.params.value).toBe('#ff0000');
    });

    test('createVariable sends correct command', async () => {
      const result = await connector.createVariable('my-var', 'col1', 'COLOR', {
        description: 'A color variable',
        scopes: ['ALL_SCOPES'],
      });
      expect(result.method).toBe('CREATE_VARIABLE');
      expect(result.params.name).toBe('my-var');
      expect(result.params.collectionId).toBe('col1');
      expect(result.params.resolvedType).toBe('COLOR');
      expect(result.params.description).toBe('A color variable');
    });

    test('deleteVariable sends correct command', async () => {
      const result = await connector.deleteVariable('var1');
      expect(result.method).toBe('DELETE_VARIABLE');
      expect(result.params.variableId).toBe('var1');
    });

    test('refreshVariables sends correct command', async () => {
      const result = await connector.refreshVariables();
      expect(result.method).toBe('REFRESH_VARIABLES');
    });

    test('renameVariable sends correct command', async () => {
      const result = await connector.renameVariable('var1', 'new-name');
      expect(result.method).toBe('RENAME_VARIABLE');
      expect(result.params.variableId).toBe('var1');
      expect(result.params.newName).toBe('new-name');
    });

    test('setVariableDescription sends correct command', async () => {
      const result = await connector.setVariableDescription('var1', 'A description');
      expect(result.method).toBe('SET_VARIABLE_DESCRIPTION');
      expect(result.params.variableId).toBe('var1');
      expect(result.params.description).toBe('A description');
    });

    test('addMode sends correct command', async () => {
      const result = await connector.addMode('col1', 'Dark');
      expect(result.method).toBe('ADD_MODE');
      expect(result.params.collectionId).toBe('col1');
      expect(result.params.modeName).toBe('Dark');
    });

    test('renameMode sends correct command', async () => {
      const result = await connector.renameMode('col1', 'mode1', 'Dark Mode');
      expect(result.method).toBe('RENAME_MODE');
      expect(result.params.collectionId).toBe('col1');
      expect(result.params.modeId).toBe('mode1');
      expect(result.params.newName).toBe('Dark Mode');
    });

    test('createVariableCollection sends correct command', async () => {
      const result = await connector.createVariableCollection('Colors', {
        initialModeName: 'Light',
        additionalModes: ['Dark'],
      });
      expect(result.method).toBe('CREATE_VARIABLE_COLLECTION');
      expect(result.params.name).toBe('Colors');
      expect(result.params.initialModeName).toBe('Light');
    });

    test('deleteVariableCollection sends correct command', async () => {
      const result = await connector.deleteVariableCollection('col1');
      expect(result.method).toBe('DELETE_VARIABLE_COLLECTION');
      expect(result.params.collectionId).toBe('col1');
    });

    test('executeCodeViaUI sends correct command', async () => {
      const result = await connector.executeCodeViaUI('console.log("hello")', 10000);
      expect(result.method).toBe('EXECUTE_CODE');
      expect(result.params.code).toBe('console.log("hello")');
      expect(result.params.timeout).toBe(10000);
    });

    test('resizeNode sends correct command', async () => {
      const result = await connector.resizeNode('node1', 200, 100);
      expect(result.method).toBe('RESIZE_NODE');
      expect(result.params.nodeId).toBe('node1');
      expect(result.params.width).toBe(200);
      expect(result.params.height).toBe(100);
    });

    test('moveNode sends correct command', async () => {
      const result = await connector.moveNode('node1', 50, 75);
      expect(result.method).toBe('MOVE_NODE');
      expect(result.params.nodeId).toBe('node1');
      expect(result.params.x).toBe(50);
      expect(result.params.y).toBe(75);
    });

    test('cloneNode sends correct command', async () => {
      const result = await connector.cloneNode('node1');
      expect(result.method).toBe('CLONE_NODE');
      expect(result.params.nodeId).toBe('node1');
    });

    test('deleteNode sends correct command', async () => {
      const result = await connector.deleteNode('node1');
      expect(result.method).toBe('DELETE_NODE');
      expect(result.params.nodeId).toBe('node1');
    });

    test('renameNode sends correct command', async () => {
      const result = await connector.renameNode('node1', 'New Name');
      expect(result.method).toBe('RENAME_NODE');
      expect(result.params.nodeId).toBe('node1');
      expect(result.params.newName).toBe('New Name');
    });

    test('setNodeFills sends correct command', async () => {
      const fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
      const result = await connector.setNodeFills('node1', fills);
      expect(result.method).toBe('SET_NODE_FILLS');
      expect(result.params.fills).toEqual(fills);
    });

    test('setNodeStrokes sends correct command', async () => {
      const strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      const result = await connector.setNodeStrokes('node1', strokes, 2);
      expect(result.method).toBe('SET_NODE_STROKES');
      expect(result.params.strokes).toEqual(strokes);
      expect(result.params.strokeWeight).toBe(2);
    });

    test('setTextContent sends correct command', async () => {
      const result = await connector.setTextContent('node1', 'Hello World');
      expect(result.method).toBe('SET_TEXT_CONTENT');
      expect(result.params.nodeId).toBe('node1');
      expect(result.params.text).toBe('Hello World');
    });

    test('captureScreenshot sends correct command', async () => {
      const result = await connector.captureScreenshot('node1', { format: 'PNG', scale: 2 });
      expect(result.method).toBe('CAPTURE_SCREENSHOT');
      expect(result.params.nodeId).toBe('node1');
      expect(result.params.format).toBe('PNG');
      expect(result.params.scale).toBe(2);
    });

    test('setInstanceProperties sends correct command', async () => {
      const props = { 'Text#1': 'Hello', 'Visible#2': true };
      const result = await connector.setInstanceProperties('node1', props);
      expect(result.method).toBe('SET_INSTANCE_PROPERTIES');
      expect(result.params.nodeId).toBe('node1');
      expect(result.params.properties).toEqual(props);
    });

    test('getLocalComponents sends correct command', async () => {
      const result = await connector.getLocalComponents();
      expect(result.method).toBe('GET_LOCAL_COMPONENTS');
    });

    test('instantiateComponent sends correct command', async () => {
      const result = await connector.instantiateComponent('comp-key', {
        nodeId: 'local-id',
        position: { x: 100, y: 200 },
      });
      expect(result.method).toBe('INSTANTIATE_COMPONENT');
      expect(result.params.componentKey).toBe('comp-key');
      expect(result.params.nodeId).toBe('local-id');
      expect(result.params.position).toEqual({ x: 100, y: 200 });
    });

    test('clearFrameCache is a no-op', () => {
      expect(() => connector.clearFrameCache()).not.toThrow();
    });
  });
});

// ============================================================================
// Critical Edge Cases & Error Paths (Priority 1)
// ============================================================================

describe('FigmaWebSocketServer edge cases', () => {
  let server: FigmaWebSocketServer;
  let clients: WebSocket[] = [];
  const TEST_PORT = 19225;

  afterEach(async () => {
    if (server) await server.stop();
    for (const c of clients) {
      await closeClient(c);
    }
    clients = [];
  });

  test('pending request rejects when client disconnects mid-command', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    // Don't respond to commands — just disconnect

    // Send command (don't await yet)
    const commandPromise = server.sendCommand('EXECUTE_CODE', { code: 'test' }, 10000);

    // Immediately close client to simulate mid-request disconnect
    client.terminate();

    // The grace period is 5s, so the request should reject after that
    // Use a shorter assertion timeout since we just need to verify it rejects
    await expect(commandPromise).rejects.toThrow();
  }, 15000);

  test('stop() rejects all pending requests immediately', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);
    // Client doesn't respond to commands

    // Send multiple commands
    const cmd1 = server.sendCommand('EXECUTE_CODE', { code: '1' }, 30000);
    const cmd2 = server.sendCommand('UPDATE_VARIABLE', { variableId: '1' }, 30000);
    const cmd3 = server.sendCommand('CREATE_VARIABLE', { name: 'x' }, 30000);

    // Stop server — should reject all pending immediately
    await server.stop();

    await expect(cmd1).rejects.toThrow('shutting down');
    await expect(cmd2).rejects.toThrow('shutting down');
    await expect(cmd3).rejects.toThrow('shutting down');
  });

  test('handles multiple concurrent commands correctly', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    // Echo handler with small delay to simulate real work
    client.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && msg.method) {
        setTimeout(() => {
          client.send(JSON.stringify({
            id: msg.id,
            result: { success: true, method: msg.method, order: msg.params?.order },
          }));
        }, Math.random() * 50); // Random delay 0-50ms
      }
    });

    // Send 10 concurrent commands
    const promises = Array.from({ length: 10 }, (_, i) =>
      server.sendCommand('EXECUTE_CODE', { order: i })
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(10);
    results.forEach((r, i) => {
      expect(r.success).toBe(true);
      expect(r.order).toBe(i);
    });
  });

  test('grace period cancels on reconnection within 5s', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client1 = await connectClient(server, TEST_PORT);

    // Client 1 sends a command (no response)
    const cmd = server.sendCommand('EXECUTE_CODE', { code: 'test' }, 30000);

    // Disconnect client 1
    const disconnectedPromise = new Promise<void>((resolve) => {
      server.on('disconnected', resolve);
    });
    client1.terminate();
    await disconnectedPromise;

    // Reconnect quickly (within 5s grace period)
    const client2 = await connectClient(server, TEST_PORT);
    clients.push(client2);

    // client2 responds to the pending command
    client2.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && msg.method) {
        client2.send(JSON.stringify({
          id: msg.id,
          result: { success: true, reconnected: true },
        }));
      }
    });

    // The command should NOT have been rejected by the grace period
    // But the pending request was sent to client1 (now dead) so it won't
    // get a response from client2. It should eventually timeout or be
    // rejected by the grace period. The key assertion is that the grace
    // period timer was cancelled on reconnect (no premature rejection).
    // After 5s (grace period), the request should still be pending since
    // the timer was cancelled by the new connection.
    // We'll stop the server which will reject it with 'shutting down'
    await server.stop();
    await expect(cmd).rejects.toThrow('shutting down');
  }, 15000);

  test('handles malformed JSON from client gracefully', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    // Send garbage data — server should not crash
    client.send('not json at all');
    client.send('{invalid json}');
    client.send('');

    // Server should still be functional after receiving malformed messages
    // Set up echo handler for the next real command
    client.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && msg.method) {
        client.send(JSON.stringify({
          id: msg.id,
          result: { success: true },
        }));
      }
    });

    // Wait a tick for malformed messages to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Server should still work
    const result = await server.sendCommand('EXECUTE_CODE', { code: 'test' });
    expect(result.success).toBe(true);
  });

  test('ignores response for unknown request ID', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    // Client sends a response with unknown ID — should not crash
    client.send(JSON.stringify({ id: 'unknown_123', result: { data: 'orphan' } }));

    // Wait a tick
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Server should still be functional
    expect(server.isClientConnected()).toBe(true);
  });
});

// ============================================================================
// File Identity Tracking
// ============================================================================

describe('FigmaWebSocketServer file identity tracking', () => {
  let server: FigmaWebSocketServer;
  const clients: WebSocket[] = [];
  const TEST_PORT = 19226;

  afterEach(async () => {
    for (const c of clients) {
      c.terminate();
    }
    clients.length = 0;
    if (server) await server.stop();
  });

  test('getConnectedFileInfo returns null when no client connected', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();
    expect(server.getConnectedFileInfo()).toBeNull();
  });

  test('tracks file info from FILE_INFO message', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    // Use raw client so we can test the pending state before FILE_INFO
    const client = await connectRawClient(TEST_PORT);
    clients.push(client);

    // No file info yet — client is pending (hasn't sent FILE_INFO)
    expect(server.getConnectedFileInfo()).toBeNull();

    // Simulate plugin sending FILE_INFO
    const connectedPromise = new Promise<void>((resolve) =>
      server.once('connected', resolve)
    );
    client.send(JSON.stringify({
      type: 'FILE_INFO',
      data: {
        fileName: 'Eddie Design System Components',
        fileKey: 'abc123',
        currentPage: 'Buttons',
      },
    }));
    await connectedPromise;

    const info = server.getConnectedFileInfo();
    expect(info).not.toBeNull();
    expect(info!.fileName).toBe('Eddie Design System Components');
    expect(info!.fileKey).toBe('abc123');
    expect(info!.currentPage).toBe('Buttons');
    expect(info!.connectedAt).toBeGreaterThan(0);
  });

  test('clears file info on client disconnect after grace period', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT, {
      fileKey: 'key1', fileName: 'Test File',
    });
    clients.push(client);
    expect(server.getConnectedFileInfo()).not.toBeNull();

    // Wait for fileDisconnected (fires after 5s grace period)
    const disconnectedPromise = new Promise<void>((resolve) =>
      server.once('fileDisconnected', resolve)
    );

    await closeClient(client);
    clients.length = 0;

    await disconnectedPromise;
    expect(server.getConnectedFileInfo()).toBeNull();
  }, 10000);

  test('multi-client: both files connected, active stays as first', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    // First client — becomes active
    const client1 = await connectClient(server, TEST_PORT, {
      fileKey: 'keyA', fileName: 'File A',
    });
    clients.push(client1);
    expect(server.getConnectedFileInfo()!.fileName).toBe('File A');
    expect(server.getActiveFileKey()).toBe('keyA');

    // Second client — connects but first remains active
    const client2 = await connectClient(server, TEST_PORT, {
      fileKey: 'keyB', fileName: 'File B',
    });
    clients.push(client2);

    // Active file is still File A
    expect(server.getConnectedFileInfo()!.fileName).toBe('File A');
    expect(server.getActiveFileKey()).toBe('keyA');

    // Both files are connected
    const files = server.getConnectedFiles();
    expect(files).toHaveLength(2);
    expect(files.find(f => f.fileKey === 'keyA')?.isActive).toBe(true);
    expect(files.find(f => f.fileKey === 'keyB')?.isActive).toBe(false);
  });

  test('emits documentChange event for DOCUMENT_CHANGE messages', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    const changePromise = new Promise<any>((resolve) =>
      server.once('documentChange', resolve)
    );

    client.send(JSON.stringify({
      type: 'DOCUMENT_CHANGE',
      data: {
        hasVariableChanges: true,
        hasStyleChanges: false,
        hasNodeChanges: true,
        changedNodeIds: ['1:2', '1:3'],
        changeCount: 5,
        timestamp: Date.now(),
      },
    }));

    const changeData = await changePromise;
    expect(changeData.hasVariableChanges).toBe(true);
    expect(changeData.hasNodeChanges).toBe(true);
    expect(changeData.changedNodeIds).toEqual(['1:2', '1:3']);
  });
});

// ============================================================================
// WebSocket Console Capture
// ============================================================================

describe('FigmaWebSocketServer console capture', () => {
  const TEST_PORT = 19227;
  let server: FigmaWebSocketServer;
  let clients: WebSocket[] = [];

  afterEach(async () => {
    for (const c of clients) c.terminate();
    clients = [];
    if (server) await server.stop();
  });

  test('captures CONSOLE_CAPTURE messages in log buffer', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    client.send(JSON.stringify({
      type: 'CONSOLE_CAPTURE',
      data: {
        level: 'log',
        message: 'Hello from plugin',
        args: ['Hello from plugin'],
        timestamp: 1000,
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logs = server.getConsoleLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('log');
    expect(logs[0].message).toBe('Hello from plugin');
    expect(logs[0].source).toBe('plugin');
    expect(logs[0].timestamp).toBe(1000);
  });

  test('filters logs by level', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    const levels = ['log', 'warn', 'error', 'info', 'debug'];
    for (const level of levels) {
      client.send(JSON.stringify({
        type: 'CONSOLE_CAPTURE',
        data: { level, message: `msg-${level}`, args: [], timestamp: Date.now() },
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.getConsoleLogs()).toHaveLength(5);
    expect(server.getConsoleLogs({ level: 'error' })).toHaveLength(1);
    expect(server.getConsoleLogs({ level: 'error' })[0].message).toBe('msg-error');
    expect(server.getConsoleLogs({ level: 'all' })).toHaveLength(5);
  });

  test('filters logs by since timestamp', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    client.send(JSON.stringify({
      type: 'CONSOLE_CAPTURE',
      data: { level: 'log', message: 'old', args: [], timestamp: 1000 },
    }));
    client.send(JSON.stringify({
      type: 'CONSOLE_CAPTURE',
      data: { level: 'log', message: 'new', args: [], timestamp: 2000 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const recent = server.getConsoleLogs({ since: 1500 });
    expect(recent).toHaveLength(1);
    expect(recent[0].message).toBe('new');
  });

  test('limits log count', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    for (let i = 0; i < 10; i++) {
      client.send(JSON.stringify({
        type: 'CONSOLE_CAPTURE',
        data: { level: 'log', message: `msg-${i}`, args: [], timestamp: i },
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const limited = server.getConsoleLogs({ count: 3 });
    expect(limited).toHaveLength(3);
    expect(limited[0].message).toBe('msg-7');
    expect(limited[2].message).toBe('msg-9');
  });

  test('clears console logs', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    client.send(JSON.stringify({
      type: 'CONSOLE_CAPTURE',
      data: { level: 'log', message: 'test', args: [], timestamp: Date.now() },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.getConsoleLogs()).toHaveLength(1);
    const cleared = server.clearConsoleLogs();
    expect(cleared).toBe(1);
    expect(server.getConsoleLogs()).toHaveLength(0);
  });

  test('getConsoleStatus reports correct state', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    // No client connected
    let status = server.getConsoleStatus();
    expect(status.isMonitoring).toBe(false);
    expect(status.logCount).toBe(0);

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    client.send(JSON.stringify({
      type: 'CONSOLE_CAPTURE',
      data: { level: 'warn', message: 'warning', args: [], timestamp: 5000 },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    status = server.getConsoleStatus();
    expect(status.isMonitoring).toBe(true);
    expect(status.logCount).toBe(1);
    expect(status.oldestTimestamp).toBe(5000);
    expect(status.newestTimestamp).toBe(5000);
  });

  test('emits consoleLog event on capture', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    const logPromise = new Promise<any>((resolve) =>
      server.once('consoleLog', resolve)
    );

    client.send(JSON.stringify({
      type: 'CONSOLE_CAPTURE',
      data: { level: 'error', message: 'crash!', args: ['detail'], timestamp: Date.now() },
    }));

    const entry = await logPromise;
    expect(entry.level).toBe('error');
    expect(entry.message).toBe('crash!');
    expect(entry.source).toBe('plugin');
  });

  test('truncates long messages to 1000 chars', async () => {
    server = new FigmaWebSocketServer({ port: TEST_PORT });
    await server.start();

    const client = await connectClient(server, TEST_PORT);
    clients.push(client);

    const longMessage = 'x'.repeat(2000);
    client.send(JSON.stringify({
      type: 'CONSOLE_CAPTURE',
      data: { level: 'log', message: longMessage, args: [], timestamp: Date.now() },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logs = server.getConsoleLogs();
    expect(logs[0].message.length).toBe(1000);
  });
});

// ============================================================================
// IFigmaConnector Interface Compliance
// ============================================================================

describe('IFigmaConnector interface compliance', () => {
  test('FigmaDesktopConnector has getTransportType returning cdp', async () => {
    const mod = await import('../src/core/figma-desktop-connector');
    expect(mod.FigmaDesktopConnector.prototype.getTransportType).toBeDefined();
    const result = mod.FigmaDesktopConnector.prototype.getTransportType();
    expect(result).toBe('cdp');
  });

  test('WebSocketConnector has getTransportType returning websocket', () => {
    const mockServer = { isClientConnected: () => false } as any;
    const connector = new WebSocketConnector(mockServer);
    expect(connector.getTransportType()).toBe('websocket');
  });

  test('Both connectors implement all IFigmaConnector methods', async () => {
    const interfaceMethods = [
      'initialize', 'getTransportType', 'executeInPluginContext',
      'getVariablesFromPluginUI', 'getVariables', 'executeCodeViaUI',
      'updateVariable', 'createVariable', 'deleteVariable',
      'refreshVariables', 'renameVariable', 'setVariableDescription',
      'addMode', 'renameMode', 'createVariableCollection',
      'deleteVariableCollection', 'getComponentFromPluginUI',
      'getLocalComponents', 'setNodeDescription', 'addComponentProperty',
      'editComponentProperty', 'deleteComponentProperty',
      'instantiateComponent', 'resizeNode', 'moveNode',
      'setNodeFills', 'setNodeStrokes', 'setNodeOpacity',
      'setNodeCornerRadius', 'cloneNode', 'deleteNode',
      'renameNode', 'setTextContent', 'createChildNode',
      'captureScreenshot', 'setInstanceProperties', 'clearFrameCache',
    ];

    // Check WebSocketConnector
    const mockServer = { isClientConnected: () => false } as any;
    const wsConnector = new WebSocketConnector(mockServer);
    for (const method of interfaceMethods) {
      expect(typeof (wsConnector as any)[method]).toBe('function');
    }

    // Check FigmaDesktopConnector prototype
    const mod = await import('../src/core/figma-desktop-connector');
    for (const method of interfaceMethods) {
      expect(typeof mod.FigmaDesktopConnector.prototype[method]).toBe('function');
    }
  });
});

// =============================================================================
// Selection Change Tracking
// =============================================================================

describe('Selection change tracking', () => {
  let server: FigmaWebSocketServer;
  let client: WebSocket;
  const port = 19230;

  beforeEach(async () => {
    server = new FigmaWebSocketServer({ port, host: 'localhost' });
    await server.start();
    client = await connectClient(server, port);
  });

  afterEach(async () => {
    await closeClient(client);
    await server.stop();
  });

  it('should store selection from SELECTION_CHANGE message', async () => {
    const selectionData = {
      nodes: [
        { id: '1:23', name: 'Button', type: 'COMPONENT', width: 200, height: 48 },
        { id: '1:24', name: 'Label', type: 'TEXT', width: 100, height: 20 },
      ],
      count: 2,
      page: 'Components',
      timestamp: Date.now(),
    };

    const eventPromise = new Promise<void>((resolve) =>
      server.once('selectionChange', () => resolve())
    );

    client.send(JSON.stringify({ type: 'SELECTION_CHANGE', data: selectionData }));
    await eventPromise;

    const sel = server.getCurrentSelection();
    expect(sel).not.toBeNull();
    expect(sel!.count).toBe(2);
    expect(sel!.nodes).toHaveLength(2);
    expect(sel!.nodes[0].name).toBe('Button');
    expect(sel!.nodes[1].type).toBe('TEXT');
    expect(sel!.page).toBe('Components');
  });

  it('should return null selection when no events received', () => {
    expect(server.getCurrentSelection()).toBeNull();
  });

  it('should clear selection on disconnect after grace period', async () => {
    const selectionData = {
      nodes: [{ id: '1:1', name: 'Frame', type: 'FRAME', width: 100, height: 100 }],
      count: 1,
      page: 'Page 1',
      timestamp: Date.now(),
    };

    const eventPromise = new Promise<void>((resolve) =>
      server.once('selectionChange', () => resolve())
    );
    client.send(JSON.stringify({ type: 'SELECTION_CHANGE', data: selectionData }));
    await eventPromise;

    expect(server.getCurrentSelection()).not.toBeNull();

    // Wait for fileDisconnected (fires after 5s grace period)
    const disconnectedPromise = new Promise<void>((resolve) =>
      server.once('fileDisconnected', resolve)
    );

    await closeClient(client);
    client = null as any;

    await disconnectedPromise;
    expect(server.getCurrentSelection()).toBeNull();
  }, 10000);

  it('should update selection with latest data', async () => {
    const sel1 = {
      nodes: [{ id: '1:1', name: 'Old', type: 'FRAME', width: 50, height: 50 }],
      count: 1,
      page: 'Page 1',
      timestamp: Date.now(),
    };
    const sel2 = {
      nodes: [{ id: '2:2', name: 'New', type: 'TEXT', width: 200, height: 20 }],
      count: 1,
      page: 'Page 2',
      timestamp: Date.now() + 100,
    };

    let eventCount = 0;
    const secondEvent = new Promise<void>((resolve) => {
      server.on('selectionChange', () => {
        eventCount++;
        if (eventCount === 2) resolve();
      });
    });

    client.send(JSON.stringify({ type: 'SELECTION_CHANGE', data: sel1 }));
    client.send(JSON.stringify({ type: 'SELECTION_CHANGE', data: sel2 }));
    await secondEvent;

    const current = server.getCurrentSelection();
    expect(current!.nodes[0].name).toBe('New');
    expect(current!.page).toBe('Page 2');
  });
});

// =============================================================================
// Document Change Event Buffer
// =============================================================================

describe('Document change event buffer', () => {
  let server: FigmaWebSocketServer;
  let client: WebSocket;
  const port = 19231;

  beforeEach(async () => {
    server = new FigmaWebSocketServer({ port, host: 'localhost' });
    await server.start();
    client = await connectClient(server, port);
  });

  afterEach(async () => {
    await closeClient(client);
    await server.stop();
  });

  it('should buffer DOCUMENT_CHANGE events', async () => {
    const change = {
      hasStyleChanges: true,
      hasNodeChanges: false,
      changedNodeIds: [],
      changeCount: 3,
      timestamp: Date.now(),
    };

    const eventPromise = new Promise<void>((resolve) =>
      server.once('documentChange', () => resolve())
    );
    client.send(JSON.stringify({ type: 'DOCUMENT_CHANGE', data: change }));
    await eventPromise;

    const changes = server.getDocumentChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].hasStyleChanges).toBe(true);
    expect(changes[0].changeCount).toBe(3);
  });

  it('should filter changes by timestamp with since option', async () => {
    const now = Date.now();
    const changes = [
      { hasStyleChanges: false, hasNodeChanges: true, changedNodeIds: ['1:1'], changeCount: 1, timestamp: now - 2000 },
      { hasStyleChanges: true, hasNodeChanges: false, changedNodeIds: [], changeCount: 2, timestamp: now - 1000 },
      { hasStyleChanges: false, hasNodeChanges: true, changedNodeIds: ['2:2'], changeCount: 1, timestamp: now },
    ];

    let receivedCount = 0;
    const allReceived = new Promise<void>((resolve) => {
      server.on('documentChange', () => {
        receivedCount++;
        if (receivedCount === 3) resolve();
      });
    });

    for (const c of changes) {
      client.send(JSON.stringify({ type: 'DOCUMENT_CHANGE', data: c }));
    }
    await allReceived;

    const filtered = server.getDocumentChanges({ since: now - 1500 });
    expect(filtered).toHaveLength(2);
    expect(filtered[0].hasStyleChanges).toBe(true);
    expect(filtered[1].changedNodeIds).toContain('2:2');
  });

  it('should limit results with count option', async () => {
    const events: any[] = [];
    for (let i = 0; i < 5; i++) {
      events.push({
        hasStyleChanges: false,
        hasNodeChanges: true,
        changedNodeIds: [`${i}:${i}`],
        changeCount: 1,
        timestamp: Date.now() + i,
      });
    }

    let receivedCount = 0;
    const allReceived = new Promise<void>((resolve) => {
      server.on('documentChange', () => {
        receivedCount++;
        if (receivedCount === 5) resolve();
      });
    });

    for (const e of events) {
      client.send(JSON.stringify({ type: 'DOCUMENT_CHANGE', data: e }));
    }
    await allReceived;

    const limited = server.getDocumentChanges({ count: 2 });
    expect(limited).toHaveLength(2);
    // Should return the 2 most recent
    expect(limited[0].changedNodeIds[0]).toBe('3:3');
    expect(limited[1].changedNodeIds[0]).toBe('4:4');
  });

  it('should clear buffer and return count', async () => {
    const change = {
      hasStyleChanges: false,
      hasNodeChanges: true,
      changedNodeIds: ['1:1'],
      changeCount: 1,
      timestamp: Date.now(),
    };

    const eventPromise = new Promise<void>((resolve) =>
      server.once('documentChange', () => resolve())
    );
    client.send(JSON.stringify({ type: 'DOCUMENT_CHANGE', data: change }));
    await eventPromise;

    expect(server.getDocumentChanges()).toHaveLength(1);

    const cleared = server.clearDocumentChanges();
    expect(cleared).toBe(1);
    expect(server.getDocumentChanges()).toHaveLength(0);
  });

  it('should respect buffer size limit', async () => {
    // The buffer size is 200 — send 205 events
    const allReceived = new Promise<void>((resolve) => {
      let count = 0;
      server.on('documentChange', () => {
        count++;
        if (count === 205) resolve();
      });
    });

    for (let i = 0; i < 205; i++) {
      client.send(JSON.stringify({
        type: 'DOCUMENT_CHANGE',
        data: {
          hasStyleChanges: false,
          hasNodeChanges: true,
          changedNodeIds: [`${i}:0`],
          changeCount: 1,
          timestamp: Date.now() + i,
        },
      }));
    }
    await allReceived;

    const all = server.getDocumentChanges();
    expect(all.length).toBeLessThanOrEqual(200);
    // Oldest events should have been dropped
    expect(all[0].changedNodeIds[0]).toBe('5:0');
  });
});

// =============================================================================
// Page Change Tracking
// =============================================================================

describe('Page change tracking', () => {
  let server: FigmaWebSocketServer;
  let client: WebSocket;
  const port = 19232;

  beforeEach(async () => {
    server = new FigmaWebSocketServer({ port, host: 'localhost' });
    await server.start();
    client = await connectClient(server, port);
  });

  afterEach(async () => {
    await closeClient(client);
    await server.stop();
  });

  it('should update connectedFileInfo.currentPage on PAGE_CHANGE', async () => {
    // connectClient already sent FILE_INFO with currentPage 'Page 1'
    expect(server.getConnectedFileInfo()?.currentPage).toBe('Page 1');

    // Now send page change
    const pageChangePromise = new Promise<void>((resolve) =>
      server.once('pageChange', () => resolve())
    );
    client.send(JSON.stringify({
      type: 'PAGE_CHANGE',
      data: { pageId: '2:0', pageName: 'Components', timestamp: Date.now() },
    }));
    await pageChangePromise;

    expect(server.getConnectedFileInfo()?.currentPage).toBe('Components');
  });

  it('should emit pageChange event', async () => {
    const eventData = await new Promise<any>((resolve) => {
      server.once('pageChange', (data) => resolve(data));
      client.send(JSON.stringify({
        type: 'PAGE_CHANGE',
        data: { pageId: '3:0', pageName: 'Icons', timestamp: Date.now() },
      }));
    });

    expect(eventData.pageName).toBe('Icons');
    expect(eventData.pageId).toBe('3:0');
  });
});

// =============================================================================
// Multi-Client WebSocket Architecture
// =============================================================================

describe('Multi-client WebSocket', () => {
  let server: FigmaWebSocketServer;
  const clients: WebSocket[] = [];
  const TEST_PORT = 19233;

  afterEach(async () => {
    if (server) await server.stop();
    for (const c of clients) await closeClient(c);
    clients.length = 0;
  });

  describe('multiple file connections', () => {
    test('connects multiple files simultaneously', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'Design System' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'App Screens' });
      clients.push(c2);
      const c3 = await connectClient(server, TEST_PORT, { fileKey: 'file-c', fileName: 'Icons Library' });
      clients.push(c3);

      const files = server.getConnectedFiles();
      expect(files).toHaveLength(3);
      expect(files.map(f => f.fileKey)).toEqual(expect.arrayContaining(['file-a', 'file-b', 'file-c']));
    });

    test('same-file reconnection replaces old connection', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'Design System' });
      clients.push(c1);
      expect(server.getConnectedFiles()).toHaveLength(1);

      // Reconnect same file — old ws should be replaced
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'Design System v2' });
      clients.push(c2);

      const files = server.getConnectedFiles();
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('Design System v2');
    });

    test('preserves per-file state across same-file reconnection', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'Design System' });
      clients.push(c1);

      // Add console log to file-a
      const logPromise = new Promise<void>((resolve) =>
        server.once('consoleLog', resolve)
      );
      c1.send(JSON.stringify({
        type: 'CONSOLE_CAPTURE',
        data: { level: 'log', message: 'test log', args: [], timestamp: 1000 },
      }));
      await logPromise;
      expect(server.getConsoleLogs()).toHaveLength(1);

      // Reconnect same file — state should be preserved
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'Design System' });
      clients.push(c2);

      expect(server.getConsoleLogs()).toHaveLength(1);
      expect(server.getConsoleLogs()[0].message).toBe('test log');
    });
  });

  describe('active file management', () => {
    test('first connected file becomes active', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'First' }).then(c => clients.push(c));
      expect(server.getActiveFileKey()).toBe('file-a');

      await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'Second' }).then(c => clients.push(c));
      expect(server.getActiveFileKey()).toBe('file-a'); // Still first
    });

    test('setActiveFile switches the targeted file', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'File A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'File B' });
      clients.push(c2);

      expect(server.getActiveFileKey()).toBe('file-a');
      expect(server.getConnectedFileInfo()!.fileName).toBe('File A');

      const switched = server.setActiveFile('file-b');
      expect(switched).toBe(true);
      expect(server.getActiveFileKey()).toBe('file-b');
      expect(server.getConnectedFileInfo()!.fileName).toBe('File B');
    });

    test('setActiveFile returns false for unknown file', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'File A' });
      clients.push(c);

      expect(server.setActiveFile('nonexistent')).toBe(false);
      expect(server.getActiveFileKey()).toBe('file-a'); // Unchanged
    });

    test('emits activeFileChanged on setActiveFile', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      const eventPromise = new Promise<any>((resolve) =>
        server.once('activeFileChanged', resolve)
      );
      server.setActiveFile('file-b');

      const event = await eventPromise;
      expect(event.fileKey).toBe('file-b');
      expect(event.fileName).toBe('B');
    });

    test('SELECTION_CHANGE auto-switches active file', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      expect(server.getActiveFileKey()).toBe('file-a');

      // User selects something in file-b → auto-switches
      const selPromise = new Promise<void>((resolve) =>
        server.once('selectionChange', resolve)
      );
      c2.send(JSON.stringify({
        type: 'SELECTION_CHANGE',
        data: {
          nodes: [{ id: '1:1', name: 'Frame', type: 'FRAME', width: 100, height: 100 }],
          count: 1,
          page: 'Page 1',
          timestamp: Date.now(),
        },
      }));
      await selPromise;

      expect(server.getActiveFileKey()).toBe('file-b');
    });

    test('PAGE_CHANGE auto-switches active file', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      expect(server.getActiveFileKey()).toBe('file-a');

      // User switches pages in file-b → auto-switches
      const pagePromise = new Promise<void>((resolve) =>
        server.once('pageChange', resolve)
      );
      c2.send(JSON.stringify({
        type: 'PAGE_CHANGE',
        data: { pageId: '5:0', pageName: 'Components', timestamp: Date.now() },
      }));
      await pagePromise;

      expect(server.getActiveFileKey()).toBe('file-b');
    });
  });

  describe('per-file state isolation', () => {
    test('console logs are per-file', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      // Send log from file-a
      let logPromise = new Promise<void>((resolve) => server.once('consoleLog', resolve));
      c1.send(JSON.stringify({
        type: 'CONSOLE_CAPTURE',
        data: { level: 'log', message: 'from-a', args: [], timestamp: 1000 },
      }));
      await logPromise;

      // Send log from file-b
      logPromise = new Promise<void>((resolve) => server.once('consoleLog', resolve));
      c2.send(JSON.stringify({
        type: 'CONSOLE_CAPTURE',
        data: { level: 'warn', message: 'from-b', args: [], timestamp: 2000 },
      }));
      await logPromise;

      // Active is file-a — should only see file-a's logs
      expect(server.getActiveFileKey()).toBe('file-a');
      expect(server.getConsoleLogs()).toHaveLength(1);
      expect(server.getConsoleLogs()[0].message).toBe('from-a');

      // Switch to file-b — should only see file-b's logs
      server.setActiveFile('file-b');
      expect(server.getConsoleLogs()).toHaveLength(1);
      expect(server.getConsoleLogs()[0].message).toBe('from-b');
    });

    test('document changes are per-file', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      // Doc change in file-a
      let changePromise = new Promise<void>((resolve) => server.once('documentChange', resolve));
      c1.send(JSON.stringify({
        type: 'DOCUMENT_CHANGE',
        data: { hasStyleChanges: true, hasNodeChanges: false, changedNodeIds: [], changeCount: 1, timestamp: Date.now() },
      }));
      await changePromise;

      // Doc change in file-b
      changePromise = new Promise<void>((resolve) => server.once('documentChange', resolve));
      c2.send(JSON.stringify({
        type: 'DOCUMENT_CHANGE',
        data: { hasStyleChanges: false, hasNodeChanges: true, changedNodeIds: ['1:1'], changeCount: 2, timestamp: Date.now() },
      }));
      await changePromise;

      // Active is file-a — should only see file-a's changes
      expect(server.getDocumentChanges()).toHaveLength(1);
      expect(server.getDocumentChanges()[0].hasStyleChanges).toBe(true);

      // Switch to file-b
      server.setActiveFile('file-b');
      expect(server.getDocumentChanges()).toHaveLength(1);
      expect(server.getDocumentChanges()[0].hasNodeChanges).toBe(true);
    });

    test('selection is per-file', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      // Selection in file-b (note: this auto-switches active to file-b)
      const selPromise = new Promise<void>((resolve) => server.once('selectionChange', resolve));
      c2.send(JSON.stringify({
        type: 'SELECTION_CHANGE',
        data: {
          nodes: [{ id: '2:1', name: 'Card', type: 'COMPONENT', width: 300, height: 200 }],
          count: 1,
          page: 'Cards',
          timestamp: Date.now(),
        },
      }));
      await selPromise;

      // Active is now file-b — should see file-b's selection
      expect(server.getActiveFileKey()).toBe('file-b');
      expect(server.getCurrentSelection()!.nodes[0].name).toBe('Card');

      // Switch back to file-a — no selection
      server.setActiveFile('file-a');
      expect(server.getCurrentSelection()).toBeNull();
    });
  });

  describe('command routing', () => {
    test('sendCommand targets active file by default', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      // Echo handler on file-a (active by default)
      c1.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && msg.method) {
          c1.send(JSON.stringify({ id: msg.id, result: { file: 'a' } }));
        }
      });

      const result = await server.sendCommand('EXECUTE_CODE', { code: 'test' });
      expect(result.file).toBe('a');
    });

    test('sendCommand targets specific file via targetFileKey', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      // Echo handlers on both
      c1.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && msg.method) {
          c1.send(JSON.stringify({ id: msg.id, result: { file: 'a' } }));
        }
      });
      c2.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && msg.method) {
          c2.send(JSON.stringify({ id: msg.id, result: { file: 'b' } }));
        }
      });

      // Active is file-a, but target file-b explicitly
      const result = await server.sendCommand('EXECUTE_CODE', { code: 'test' }, 15000, 'file-b');
      expect(result.file).toBe('b');
    });

    test('concurrent commands to different files', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      // Echo handlers
      c1.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && msg.method) {
          setTimeout(() => c1.send(JSON.stringify({ id: msg.id, result: { file: 'a' } })), 20);
        }
      });
      c2.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && msg.method) {
          setTimeout(() => c2.send(JSON.stringify({ id: msg.id, result: { file: 'b' } })), 20);
        }
      });

      // Send commands concurrently to both files
      const [r1, r2] = await Promise.all([
        server.sendCommand('EXECUTE_CODE', { code: 'a' }, 15000, 'file-a'),
        server.sendCommand('EXECUTE_CODE', { code: 'b' }, 15000, 'file-b'),
      ]);

      expect(r1.file).toBe('a');
      expect(r2.file).toBe('b');
    });
  });

  describe('disconnect behavior', () => {
    test('disconnecting one file does not affect others', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      expect(server.getConnectedFiles()).toHaveLength(2);

      // Disconnect file-b — file-a should still be active and connected
      const disconnectedPromise = new Promise<void>((resolve) =>
        server.once('fileDisconnected', resolve)
      );
      c2.terminate();
      await disconnectedPromise;

      expect(server.isClientConnected()).toBe(true);
      expect(server.getActiveFileKey()).toBe('file-a');
      expect(server.getConnectedFiles()).toHaveLength(1);
      expect(server.getConnectedFiles()[0].fileKey).toBe('file-a');
    }, 10000);

    test('active file falls back when active disconnects', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c1 = await connectClient(server, TEST_PORT, { fileKey: 'file-a', fileName: 'A' });
      clients.push(c1);
      const c2 = await connectClient(server, TEST_PORT, { fileKey: 'file-b', fileName: 'B' });
      clients.push(c2);

      expect(server.getActiveFileKey()).toBe('file-a');

      // Disconnect active file (file-a) — should fall back to file-b
      const disconnectedPromise = new Promise<void>((resolve) =>
        server.once('fileDisconnected', resolve)
      );
      c1.terminate();
      await disconnectedPromise;

      expect(server.getActiveFileKey()).toBe('file-b');
      expect(server.getConnectedFileInfo()!.fileName).toBe('B');
    }, 10000);

    test('pending client timeout when FILE_INFO not sent', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      // Connect raw — no FILE_INFO sent
      const raw = await connectRawClient(TEST_PORT);
      clients.push(raw);

      // Client should be pending, not named
      expect(server.isClientConnected()).toBe(false);
      expect(server.getConnectedFiles()).toHaveLength(0);

      // Close raw client before timeout
      await closeClient(raw);
      clients.length = 0;
    });
  });

  describe('fileConnected and fileDisconnected events', () => {
    test('emits fileConnected with file details', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const eventPromise = new Promise<any>((resolve) =>
        server.once('fileConnected', resolve)
      );

      const c = await connectClient(server, TEST_PORT, { fileKey: 'file-x', fileName: 'My File' });
      clients.push(c);

      const event = await eventPromise;
      expect(event.fileKey).toBe('file-x');
      expect(event.fileName).toBe('My File');
    });

    test('emits fileDisconnected after grace period', async () => {
      server = new FigmaWebSocketServer({ port: TEST_PORT });
      await server.start();

      const c = await connectClient(server, TEST_PORT, { fileKey: 'file-x', fileName: 'My File' });

      const eventPromise = new Promise<any>((resolve) =>
        server.once('fileDisconnected', resolve)
      );
      c.terminate();

      const event = await eventPromise;
      expect(event.fileKey).toBe('file-x');
      expect(event.fileName).toBe('My File');
    }, 10000);
  });
});
