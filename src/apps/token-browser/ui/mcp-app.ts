import {
	App,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tokenData: { variables: any[]; collections: any[] } | null = null;
let searchTerm = "";
const expandedCollections = new Set<string>();
let activeTab: "all" | "colors" | "numbers" | "strings" = "all";

const appContainer = document.getElementById("app")!;
const toast = document.getElementById("toast")!;
const app = new App({ name: "TokenBrowserApp", version: "1.0.0" });

// ---------------------------------------------------------------------------
// SDK handlers (registered before connect)
// ---------------------------------------------------------------------------

// When a new tool result arrives (e.g., user requested tokens for a different file),
// refresh the data. This handles the case where Claude Desktop reuses the cached
// UI iframe — the connect() already resolved, so we need ontoolresult to trigger refresh.
app.ontoolresult = () => {
	// New tool call detected — fetch fresh data for the new file
	fetchData();
};

app.onhostcontextchanged = (ctx) => {
	applyDocumentTheme(ctx);
	applyHostStyleVariables(ctx);
	applyHostFonts(ctx);
};

app.onteardown = async () => ({});

// ---------------------------------------------------------------------------
// Connect + fetch data via app-only refresh tool
// ---------------------------------------------------------------------------

app
	.connect()
	.then(async () => {
		const ctx = await app.getHostContext();
		if (ctx) {
			applyDocumentTheme(ctx);
			applyHostStyleVariables(ctx);
			applyHostFonts(ctx);
		}
		// Fetch full token data (hits server cache from the browse call)
		await fetchData();
	})
	.catch((err) => {
		appContainer.innerHTML = `<div class="error-msg">Connection failed: ${esc(String(err))}</div>`;
	});

async function fetchData(): Promise<void> {
	try {
		const result = await app.callServerTool({
			name: "token_browser_refresh",
			arguments: {},
		});
		if (result.content) {
			const textBlock = result.content.find(
				(b: { type: string }) => b.type === "text",
			);
			if (textBlock && "text" in textBlock) {
				const data = JSON.parse(textBlock.text as string);
				if (data.error) {
					appContainer.innerHTML = `<div class="error-msg">${esc(data.error)}</div>`;
					return;
				}
				if (data.variables || data.collections) {
					tokenData = data;
					// Auto-expand first collection
					if (data.collections?.length > 0 && expandedCollections.size === 0) {
						expandedCollections.add(data.collections[0].id);
					}
					render();
				}
			}
		}
	} catch (err) {
		appContainer.innerHTML = `<div class="error-msg">Failed to load tokens: ${esc(String(err))}</div>`;
	}
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

appContainer.addEventListener("input", (e) => {
	const target = e.target as HTMLElement;
	if (target.classList.contains("search-input")) {
		searchTerm = (target as HTMLInputElement).value;
		render();
	}
});

appContainer.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;

	// Tab buttons
	const tabBtn = target.closest("[data-tab]") as HTMLElement | null;
	if (tabBtn) {
		activeTab = tabBtn.dataset.tab as typeof activeTab;
		render();
		return;
	}

	// Collection header toggle
	const collHeader = target.closest(".collection-header") as HTMLElement | null;
	if (collHeader) {
		const collEl = collHeader.closest(".collection") as HTMLElement | null;
		if (collEl?.dataset.id) {
			const id = collEl.dataset.id;
			if (expandedCollections.has(id)) {
				expandedCollections.delete(id);
			} else {
				expandedCollections.add(id);
			}
			render();
		}
		return;
	}

	// Clickable name cell → copy full variable name
	const nameCell = target.closest(".cell-name") as HTMLElement | null;
	if (nameCell?.dataset.fullname) {
		showCopied(nameCell.dataset.fullname);
		return;
	}

	// Clickable value cell → copy formatted value
	const valueCell = target.closest("[data-copy]") as HTMLElement | null;
	if (valueCell) {
		showCopied(valueCell.dataset.copy!);
		return;
	}

	// Refresh button
	if (target.closest(".refresh-btn")) {
		appContainer.querySelector(".refresh-btn")!.textContent = "...";
		fetchData().then(() => {
			const btn = appContainer.querySelector(".refresh-btn");
			if (btn) btn.textContent = "Refresh";
		});
		return;
	}
});

function showCopied(text: string): void {
	navigator.clipboard.writeText(text).then(() => {
		const display = text.length > 40 ? `${text.slice(0, 37)}...` : text;
		toast.textContent = `Copied: ${display}`;
		toast.classList.add("show");
		setTimeout(() => toast.classList.remove("show"), 1400);
	});
}

// ---------------------------------------------------------------------------
// Rendering — compact table layout
// ---------------------------------------------------------------------------

