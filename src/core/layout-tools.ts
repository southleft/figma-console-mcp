/**
 * Layout tool: auto layout and grid layout on a frame in one call.
 *
 * Covers what used to need figma_execute: direction, gaps, padding,
 * alignment (including SPACE_EVENLY / SPACE_AROUND), wrap, sizing, and
 * Figma's grid layout (tracks written CSS-style, gaps, auto rows, auto flow,
 * and child placement with spans).
 *
 * Builds a Plugin API script and runs it through executeCodeViaUI, so no
 * Desktop Bridge plugin change (or re-import) is needed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createChildLogger } from "./logger.js";

const logger = createChildLogger({ component: "layout-tools" });

export interface GridTrack {
	type: "FLEX" | "FIXED" | "HUG";
	value?: number;
}

/**
 * Parse grid tracks written CSS-style: "1fr 2fr 120px", "repeat(3, 1fr)",
 * "auto 1fr" (auto = hug content), bare numbers are pixels. A number input
 * means that many equal 1fr tracks.
 */
export function parseGridTracks(input: string | number): GridTrack[] {
	if (typeof input === "number") {
		if (!Number.isInteger(input) || input < 1) throw new Error(`Track count must be a positive whole number, got ${input}`);
		return Array.from({ length: input }, () => ({ type: "FLEX" as const, value: 1 }));
	}
	const expanded = input.replace(/repeat\(\s*(\d+)\s*,\s*([^)]+)\)/gi, (_, n: string, body: string) =>
		Array.from({ length: Number(n) }, () => body.trim()).join(" "),
	);
	const tokens = expanded.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) throw new Error("No grid tracks given");
	return tokens.map((token) => {
		const t = token.toLowerCase();
		if (t === "auto" || t === "hug" || t === "fit-content") return { type: "HUG" as const };
		const fr = /^(\d*\.?\d+)?fr$/.exec(t);
		if (fr) return { type: "FLEX" as const, value: fr[1] ? Number(fr[1]) : 1 };
		const px = /^(\d*\.?\d+)(px)?$/.exec(t);
		if (px) return { type: "FIXED" as const, value: Number(px[1]) };
		throw new Error(`Can't read grid track "${token}". Use Nfr, Npx, auto, or repeat(n, …)`);
	});
}

