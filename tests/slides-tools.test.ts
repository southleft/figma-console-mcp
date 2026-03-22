/**
 * Slides Tools Tests
 *
 * Unit tests for all 15 Figma Slides tools.
 * Tests the registerSlidesTools() function with a mock McpServer and connector.
 */

import { registerSlidesTools } from "../src/core/slides-tools";

// ============================================================================
// Mock infrastructure
// ============================================================================

interface RegisteredTool {
	name: string;
	description: string;
	schema: any;
	handler: (args: any) => Promise<any>;
}

function createMockServer() {
	const tools: Record<string, RegisteredTool> = {};
	return {
		tool: jest.fn(
			(name: string, description: string, schema: any, handler: any) => {
				tools[name] = { name, description, schema, handler };
			}
		),
		_tools: tools,
		_getTool(name: string): RegisteredTool {
			return tools[name];
		},
	};
}

function createMockConnector(overrides: Record<string, jest.Mock> = {}) {
	return {
		listSlides: jest.fn().mockResolvedValue({
			success: true,
			data: [
				{ id: "1:1", name: "Slide 1", row: 0, col: 0, isSkippedSlide: false, childCount: 3 },
				{ id: "1:2", name: "Slide 2", row: 0, col: 1, isSkippedSlide: false, childCount: 2 },
			],
		}),
		getSlideContent: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:1", name: "Slide 1", children: [{ id: "1:3", type: "TEXT", name: "Title" }] },
		}),
		createSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:5", name: "Slide 5" },
		}),
		deleteSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { deleted: "1:3", name: "Slide 3" },
		}),
		duplicateSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { originalId: "1:1", newId: "1:6", name: "Slide 1 copy" },
		}),
		getSlideGrid: jest.fn().mockResolvedValue({
			success: true,
			data: [{ rowIndex: 0, rowId: "0:1", slides: [{ id: "1:1", name: "Slide 1", col: 0, isSkippedSlide: false }] }],
		}),
		reorderSlides: jest.fn().mockResolvedValue({
			success: true,
			data: { success: true, rows: 2 },
		}),
		setSlideTransition: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:1", transition: { style: "DISSOLVE", duration: 0.4, curve: "EASE_IN_AND_OUT" } },
		}),
		getSlideTransition: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:1", transition: { style: "DISSOLVE", duration: 0.4, curve: "EASE_IN_AND_OUT" } },
		}),
		setSlidesViewMode: jest.fn().mockResolvedValue({
			success: true,
			data: { mode: "grid" },
		}),
		getFocusedSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:2", name: "Slide 2" },
		}),
		focusSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { focused: "1:3", name: "Slide 3" },
		}),
		skipSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:1", isSkippedSlide: true },
		}),
		addTextToSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:10", text: "Hello World" },
		}),
		addShapeToSlide: jest.fn().mockResolvedValue({
			success: true,
			data: { id: "1:11", type: "RECTANGLE" },
		}),
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Slides Tools", () => {
	let server: ReturnType<typeof createMockServer>;
	let mockConnector: ReturnType<typeof createMockConnector>;

	beforeEach(() => {
		server = createMockServer();
		mockConnector = createMockConnector();

		registerSlidesTools(server as any, async () => mockConnector as any);
	});

	// ========================================================================
	// Registration
	// ========================================================================

	it("registers all 15 Slides tools", () => {
		expect(server.tool).toHaveBeenCalledTimes(15);
		const names = server.tool.mock.calls.map((c: any[]) => c[0]);
		expect(names).toContain("figma_list_slides");
		expect(names).toContain("figma_get_slide_content");
		expect(names).toContain("figma_get_slide_grid");
		expect(names).toContain("figma_get_slide_transition");
		expect(names).toContain("figma_get_focused_slide");
		expect(names).toContain("figma_create_slide");
		expect(names).toContain("figma_delete_slide");
		expect(names).toContain("figma_duplicate_slide");
		expect(names).toContain("figma_reorder_slides");
		expect(names).toContain("figma_set_slide_transition");
		expect(names).toContain("figma_skip_slide");
		expect(names).toContain("figma_add_text_to_slide");
		expect(names).toContain("figma_add_shape_to_slide");
		expect(names).toContain("figma_set_slides_view_mode");
		expect(names).toContain("figma_focus_slide");
	});

	// ========================================================================
	// figma_list_slides
	// ========================================================================

	describe("figma_list_slides", () => {
		it("returns slides array with count", async () => {
			const tool = server._getTool("figma_list_slides");
			const result = await tool.handler({});

			expect(mockConnector.listSlides).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.slides).toHaveLength(2);
			expect(parsed.count).toBe(2);
		});

		it("returns error when connector fails", async () => {
			mockConnector.listSlides.mockRejectedValue(
				new Error("LIST_SLIDES is only available in Slides files")
			);

			const tool = server._getTool("figma_list_slides");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("only available in Slides");
			expect(parsed.hint).toBeDefined();
		});
	});

	// ========================================================================
	// figma_get_slide_content
	// ========================================================================

	describe("figma_get_slide_content", () => {
		it("returns slide content tree", async () => {
			const tool = server._getTool("figma_get_slide_content");
			const result = await tool.handler({ slideId: "1:1" });

			expect(mockConnector.getSlideContent).toHaveBeenCalledWith({ slideId: "1:1" });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.getSlideContent.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_get_slide_content");
			const result = await tool.handler({ slideId: "99:99" });

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("Slide not found");
		});
	});

	// ========================================================================
	// figma_create_slide
	// ========================================================================

	describe("figma_create_slide", () => {
		it("creates slide without position", async () => {
			const tool = server._getTool("figma_create_slide");
			const result = await tool.handler({});

			expect(mockConnector.createSlide).toHaveBeenCalledWith({
				row: undefined,
				col: undefined,
			});
			expect(result.isError).toBeUndefined();
		});

		it("creates slide at specific position", async () => {
			const tool = server._getTool("figma_create_slide");
			const result = await tool.handler({ row: 1, col: 2 });

			expect(mockConnector.createSlide).toHaveBeenCalledWith({ row: 1, col: 2 });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.createSlide.mockRejectedValue(
				new Error("CREATE_SLIDE is only available in Slides files")
			);

			const tool = server._getTool("figma_create_slide");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_delete_slide
	// ========================================================================

	describe("figma_delete_slide", () => {
		it("deletes slide and returns confirmation", async () => {
			const tool = server._getTool("figma_delete_slide");
			const result = await tool.handler({ slideId: "1:3" });

			expect(mockConnector.deleteSlide).toHaveBeenCalledWith({ slideId: "1:3" });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.deleteSlide.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_delete_slide");
			const result = await tool.handler({ slideId: "99:99" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_duplicate_slide
	// ========================================================================

	describe("figma_duplicate_slide", () => {
		it("duplicates slide and returns IDs", async () => {
			const tool = server._getTool("figma_duplicate_slide");
			const result = await tool.handler({ slideId: "1:1" });

			expect(mockConnector.duplicateSlide).toHaveBeenCalledWith({ slideId: "1:1" });
			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.originalId).toBe("1:1");
			expect(parsed.data.newId).toBe("1:6");
		});

		it("returns error when slide not found", async () => {
			mockConnector.duplicateSlide.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_duplicate_slide");
			const result = await tool.handler({ slideId: "99:99" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_get_slide_grid
	// ========================================================================

	describe("figma_get_slide_grid", () => {
		it("returns grid structure", async () => {
			const tool = server._getTool("figma_get_slide_grid");
			const result = await tool.handler({});

			expect(mockConnector.getSlideGrid).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.getSlideGrid.mockRejectedValue(
				new Error("GET_SLIDE_GRID is only available in Slides files")
			);

			const tool = server._getTool("figma_get_slide_grid");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_reorder_slides
	// ========================================================================

	describe("figma_reorder_slides", () => {
		it("reorders slides with new grid", async () => {
			const tool = server._getTool("figma_reorder_slides");
			const result = await tool.handler({ grid: [["1:2", "1:1"], ["1:3"]] });

			expect(mockConnector.reorderSlides).toHaveBeenCalledWith({
				grid: [["1:2", "1:1"], ["1:3"]],
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.reorderSlides.mockRejectedValue(
				new Error("REORDER_SLIDES is only available in Slides files")
			);

			const tool = server._getTool("figma_reorder_slides");
			const result = await tool.handler({ grid: [["1:1"]] });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_set_slide_transition
	// ========================================================================

	describe("figma_set_slide_transition", () => {
		it("sets DISSOLVE transition with defaults", async () => {
			const tool = server._getTool("figma_set_slide_transition");
			const result = await tool.handler({
				slideId: "1:1",
				style: "DISSOLVE",
				duration: 0.4,
				curve: "EASE_IN_AND_OUT",
			});

			expect(mockConnector.setSlideTransition).toHaveBeenCalledWith({
				slideId: "1:1",
				style: "DISSOLVE",
				duration: 0.4,
				curve: "EASE_IN_AND_OUT",
			});
			expect(result.isError).toBeUndefined();
		});

		it("sets SMART_ANIMATE with custom duration", async () => {
			const tool = server._getTool("figma_set_slide_transition");
			const result = await tool.handler({
				slideId: "1:1",
				style: "SMART_ANIMATE",
				duration: 1.5,
				curve: "BOUNCY",
			});

			expect(mockConnector.setSlideTransition).toHaveBeenCalledWith({
				slideId: "1:1",
				style: "SMART_ANIMATE",
				duration: 1.5,
				curve: "BOUNCY",
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.setSlideTransition.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_set_slide_transition");
			const result = await tool.handler({
				slideId: "99:99",
				style: "DISSOLVE",
				duration: 0.4,
				curve: "EASE_IN_AND_OUT",
			});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_get_slide_transition
	// ========================================================================

	describe("figma_get_slide_transition", () => {
		it("returns transition settings", async () => {
			const tool = server._getTool("figma_get_slide_transition");
			const result = await tool.handler({ slideId: "1:1" });

			expect(mockConnector.getSlideTransition).toHaveBeenCalledWith({ slideId: "1:1" });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.getSlideTransition.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_get_slide_transition");
			const result = await tool.handler({ slideId: "99:99" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_set_slides_view_mode
	// ========================================================================

	describe("figma_set_slides_view_mode", () => {
		it("sets grid mode", async () => {
			const tool = server._getTool("figma_set_slides_view_mode");
			const result = await tool.handler({ mode: "grid" });

			expect(mockConnector.setSlidesViewMode).toHaveBeenCalledWith({ mode: "grid" });
			expect(result.isError).toBeUndefined();
		});

		it("sets single-slide mode", async () => {
			const tool = server._getTool("figma_set_slides_view_mode");
			const result = await tool.handler({ mode: "single-slide" });

			expect(mockConnector.setSlidesViewMode).toHaveBeenCalledWith({ mode: "single-slide" });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when connector fails", async () => {
			mockConnector.setSlidesViewMode.mockRejectedValue(
				new Error("SET_SLIDES_VIEW_MODE is only available in Slides files")
			);

			const tool = server._getTool("figma_set_slides_view_mode");
			const result = await tool.handler({ mode: "grid" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_get_focused_slide
	// ========================================================================

	describe("figma_get_focused_slide", () => {
		it("returns focused slide info", async () => {
			const tool = server._getTool("figma_get_focused_slide");
			const result = await tool.handler({});

			expect(mockConnector.getFocusedSlide).toHaveBeenCalled();
			expect(result.isError).toBeUndefined();
		});

		it("handles no focused slide", async () => {
			mockConnector.getFocusedSlide.mockResolvedValue({
				success: true,
				data: { focused: null },
			});

			const tool = server._getTool("figma_get_focused_slide");
			const result = await tool.handler({});

			expect(result.isError).toBeUndefined();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.data.focused).toBeNull();
		});

		it("returns error when connector fails", async () => {
			mockConnector.getFocusedSlide.mockRejectedValue(
				new Error("GET_FOCUSED_SLIDE is only available in Slides files")
			);

			const tool = server._getTool("figma_get_focused_slide");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_focus_slide
	// ========================================================================

	describe("figma_focus_slide", () => {
		it("focuses a slide", async () => {
			const tool = server._getTool("figma_focus_slide");
			const result = await tool.handler({ slideId: "1:3" });

			expect(mockConnector.focusSlide).toHaveBeenCalledWith({ slideId: "1:3" });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.focusSlide.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_focus_slide");
			const result = await tool.handler({ slideId: "99:99" });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_skip_slide
	// ========================================================================

	describe("figma_skip_slide", () => {
		it("marks slide as skipped", async () => {
			const tool = server._getTool("figma_skip_slide");
			const result = await tool.handler({ slideId: "1:1", skip: true });

			expect(mockConnector.skipSlide).toHaveBeenCalledWith({ slideId: "1:1", skip: true });
			expect(result.isError).toBeUndefined();
		});

		it("unmarks slide (includes in presentation)", async () => {
			const tool = server._getTool("figma_skip_slide");
			const result = await tool.handler({ slideId: "1:1", skip: false });

			expect(mockConnector.skipSlide).toHaveBeenCalledWith({ slideId: "1:1", skip: false });
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.skipSlide.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_skip_slide");
			const result = await tool.handler({ slideId: "99:99", skip: true });

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_add_text_to_slide
	// ========================================================================

	describe("figma_add_text_to_slide", () => {
		it("adds text with defaults", async () => {
			const tool = server._getTool("figma_add_text_to_slide");
			const result = await tool.handler({
				slideId: "1:1",
				text: "Hello World",
				x: 100,
				y: 100,
				fontSize: 24,
			});

			expect(mockConnector.addTextToSlide).toHaveBeenCalledWith({
				slideId: "1:1",
				text: "Hello World",
				x: 100,
				y: 100,
				fontSize: 24,
			});
			expect(result.isError).toBeUndefined();
		});

		it("adds text with custom position and size", async () => {
			const tool = server._getTool("figma_add_text_to_slide");
			const result = await tool.handler({
				slideId: "1:1",
				text: "Title",
				x: 50,
				y: 25,
				fontSize: 48,
			});

			expect(mockConnector.addTextToSlide).toHaveBeenCalledWith({
				slideId: "1:1",
				text: "Title",
				x: 50,
				y: 25,
				fontSize: 48,
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.addTextToSlide.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_add_text_to_slide");
			const result = await tool.handler({
				slideId: "99:99",
				text: "test",
				x: 100,
				y: 100,
				fontSize: 24,
			});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// figma_add_shape_to_slide
	// ========================================================================

	describe("figma_add_shape_to_slide", () => {
		it("adds rectangle with default color", async () => {
			const tool = server._getTool("figma_add_shape_to_slide");
			const result = await tool.handler({
				slideId: "1:1",
				shapeType: "RECTANGLE",
				x: 0,
				y: 0,
				width: 200,
				height: 100,
				fillColor: "#CCCCCC",
			});

			expect(mockConnector.addShapeToSlide).toHaveBeenCalledWith({
				slideId: "1:1",
				shapeType: "RECTANGLE",
				x: 0,
				y: 0,
				width: 200,
				height: 100,
				fillColor: "#CCCCCC",
			});
			expect(result.isError).toBeUndefined();
		});

		it("adds ellipse with custom color", async () => {
			const tool = server._getTool("figma_add_shape_to_slide");
			const result = await tool.handler({
				slideId: "1:1",
				shapeType: "ELLIPSE",
				x: 10,
				y: 20,
				width: 150,
				height: 150,
				fillColor: "#FF5733",
			});

			expect(mockConnector.addShapeToSlide).toHaveBeenCalledWith({
				slideId: "1:1",
				shapeType: "ELLIPSE",
				x: 10,
				y: 20,
				width: 150,
				height: 150,
				fillColor: "#FF5733",
			});
			expect(result.isError).toBeUndefined();
		});

		it("returns error when slide not found", async () => {
			mockConnector.addShapeToSlide.mockRejectedValue(
				new Error("Slide not found: 99:99")
			);

			const tool = server._getTool("figma_add_shape_to_slide");
			const result = await tool.handler({
				slideId: "99:99",
				shapeType: "RECTANGLE",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				fillColor: "#CCCCCC",
			});

			expect(result.isError).toBe(true);
		});
	});

	// ========================================================================
	// Edge cases & robustness
	// ========================================================================

	describe("error handling edge cases", () => {
		it("handles non-Error thrown objects gracefully", async () => {
			mockConnector.listSlides.mockRejectedValue("raw string error");

			const tool = server._getTool("figma_list_slides");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toBe("raw string error");
		});

		it("handles getDesktopConnector failure", async () => {
			const failServer = createMockServer();
			registerSlidesTools(
				failServer as any,
				async () => { throw new Error("No plugin connected"); }
			);

			const tool = failServer._getTool("figma_list_slides");
			const result = await tool.handler({});

			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.error).toContain("No plugin connected");
		});
	});
});
