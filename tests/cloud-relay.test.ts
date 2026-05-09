/**
 * Tests for Cloud Write Relay
 *
 * Tests the pairing code generation, CloudWebSocketConnector,
 * and PluginRelayDO behavior in isolation.
 */

import { generatePairingCode } from '../src/core/cloud-websocket-relay';
import { CloudWebSocketConnector } from '../src/core/cloud-websocket-connector';

// ============================================================================
// Pairing Code Generation
// ============================================================================

describe('generatePairingCode', () => {
	it('returns a 6-character string', () => {
		const code = generatePairingCode();
		expect(code).toHaveLength(6);
	});

	it('contains only allowed characters (no 0/O/1/I)', () => {
		const allowed = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;
		for (let i = 0; i < 50; i++) {
			const code = generatePairingCode();
			expect(code).toMatch(allowed);
		}
	});

	it('generates unique codes', () => {
		const codes = new Set<string>();
		for (let i = 0; i < 100; i++) {
			codes.add(generatePairingCode());
		}
		// With 6 chars from 30-char alphabet, collision in 100 is astronomically unlikely
		expect(codes.size).toBeGreaterThanOrEqual(95);
	});
});

// ============================================================================
// CloudWebSocketConnector
// ============================================================================

describe('CloudWebSocketConnector', () => {
	function createMockStub(options: {
		connected?: boolean;
		commandResult?: any;
		commandError?: string;
	} = {}) {
		const { connected = true, commandResult, commandError } = options;

		return {
			fetch: jest.fn(async (input: RequestInfo, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;

				if (url.includes('/relay/status')) {
					return new Response(JSON.stringify({ connected }), {
						headers: { 'Content-Type': 'application/json' },
					});
				}

				if (url.includes('/relay/command')) {
					if (commandError) {
						return new Response(JSON.stringify({ error: commandError }), {
							headers: { 'Content-Type': 'application/json' },
						});
					}
					return new Response(JSON.stringify({ result: commandResult ?? { success: true } }), {
						headers: { 'Content-Type': 'application/json' },
					});
				}

				return new Response('Not found', { status: 404 });
			}),
		};
	}

	describe('initialize', () => {
		it('succeeds when plugin is connected', async () => {
			const stub = createMockStub({ connected: true });
			const connector = new CloudWebSocketConnector(stub);
			await expect(connector.initialize()).resolves.toBeUndefined();
		});

		it('throws when no plugin is connected', async () => {
			const stub = createMockStub({ connected: false });
			const connector = new CloudWebSocketConnector(stub);
			await expect(connector.initialize()).rejects.toThrow('No plugin connected');
		});
	});

	describe('getTransportType', () => {
		it('returns websocket', () => {
			const stub = createMockStub();
			const connector = new CloudWebSocketConnector(stub);
			expect(connector.getTransportType()).toBe('websocket');
		});
	});

	describe('command forwarding', () => {
		it('sends EXECUTE_CODE to relay', async () => {
			const stub = createMockStub({ commandResult: { output: 'hello' } });
			const connector = new CloudWebSocketConnector(stub);

			const result = await connector.executeInPluginContext('console.log("hi")');
			expect(result).toEqual({ output: 'hello' });

			expect(stub.fetch).toHaveBeenCalledWith(
				'https://relay/relay/command',
				expect.objectContaining({
					method: 'POST',
					body: expect.stringContaining('EXECUTE_CODE'),
				}),
			);
		});

		it('sends UPDATE_VARIABLE to relay', async () => {
			const stub = createMockStub({ commandResult: { success: true, variable: { id: 'v1' } } });
			const connector = new CloudWebSocketConnector(stub);

			const result = await connector.updateVariable('v1', 'm1', '#ff0000');
			expect(result).toEqual({ success: true, variable: { id: 'v1' } });

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('UPDATE_VARIABLE')
			);
			expect(call).toBeDefined();
			const body = JSON.parse(call![1].body);
			expect(body.method).toBe('UPDATE_VARIABLE');
			expect(body.params.variableId).toBe('v1');
		});

		it('sends CREATE_VARIABLE with options', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);

			await connector.createVariable('my-var', 'col1', 'COLOR', {
				description: 'A color var',
				valuesByMode: { m1: '#000' },
			});

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('CREATE_VARIABLE')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.name).toBe('my-var');
			expect(body.params.description).toBe('A color var');
		});

		it('sends DELETE_VARIABLE to relay', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.deleteVariable('v1');

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('DELETE_VARIABLE')
			);
			expect(call).toBeDefined();
		});

		it('sends RESIZE_NODE to relay', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.resizeNode('node1', 200, 100, true);

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('RESIZE_NODE')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.nodeId).toBe('node1');
			expect(body.params.width).toBe(200);
			expect(body.params.height).toBe(100);
		});

		it('sends CAPTURE_SCREENSHOT to relay', async () => {
			const stub = createMockStub({ commandResult: { image: 'base64...' } });
			const connector = new CloudWebSocketConnector(stub);
			const result = await connector.captureScreenshot('node1', { format: 'PNG', scale: 2 });
			expect(result).toEqual({ image: 'base64...' });
		});

		it('sends INSTANTIATE_COMPONENT with options', async () => {
			const stub = createMockStub({ commandResult: { success: true, instance: {} } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.instantiateComponent('comp-key', {
				position: { x: 0, y: 0 },
				parentId: 'frame1',
			});

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('INSTANTIATE_COMPONENT')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.componentKey).toBe('comp-key');
			expect(body.params.parentId).toBe('frame1');
		});

		it('sends GET_CANVAS_GRID to relay', async () => {
			const stub = createMockStub({ commandResult: { success: true, data: { rows: [] } } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.getCanvasGrid();

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('GET_CANVAS_GRID')
			);
			expect(call).toBeDefined();
		});

		it('sends FOCUS_ASSET with nodeId', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.focusAsset({ nodeId: '1:2' });

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('FOCUS_ASSET')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.nodeId).toBe('1:2');
		});

		it('sends CREATE_BUZZ_FRAME with placement options', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.createBuzzFrame({
				row: 0,
				col: 1,
				name: 'Promo Asset',
				width: 1080,
				height: 1080,
			});

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('CREATE_BUZZ_FRAME')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.row).toBe(0);
			expect(body.params.col).toBe(1);
			expect(body.params.name).toBe('Promo Asset');
		});

		it('sends GET_BUZZ_TEXT_CONTENT to relay', async () => {
			const stub = createMockStub({ commandResult: { success: true, data: { fields: [] } } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.getBuzzTextContent({ nodeId: '1:1' });

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('GET_BUZZ_TEXT_CONTENT')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.nodeId).toBe('1:1');
		});
	});

	describe('error handling', () => {
		it('throws on relay error response', async () => {
			const stub = createMockStub({ commandError: 'Plugin disconnected' });
			const connector = new CloudWebSocketConnector(stub);

			await expect(connector.executeInPluginContext('test'))
				.rejects.toThrow('Plugin disconnected');
		});

		it('throws on relay timeout error', async () => {
			const stub = createMockStub({ commandError: 'Command EXECUTE_CODE timed out after 7000ms' });
			const connector = new CloudWebSocketConnector(stub);

			await expect(connector.executeInPluginContext('test'))
				.rejects.toThrow('timed out');
		});
	});

	describe('variable operations', () => {
		it('renameVariable passes through oldName', async () => {
			const stub = createMockStub({
				commandResult: { success: true, variable: { oldName: 'old', name: 'new' } },
			});
			const connector = new CloudWebSocketConnector(stub);
			const result = await connector.renameVariable('v1', 'new');
			expect(result.oldName).toBe('old');
		});

		it('renameMode passes through oldName', async () => {
			const stub = createMockStub({
				commandResult: { success: true, collection: { oldName: 'Light', name: 'Dark' } },
			});
			const connector = new CloudWebSocketConnector(stub);
			const result = await connector.renameMode('col1', 'm1', 'Dark');
			expect(result.oldName).toBe('Light');
		});

		it('refreshVariables uses long timeout', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.refreshVariables();

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('REFRESH_VARIABLES')
			);
			const body = JSON.parse(call![1].body);
			expect(body.timeoutMs).toBe(300000);
		});
	});

	describe('collection operations', () => {
		it('createVariableCollection passes options', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.createVariableCollection('Colors', {
				initialModeName: 'Light',
				additionalModes: ['Dark'],
			});

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('CREATE_VARIABLE_COLLECTION')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.name).toBe('Colors');
			expect(body.params.initialModeName).toBe('Light');
		});
	});

	describe('node operations', () => {
		it('setTextContent passes font options', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.setTextContent('node1', 'Hello', { fontSize: 16, fontFamily: 'Inter' });

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('SET_TEXT_CONTENT')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.text).toBe('Hello');
			expect(body.params.fontSize).toBe(16);
			expect(body.params.fontFamily).toBe('Inter');
		});

		it('setNodeStrokes passes strokeWeight', async () => {
			const stub = createMockStub({ commandResult: { success: true } });
			const connector = new CloudWebSocketConnector(stub);
			await connector.setNodeStrokes('node1', [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], 2);

			const call = stub.fetch.mock.calls.find(
				(c: any[]) => typeof c[1]?.body === 'string' && c[1].body.includes('SET_NODE_STROKES')
			);
			const body = JSON.parse(call![1].body);
			expect(body.params.strokeWeight).toBe(2);
		});

		it('clearFrameCache is a no-op', () => {
			const stub = createMockStub();
			const connector = new CloudWebSocketConnector(stub);
			expect(() => connector.clearFrameCache()).not.toThrow();
		});
	});
});