export const SET_LAYOUT_BODY = `
const node = await figma.getNodeByIdAsync(P.nodeId);
if (!node) throw new Error('Node not found: ' + P.nodeId);
if (!('layoutMode' in node)) throw new Error(node.type + ' nodes have no layout. Use a frame, component or instance.');
if (P.mode) node.layoutMode = P.mode;
const mode = node.layoutMode;
const isGrid = mode === 'GRID';
const isStack = mode === 'HORIZONTAL' || mode === 'VERTICAL';
const needs = (what, ok) => { if (!ok) throw new Error(what + ' needs ' + (what.startsWith('grid') ? 'mode GRID' : 'mode HORIZONTAL or VERTICAL') + ' (this frame is ' + mode + ').'); };

if (P.padding !== undefined) {
  needs('padding', mode !== 'NONE');
  const p = typeof P.padding === 'number' ? { top: P.padding, right: P.padding, bottom: P.padding, left: P.padding } : P.padding;
  if (p.top !== undefined) node.paddingTop = p.top;
  if (p.right !== undefined) node.paddingRight = p.right;
  if (p.bottom !== undefined) node.paddingBottom = p.bottom;
  if (p.left !== undefined) node.paddingLeft = p.left;
}
if (P.wrap !== undefined) { needs('wrap', isStack); node.layoutWrap = P.wrap ? 'WRAP' : 'NO_WRAP'; }
if (P.gap !== undefined) {
  if (isGrid) { node.gridRowGap = P.gap; node.gridColumnGap = P.gap; }
  else { needs('gap', isStack); node.itemSpacing = P.gap; }
}
if (P.counterAxisGap !== undefined) { needs('counterAxisGap', isStack); node.counterAxisSpacing = P.counterAxisGap; }
if (P.primaryAlign !== undefined) { needs('primaryAlign', isStack); node.primaryAxisAlignItems = P.primaryAlign; }
if (P.counterAlign !== undefined) { needs('counterAlign', isStack); node.counterAxisAlignItems = P.counterAlign; }
if (P.alignContent !== undefined) { needs('alignContent', isStack); node.counterAxisAlignContent = P.alignContent; }
if (P.reverseZIndex !== undefined) { needs('reverseZIndex', isStack); node.itemReverseZIndex = P.reverseZIndex; }

if (P.grid) {
  needs('grid', isGrid);
  const g = P.grid;
  const applyTracks = (tracks, countKey, sizesKey) => {
    node[countKey] = tracks.length;
    tracks.forEach((t, i) => {
      const s = node[sizesKey][i];
      s.type = t.type;
      if (t.value !== undefined) s.value = t.value;
    });
  };
  if (g.autoRows === false || (g.rows && g.autoRows !== true)) { if (node.gridAutoTracks === 'ROWS') node.gridAutoTracks = 'NONE'; }
  if (g.columns) applyTracks(g.columns, 'gridColumnCount', 'gridColumnSizes');
  if (g.rows) applyTracks(g.rows, 'gridRowCount', 'gridRowSizes');
  if (g.autoRows === true) node.gridAutoTracks = 'ROWS';
  if (g.autoFlow !== undefined) node.gridItemsPositioning = g.autoFlow ? 'ROW_AUTO_FLOW' : 'MANUAL';
  if (g.rowGap !== undefined) node.gridRowGap = g.rowGap;
  if (g.columnGap !== undefined) node.gridColumnGap = g.columnGap;
}

// Sizing last: HUG and FILL depend on the layout set above.
if (P.width !== undefined || P.height !== undefined) node.resize(P.width !== undefined ? P.width : node.width, P.height !== undefined ? P.height : node.height);
if (P.horizontalSizing !== undefined) node.layoutSizingHorizontal = P.horizontalSizing;
if (P.verticalSizing !== undefined) node.layoutSizingVertical = P.verticalSizing;

const children = [];
for (const c of P.children || []) {
  const child = await figma.getNodeByIdAsync(c.nodeId);
  if (!child) throw new Error('Child not found: ' + c.nodeId);
  if (child.parent !== node) {
    if (isGrid && c.row !== undefined && c.column !== undefined && node.gridItemsPositioning !== 'ROW_AUTO_FLOW') node.appendChildAt(child, c.row, c.column);
    else node.appendChild(child);
  } else if (c.row !== undefined || c.column !== undefined) {
    needs('grid placement (row, column)', isGrid);
    if (node.gridItemsPositioning === 'ROW_AUTO_FLOW') throw new Error('This grid places children automatically (autoFlow). Turn autoFlow off to place ' + c.nodeId + ' by row and column.');
    child.setGridChildPosition(c.row !== undefined ? c.row : child.gridRowAnchorIndex, c.column !== undefined ? c.column : child.gridColumnAnchorIndex);
  }
  if (c.rowSpan !== undefined) { needs('grid rowSpan', isGrid); child.gridRowSpan = c.rowSpan; }
  if (c.columnSpan !== undefined) { needs('grid columnSpan', isGrid); child.gridColumnSpan = c.columnSpan; }
  if (c.horizontalAlign !== undefined) { needs('grid horizontalAlign', isGrid); child.gridChildHorizontalAlign = c.horizontalAlign; }
  if (c.verticalAlign !== undefined) { needs('grid verticalAlign', isGrid); child.gridChildVerticalAlign = c.verticalAlign; }
  if (c.positioning !== undefined) child.layoutPositioning = c.positioning;
  if (c.horizontalSizing !== undefined) child.layoutSizingHorizontal = c.horizontalSizing;
  if (c.verticalSizing !== undefined) child.layoutSizingVertical = c.verticalSizing;
  const info = { nodeId: child.id, name: child.name };
  if (isGrid) Object.assign(info, { row: child.gridRowAnchorIndex, column: child.gridColumnAnchorIndex, rowSpan: child.gridRowSpan, columnSpan: child.gridColumnSpan });
  children.push(info);
}

const out = { nodeId: node.id, name: node.name, mode: node.layoutMode, width: node.width, height: node.height };
if ('layoutSizingHorizontal' in node) Object.assign(out, { horizontalSizing: node.layoutSizingHorizontal, verticalSizing: node.layoutSizingVertical });
if (node.layoutMode !== 'NONE') out.padding = { top: node.paddingTop, right: node.paddingRight, bottom: node.paddingBottom, left: node.paddingLeft };
if (isStack) Object.assign(out, { gap: node.itemSpacing, wrap: node.layoutWrap === 'WRAP', counterAxisGap: node.layoutWrap === 'WRAP' ? node.counterAxisSpacing : undefined, primaryAlign: node.primaryAxisAlignItems, counterAlign: node.counterAxisAlignItems, alignContent: node.layoutWrap === 'WRAP' ? node.counterAxisAlignContent : undefined });
// Built from the track sizes: gridColumnSizingCSS can lag a write within the same script.
const css = (sizes) => sizes.map(t => t.type === 'FIXED' ? t.value + 'px' : t.type === 'HUG' ? 'auto' : (t.value === undefined ? 1 : t.value) + 'fr').join(' ');
if (node.layoutMode === 'GRID') out.grid = { columns: css(node.gridColumnSizes), rows: css(node.gridRowSizes), columnCount: node.gridColumnCount, rowCount: node.gridRowCount, columnGap: node.gridColumnGap, rowGap: node.gridRowGap, autoRows: node.gridAutoTracks === 'ROWS', autoFlow: node.gridItemsPositioning === 'ROW_AUTO_FLOW' };
if (children.length) out.children = children;
return out;
`;