function render(): void {
	if (!tokenData) {
		appContainer.innerHTML =
			'<div class="loading">Loading design tokens...</div>';
		return;
	}

	const { variables = [], collections = [] } = tokenData;

	if (variables.length === 0) {
		appContainer.innerHTML = '<div class="empty">No design tokens found.</div>';
		return;
	}

	// Filter
	let filtered = variables;
	if (searchTerm) {
		const term = searchTerm.toLowerCase();
		filtered = filtered.filter(
			(v: any) =>
				v.name.toLowerCase().includes(term) ||
				v.description?.toLowerCase().includes(term),
		);
	}
	if (activeTab !== "all") {
		const typeMap: Record<string, string> = {
			colors: "COLOR",
			numbers: "FLOAT",
			strings: "STRING",
		};
		filtered = filtered.filter(
			(v: any) => v.resolvedType === typeMap[activeTab],
		);
	}

	// Bucket by collection
	const byCollection: Record<string, any[]> = {};
	for (const v of filtered) {
		const cid = v.variableCollectionId;
		if (!byCollection[cid]) byCollection[cid] = [];
		byCollection[cid].push(v);
	}

	// Counts (unfiltered)
	const counts = {
		total: variables.length,
		colors: variables.filter((v: any) => v.resolvedType === "COLOR").length,
		numbers: variables.filter((v: any) => v.resolvedType === "FLOAT").length,
		strings: variables.filter((v: any) => v.resolvedType === "STRING").length,
		booleans: variables.filter((v: any) => v.resolvedType === "BOOLEAN").length,
	};

	// Build collections
	const collectionsHtml = collections
		.map((col: any) => {
			const colVars = byCollection[col.id] || [];
			if (colVars.length === 0) return "";
			const isExpanded = expandedCollections.has(col.id);
			const modes: { modeId: string; name: string }[] = col.modes || [];
			return `
			<div class="collection ${isExpanded ? "expanded" : ""}" data-id="${col.id}">
				<div class="collection-header">
					<div>
						<span class="collection-name">${esc(col.name)}</span>
						<span class="collection-meta">${colVars.length} tokens${modes.length > 1 ? ` · ${modes.length} modes` : ""}</span>
					</div>
					<div class="collection-toggle">&#9654;</div>
				</div>
				<div class="collection-content">
					${buildTable(colVars, modes, variables)}
				</div>
			</div>`;
		})
		.join("");

	appContainer.innerHTML = `
		<div class="header">
			<h1>Design Tokens</h1>
			<div class="controls">
				<input type="text" class="search-input" placeholder="Search tokens..." value="${escAttr(searchTerm)}" />
				<button class="refresh-btn">Refresh</button>
			</div>
		</div>
		<div class="stats">${counts.total} tokens: ${counts.colors} colors, ${counts.numbers} numbers, ${counts.strings} strings, ${counts.booleans} booleans</div>
		<div class="tabs">
			<button class="tab ${activeTab === "all" ? "active" : ""}" data-tab="all">All</button>
			<button class="tab ${activeTab === "colors" ? "active" : ""}" data-tab="colors">Colors</button>
			<button class="tab ${activeTab === "numbers" ? "active" : ""}" data-tab="numbers">Numbers</button>
			<button class="tab ${activeTab === "strings" ? "active" : ""}" data-tab="strings">Strings</button>
		</div>
		<div class="collections-scroll">
			${collectionsHtml}
			${filtered.length === 0 ? '<div class="empty">No tokens match your search.</div>' : ""}
		</div>
	`;

	// Restore search focus
	const si = appContainer.querySelector(
		".search-input",
	) as HTMLInputElement | null;
	if (si && searchTerm) {
		si.focus();
		si.setSelectionRange(searchTerm.length, searchTerm.length);
	}
}

// ---------------------------------------------------------------------------
// Build a per-collection table with mode columns
// ---------------------------------------------------------------------------

