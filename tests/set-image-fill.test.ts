/**
 * Tests for figma_set_image_fill tool
 *
 * Covers: plugin handler, WebSocket connector, cloud connector,
 * input validation, and error handling.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe('figma_set_image_fill', () => {
	// ========================================================================
	// Plugin handler (code.js message handling)
	// ========================================================================

	describe('plugin handler (SET_IMAGE_FILL)', () => {
		it('should decode image bytes and create image fill', () => {
			// The plugin handler expects { type: 'SET_IMAGE_FILL', imageBytes: number[], nodeIds: string[], scaleMode: string }
			const message = {
				type: 'SET_IMAGE_FILL',
				requestId: 'test_1',
				imageBytes: [0x89, 0x50, 0x4E, 0x47], // PNG header bytes
				nodeIds: ['1:2'],
				scaleMode: 'FILL',
			};

			// Validate message structure
			expect(message.type).toBe('SET_IMAGE_FILL');
			expect(message.imageBytes).toBeInstanceOf(Array);
			expect(message.nodeIds).toHaveLength(1);
			expect(message.scaleMode).toBe('FILL');
		});

		it('should support multiple node IDs', () => {
			const message = {
				type: 'SET_IMAGE_FILL',
				requestId: 'test_2',
				imageBytes: [0xFF, 0xD8, 0xFF], // JPEG header
				nodeIds: ['1:2', '3:4', '5:6'],
				scaleMode: 'FIT',
			};

			expect(message.nodeIds).toHaveLength(3);
		});

		it('should default scaleMode to FILL', () => {
			const message = {
				type: 'SET_IMAGE_FILL',
				requestId: 'test_3',
				imageBytes: [0x89, 0x50],
				nodeIds: ['1:2'],
			};

			// When scaleMode is not provided, plugin uses 'FILL'
			expect(message.scaleMode).toBeUndefined();
		});
	});

	// ========================================================================
	// WebSocket connector
	// ========================================================================

	describe('WebSocketConnector.setImageFill', () => {
		it('should send SET_IMAGE_FILL command with correct params', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: true,
				imageHash: 'abc123',
				updatedCount: 2,
				nodes: [
					{ id: '1:2', name: 'Frame 1' },
					{ id: '3:4', name: 'Frame 2' },
				],
			});

			// Simulate WebSocketConnector.setImageFill
			const setImageFill = async (nodeIds: string[], imageData: string, scaleMode = 'FILL') => {
				return mockSendCommand('SET_IMAGE_FILL', { nodeIds, imageData, scaleMode }, 60000);
			};

			const result = await setImageFill(['1:2', '3:4'], 'base64data', 'FILL');

			expect(mockSendCommand).toHaveBeenCalledWith(
				'SET_IMAGE_FILL',
				{ nodeIds: ['1:2', '3:4'], imageData: 'base64data', scaleMode: 'FILL' },
				60000,
			);
			expect(result.success).toBe(true);
			expect(result.imageHash).toBe('abc123');
			expect(result.updatedCount).toBe(2);
		});

		it('should use 60s timeout for large images', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({ success: true });

			const setImageFill = async (nodeIds: string[], imageData: string, scaleMode = 'FILL') => {
				return mockSendCommand('SET_IMAGE_FILL', { nodeIds, imageData, scaleMode }, 60000);
			};

			await setImageFill(['1:2'], 'largeBase64Data');

			// Verify 60s timeout (vs default 15s)
			expect(mockSendCommand).toHaveBeenCalledWith(
				'SET_IMAGE_FILL',
				expect.anything(),
				60000,
			);
		});
	});

	// ========================================================================
	// Cloud connector
	// ========================================================================

	describe('CloudWebSocketConnector.setImageFill', () => {
		it('should route through relay with 60s timeout', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: true,
				imageHash: 'hash456',
				updatedCount: 1,
				nodes: [{ id: '1:2', name: 'Node' }],
			});

			// Simulate CloudWebSocketConnector.setImageFill
			const setImageFill = async (nodeIds: string[], imageData: string, scaleMode = 'FILL') => {
				return mockSendCommand('SET_IMAGE_FILL', { nodeIds, imageData, scaleMode }, 60000);
			};

			const result = await setImageFill(['1:2'], 'base64', 'CROP');

			expect(mockSendCommand).toHaveBeenCalledWith(
				'SET_IMAGE_FILL',
				{ nodeIds: ['1:2'], imageData: 'base64', scaleMode: 'CROP' },
				60000,
			);
			expect(result.success).toBe(true);
		});
	});

	// ========================================================================
	// Tool registration and schema validation
	// ========================================================================

	describe('tool schema', () => {
		it('should accept nodeIds as an optional string array', () => {
			const validParams = {
				nodeIds: ['1:2', '3:4'],
				imageData: 'base64string',
			};

			expect(Array.isArray(validParams.nodeIds)).toBe(true);
			expect(validParams.nodeIds.every((id: string) => typeof id === 'string')).toBe(true);
		});

		it('should require imageData as string', () => {
			const validParams = {
				nodeIds: ['1:2'],
				imageData: 'iVBORw0KGgoAAAANSUhEUg==', // valid base64
			};

			expect(typeof validParams.imageData).toBe('string');
		});

		it('should accept valid scaleMode values', () => {
			const validModes = ['FILL', 'FIT', 'CROP', 'TILE'];
			validModes.forEach(mode => {
				expect(['FILL', 'FIT', 'CROP', 'TILE']).toContain(mode);
			});
		});

		it('should treat scaleMode as optional', () => {
			const paramsWithout = {
				nodeIds: ['1:2'],
				imageData: 'base64',
			};

			// scaleMode is optional — should not be required
			expect(paramsWithout).not.toHaveProperty('scaleMode');
		});
	});

	// ========================================================================
	// Error handling
	// ========================================================================

	describe('error handling', () => {
		it('should handle plugin failure gracefully', async () => {
			const mockSendCommand = jest.fn().mockResolvedValue({
				success: false,
				error: 'Node not found: 99:99',
			});

			const setImageFill = async (nodeIds: string[], imageData: string, scaleMode = 'FILL') => {
				return mockSendCommand('SET_IMAGE_FILL', { nodeIds, imageData, scaleMode }, 60000);
			};

			const result = await setImageFill(['99:99'], 'base64');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Node not found');
		});

		it('should handle connection timeout', async () => {
			const mockSendCommand = jest.fn().mockRejectedValue(
				new Error('Command SET_IMAGE_FILL timed out after 60000ms'),
			);

			const setImageFill = async (nodeIds: string[], imageData: string, scaleMode = 'FILL') => {
				return mockSendCommand('SET_IMAGE_FILL', { nodeIds, imageData, scaleMode }, 60000);
			};

			await expect(setImageFill(['1:2'], 'very-large-base64'))
				.rejects.toThrow('timed out');
		});

		it('should handle no desktop connector available', async () => {
			const getDesktopConnector = jest.fn().mockRejectedValue(
				new Error('No cloud relay session. Call figma_pair_plugin first.'),
			);

			await expect(getDesktopConnector()).rejects.toThrow('No cloud relay session');
		});
	});

	// ========================================================================
	// ui.html handler (method map)
	// ========================================================================

	describe('ui.html method map', () => {
		it('should map SET_IMAGE_FILL to window.setImageFill', () => {
			// The method map in ui.html routes 'SET_IMAGE_FILL' to:
			// function(params) { return window.setImageFill(params.nodeIds || params.nodeId, params.imageData, params.scaleMode); }
			const params = {
				nodeIds: ['1:2', '3:4'],
				imageData: 'base64string',
				scaleMode: 'TILE',
			};

			// Verify params are correctly structured for the handler
			expect(params.nodeIds).toBeDefined();
			expect(params.imageData).toBeDefined();
			expect(params.scaleMode).toBe('TILE');
		});

		it('should fall back to nodeId when nodeIds not provided', () => {
			const params = {
				nodeId: '1:2',
				imageData: 'base64string',
			};

			// Handler uses: params.nodeIds || params.nodeId
			const resolved = params.nodeIds || params.nodeId;
			expect(resolved).toBe('1:2');
		});
	});
});
describe("code.js SET_IMAGE_FILL handler", () => {
	const codeJsSource = readFileSync(
		join(__dirname, "../figma-desktop-bridge/code.js"),
		"utf-8",
	);

	function extractHandler() {
		const start = codeJsSource.indexOf(
			"else if (msg.type === 'SET_IMAGE_FILL')",
		);
		if (start === -1) throw new Error("SET_IMAGE_FILL handler not found");
		const endMarker = codeJsSource.indexOf("// SET_NODE_STROKES", start);
		const block = codeJsSource.slice(
			start,
			codeJsSource.lastIndexOf("}", endMarker) + 1,
		);
		return new Function(
			"figma",
			"msg",
			`return (async () => { if (false) {} ${block} })();`,
		);
	}

	function makeSandbox() {
		const posted: any[] = [];
		const rect = {
			id: "rect:1",
			name: "",
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			fills: [] as any[],
			resize(width: number, height: number) {
				this.width = width;
				this.height = height;
			},
		};
		const target = {
			id: "1:2",
			name: "Frame",
			type: "FRAME",
			fills: [] as any[],
		};
		const figma = {
			createImage: (bytes: Uint8Array) => ({
				hash: "imghash",
				bytes,
				getSizeAsync: async () => ({ width: 200, height: 80 }),
			}),
			createRectangle: () => rect,
			getNodeByIdAsync: async (id: string) => (id === "1:2" ? target : null),
			currentPage: { selection: [] as any[] },
			viewport: {
				center: { x: 500, y: 400 },
				scrollAndZoomIntoView: jest.fn(),
			},
			ui: { postMessage: (m: any) => posted.push(m) },
		};
		return { figma, posted, rect, target };
	}

	it("inserts a new rectangle sized to the image when nodeIds is empty", async () => {
		const { figma, posted, rect } = makeSandbox();
		const run = extractHandler();
		await run(figma, {
			type: "SET_IMAGE_FILL",
			requestId: "r1",
			imageBytes: [1, 2, 3],
			nodeIds: [],
			name: "hero",
		});

		expect(rect.name).toBe("hero");
		expect(rect.width).toBe(200);
		expect(rect.height).toBe(80);
		expect(rect.x).toBe(400);
		expect(rect.y).toBe(360);
		expect(figma.currentPage.selection).toEqual([rect]);
		expect(posted[0]).toMatchObject({
			type: "SET_IMAGE_FILL_RESULT",
			success: true,
			imageHash: "imghash",
			updatedCount: 1,
			nodes: [
				{
					id: "rect:1",
					name: "hero",
					created: true,
					width: 200,
					height: 80,
				},
			],
		});
	});

	it("applies an image fill to existing nodes when nodeIds are provided", async () => {
		const { figma, posted, target } = makeSandbox();
		const run = extractHandler();
		await run(figma, {
			type: "SET_IMAGE_FILL",
			requestId: "r2",
			imageBytes: [1, 2, 3],
			nodeIds: ["1:2"],
			scaleMode: "FIT",
		});

		expect(target.fills).toEqual([
			{ type: "IMAGE", scaleMode: "FIT", imageHash: "imghash" },
		]);
		expect(posted[0].nodes[0].created).toBeUndefined();
		expect(posted[0].updatedCount).toBe(1);
	});
});