export function layoutScript(payload: unknown): string {
	return `const P = ${JSON.stringify(payload)};\n${SET_LAYOUT_BODY}`;
}

const sizing = z.enum(["FIXED", "HUG", "FILL"]);
const gridAlign = z.enum(["MIN", "CENTER", "MAX", "AUTO"]);

export function registerLayoutTools(server: McpServer, getDesktopConnector: () => Promise<any>): void {
	server.tool(
		"figma_set_layout",
		"Set a frame's auto layout or grid layout in one call, and place its children. Auto layout: mode HORIZONTAL or VERTICAL, gap, padding, primaryAlign (MIN, CENTER, MAX, SPACE_BETWEEN, SPACE_EVENLY, SPACE_AROUND), counterAlign, wrap with counterAxisGap and alignContent, and sizing (FIXED, HUG, FILL). Grid: mode GRID with tracks written CSS-style (grid.columns: '240px 1fr 1fr', 'repeat(3, 1fr)', 'auto 1fr', or a count), gaps, autoRows, autoFlow, and per-child row, column, spans and alignment. Only the fields you pass change. Returns the resulting layout, with grid tracks as CSS. Requires Desktop Bridge.",
		{
			nodeId: z.string().describe("Frame, component or instance to lay out"),
			mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL", "GRID"]).optional(),
			gap: z.number().min(0).optional().describe("Space between items. On a grid, sets both row and column gaps"),
			counterAxisGap: z.number().min(0).optional().describe("Space between wrapped rows or columns (wrap only)"),
			padding: z
				.union([
					z.number().min(0),
					z.object({ top: z.number().min(0).optional(), right: z.number().min(0).optional(), bottom: z.number().min(0).optional(), left: z.number().min(0).optional() }),
				])
				.optional()
				.describe("One number for all sides, or {top, right, bottom, left}"),
			primaryAlign: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN", "SPACE_EVENLY", "SPACE_AROUND"]).optional(),
			counterAlign: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
			wrap: z.boolean().optional().describe("Wrap children onto new lines (HORIZONTAL or VERTICAL)"),
			alignContent: z.enum(["AUTO", "SPACE_BETWEEN"]).optional().describe("How wrapped lines are spaced"),
			reverseZIndex: z.boolean().optional().describe("Stack earlier children on top (canvas stacking)"),
			width: z.number().positive().optional(),
			height: z.number().positive().optional(),
			horizontalSizing: sizing.optional(),
			verticalSizing: sizing.optional(),
			grid: z
				.object({
					columns: z.union([z.string(), z.number().int().min(1)]).optional().describe("'1fr 2fr 120px', 'repeat(4, 1fr)', 'auto 1fr' (auto = hug), or a count of equal columns"),
					rows: z.union([z.string(), z.number().int().min(1)]).optional().describe("Same format as columns. Leave out with autoRows"),
					columnGap: z.number().min(0).optional(),
					rowGap: z.number().min(0).optional(),
					autoRows: z.boolean().optional().describe("Add and remove rows automatically as children are added"),
					autoFlow: z.boolean().optional().describe("Place children in order, left to right then top to bottom, instead of by row and column"),
				})
				.optional(),
			children: z
				.array(
					z.object({
						nodeId: z.string().describe("A child, or a node to move into this frame"),
						row: z.number().int().min(0).optional().describe("Grid row (0-based)"),
						column: z.number().int().min(0).optional().describe("Grid column (0-based)"),
						rowSpan: z.number().int().min(1).optional(),
						columnSpan: z.number().int().min(1).optional(),
						horizontalAlign: gridAlign.optional().describe("Alignment inside its grid cell"),
						verticalAlign: gridAlign.optional().describe("Alignment inside its grid cell"),
						horizontalSizing: sizing.optional(),
						verticalSizing: sizing.optional(),
						positioning: z.enum(["AUTO", "ABSOLUTE"]).optional().describe("ABSOLUTE takes the child out of the layout flow"),
					}),
				)
				.optional(),
			fileKey: z
				.string()
				.optional()
				.describe("Local Mode only. Run against this specific connected file instead of the active file. Get connected fileKeys from figma_list_open_files. Rejected in Cloud Mode, which pairs with a single plugin instance."),
		},
		async ({ fileKey, grid, ...rest }) => {
			try {
				const payload: Record<string, unknown> = { ...rest };
				if (grid) {
					payload.grid = {
						...grid,
						columns: grid.columns !== undefined ? parseGridTracks(grid.columns) : undefined,
						rows: grid.rows !== undefined ? parseGridTracks(grid.rows) : undefined,
					};
				}
				const connector = await getDesktopConnector();
				const result = await connector.executeCodeViaUI(layoutScript(payload), 30000, fileKey);
				if (!result?.success) throw new Error(result?.error || "Failed to set layout");
				return { content: [{ type: "text" as const, text: JSON.stringify(result.result) }] };
			} catch (error) {
				logger.error({ error }, "figma_set_layout failed");
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
		},
	);
}