function buildTable(
	vars: any[],
	modes: { modeId: string; name: string }[],
	allVars: any[],
): string {
	// Header: Name | Type | Mode1 | Mode2 | ...
	const modeHeaders = modes
		.map((m) => `<th class="col-value">${esc(m.name)}</th>`)
		.join("");

	// Group variables by path prefix
	const grouped = groupVariables(vars);
	let rowsHtml = "";

	for (const [group, groupVars] of Object.entries(grouped)) {
		const colspan = 2 + modes.length;
		if (group !== "_root") {
			rowsHtml += `<tr class="group-row"><td colspan="${colspan}">${esc(group)}</td></tr>`;
		}
		for (const v of groupVars as any[]) {
			const leaf = v.name.split("/").pop() || v.name;
			const typeLower = (v.resolvedType || "").toLowerCase();

			// Value cells — one per mode
			let valueCells = "";
			if (modes.length === 0) {
				// Fallback: show first available value
				const val = firstValue(v);
				valueCells = `<td class="cell-value" ${copyAttr(v.resolvedType, val)}>${fmtCell(v.resolvedType, val, allVars)}</td>`;
			} else {
				for (const m of modes) {
					const val = v.valuesByMode?.[m.modeId];
					if (val === undefined || val === null) {
						valueCells += '<td class="cell-value">–</td>';
					} else {
						valueCells += `<td class="cell-value" ${copyAttr(v.resolvedType, val)}>${fmtCell(v.resolvedType, val, allVars)}</td>`;
					}
				}
			}

			rowsHtml += `<tr>
				<td class="cell-name" data-fullname="${escAttr(v.name)}" title="Click to copy: ${escAttr(v.name)}${v.description ? `\n${escAttr(v.description)}` : ""}">${esc(leaf)}</td>
				<td class="cell-type"><span class="type-badge ${typeLower}">${esc(v.resolvedType)}</span></td>
				${valueCells}
			</tr>`;
		}
	}

	return `<table class="token-table">
		<thead><tr>
			<th class="col-name">Name</th>
			<th class="col-type">Type</th>
			${modeHeaders || '<th class="col-value">Value</th>'}
		</tr></thead>
		<tbody>${rowsHtml}</tbody>
	</table>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupVariables(vars: any[]): Record<string, any[]> {
	const groups: Record<string, any[]> = {};
	for (const v of vars) {
		const parts = v.name.split("/");
		const group = parts.length > 1 ? parts.slice(0, -1).join("/") : "_root";
		if (!groups[group]) groups[group] = [];
		groups[group].push(v);
	}
	return groups;
}

function firstValue(v: any): any {
	if (v.valuesByMode) {
		const vals = Object.values(v.valuesByMode);
		return vals[0] ?? "";
	}
	return v.resolvedValue ?? "";
}

/** Format a single table cell value (with optional color swatch). */
function fmtCell(type: string, value: any, allVars: any[]): string {
	// Handle alias references
	if (isAlias(value)) {
		const target = resolveAlias(value.id, allVars);
		if (target) {
			const name = target.name.split("/").pop() || target.name;
			return `<span class="alias-ref" title="${escAttr(target.name)}">→ ${esc(name)}</span>`;
		}
		return `<span class="alias-ref alias-unresolved" title="Unresolved reference: ${escAttr(String(value.id))}">→ ref</span>`;
	}

	if (type === "COLOR" && typeof value === "object" && value !== null) {
		const hex = colorToHex(value);
		const rgba = colorToRgba(value);
		return `<span class="swatch" style="background:${rgba}"></span>${esc(hex)}`;
	}

	if (type === "FLOAT") {
		if (typeof value === "number") {
			return esc(Number.isInteger(value) ? String(value) : value.toFixed(2));
		}
		if (typeof value === "object" && value !== null) {
			return esc(JSON.stringify(value));
		}
		return esc(String(value ?? ""));
	}

	if (type === "BOOLEAN") {
		return esc(value ? "true" : "false");
	}

	if (type === "STRING") {
		return esc(String(value ?? ""));
	}

	// Fallback: try to show something useful
	if (typeof value === "object" && value !== null) {
		return esc(JSON.stringify(value));
	}
	return esc(String(value ?? ""));
}

/** Build data-copy and title attributes for click-to-copy on value cells. */
function copyAttr(type: string, value: any): string {
	if (isAlias(value)) return "";
	let text: string;
	if (type === "COLOR" && typeof value === "object" && value !== null) {
		text = colorToHex(value);
	} else if (type === "FLOAT" && typeof value === "number") {
		text = Number.isInteger(value) ? String(value) : value.toFixed(2);
	} else if (type === "BOOLEAN") {
		text = value ? "true" : "false";
	} else {
		text = String(value ?? "");
	}
	return `data-copy="${escAttr(text)}" title="Click to copy: ${escAttr(text)}"`;
}

/** Try multiple strategies to resolve an alias ID to a variable object. */
function resolveAlias(aliasId: string, allVars: any[]): any | null {
	// Strategy 1: exact match on id
	const exact = allVars.find((v: any) => v.id === aliasId);
	if (exact) return exact;

	// Strategy 2: match on key (REST API uses key as id)
	const byKey = allVars.find((v: any) => v.key === aliasId);
	if (byKey) return byKey;

	// Strategy 3: strip "VariableID:" prefix and match numeric suffix
	const numericPart = aliasId.replace(/^VariableID:/, "");
	if (numericPart !== aliasId) {
		const bySuffix = allVars.find(
			(v: any) => v.id?.endsWith(numericPart) || v.key?.endsWith(numericPart),
		);
		if (bySuffix) return bySuffix;
	}

	return null;
}

function isAlias(value: any): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		value.type === "VARIABLE_ALIAS" &&
		typeof value.id === "string"
	);
}

function colorToHex(c: any): string {
	const r = Math.round((c.r || 0) * 255);
	const g = Math.round((c.g || 0) * 255);
	const b = Math.round((c.b || 0) * 255);
	const a = c.a ?? 1;
	if (a < 1) return `rgba(${r},${g},${b},${a.toFixed(2)})`;
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
}

function colorToRgba(c: any): string {
	const r = Math.round((c.r || 0) * 255);
	const g = Math.round((c.g || 0) * 255);
	const b = Math.round((c.b || 0) * 255);
	return `rgba(${r},${g},${b},${c.a ?? 1})`;
}

function esc(s: string): string {
	const d = document.createElement("div");
	d.textContent = s;
	return d.innerHTML;
}

function escAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
