import {
	App,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

// ---------------------------------------------------------------------------
// Types (inline — client cannot import server modules)
// ---------------------------------------------------------------------------

interface Finding {
	id: string;
	label: string;
	score: number;
	severity: "pass" | "warning" | "fail" | "info";
	tooltip?: string;
	details?: string;
	examples?: string[];
	locations?: Array<{
		name: string;
		collection?: string;
		nodeId?: string;
		type?: string;
	}>;
}

interface CategoryScore {
	id: string;
	label: string;
	shortLabel: string;
	score: number;
	weight: number;
	findings: Finding[];
}

interface DashboardData {
	overall: number;
	status: "good" | "needs-work" | "poor";
	categories: CategoryScore[];
	summary: string[];
	meta: {
		componentCount: number;
		variableCount: number;
		collectionCount: number;
		styleCount: number;
		componentSetCount: number;
		standaloneCount: number;
		variantCount: number;
		timestamp: number;
	};
	fileInfo?: {
		name: string;
		lastModified: string;
	};
	dataAvailability?: {
		variables: boolean;
		collections: boolean;
		variableError?: string;
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAUGE_RADIUS = 30;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let dashboardData: DashboardData | null = null;
const expandedCategories = new Set<string>();

const appContainer = document.getElementById("app") as HTMLElement;
const app = new App({ name: "DesignSystemDashboardApp", version: "1.0.0" });

// ---------------------------------------------------------------------------
// SDK handlers (registered before connect)
// ---------------------------------------------------------------------------

// When a new tool result arrives (e.g., user requested audit for a different file),
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
		await fetchData();
	})
	.catch((err) => {
		appContainer.innerHTML = `<div class="error-msg">Connection failed: ${esc(String(err))}</div>`;
	});

async function fetchData(): Promise<void> {
	try {
		const result = await app.callServerTool({
			name: "ds_dashboard_refresh",
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
				if (data.overall !== undefined && data.categories) {
					dashboardData = data as DashboardData;
					render();
				} else {
					appContainer.innerHTML =
						'<div class="empty">No design system data found.</div>';
				}
			}
		}
	} catch (err) {
		appContainer.innerHTML = `<div class="error-msg">Failed to load dashboard: ${esc(String(err))}</div>`;
	}
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

appContainer.addEventListener("click", (e) => {
	const target = e.target as HTMLElement;

	// Category header toggle
	const catHeader = target.closest(".category-header") as HTMLElement | null;
	if (catHeader) {
		const catEl = catHeader.closest(".category") as HTMLElement | null;
		if (catEl?.dataset.id) {
			const id = catEl.dataset.id;
			if (expandedCategories.has(id)) {
				expandedCategories.delete(id);
				catEl.classList.remove("expanded");
			} else {
				expandedCategories.add(id);
				catEl.classList.add("expanded");
			}
		}
		return;
	}

	// Refresh button
	if (target.closest(".refresh-btn")) {
		const btn = appContainer.querySelector(".refresh-btn");
		if (btn) btn.textContent = "...";
		fetchData().then(() => {
			const refreshBtn = appContainer.querySelector(".refresh-btn");
			if (refreshBtn) refreshBtn.textContent = "Refresh";
		});
		return;
	}
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
	if (!dashboardData) {
		appContainer.innerHTML =
			'<div class="loading">Analyzing design system...</div>';
		return;
	}

	const {
		overall,
		status,
		categories,
		summary,
		meta,
		fileInfo,
		dataAvailability,
	} = dashboardData;

	if (categories.length === 0) {
		appContainer.innerHTML =
			'<div class="empty">No design system data found.</div>';
		return;
	}

	const statusLabel = formatStatus(status);
	const scoreClass = scoreColorClass(overall);

	const metaParts: string[] = [];
	if (meta.componentSetCount > 0 || meta.standaloneCount > 0) {
		const parts: string[] = [];
		if (meta.componentSetCount > 0)
			parts.push(`${meta.componentSetCount} component sets`);
		if (meta.standaloneCount > 0)
			parts.push(`${meta.standaloneCount} standalone`);
		metaParts.push(parts.join(" + "));
	}
	if (meta.variableCount > 0) metaParts.push(`${meta.variableCount} variables`);
	if (meta.collectionCount > 0)
		metaParts.push(`${meta.collectionCount} collections`);
	if (meta.styleCount > 0) metaParts.push(`${meta.styleCount} styles`);

	const dataNoticeHtml =
		dataAvailability && !dataAvailability.variables
			? `<div class="data-notice">Variable and token data unavailable. ${esc(dataAvailability.variableError || "Requires Figma Enterprise plan or Desktop Bridge plugin.")} Token-related scores may not reflect actual design system quality.</div>`
			: "";

	appContainer.innerHTML = `
		<div class="header">
			<div>
				<h1>Design System Health</h1>
				${fileInfo ? `<div class="header-subtitle">${esc(fileInfo.name)}</div>` : ""}
			</div>
			<button class="refresh-btn">Refresh</button>
		</div>
		${dataNoticeHtml}
		<div class="overall-banner">
			<div class="overall-score ${scoreClass}">${overall}</div>
			<div class="overall-details">
				<div class="overall-status ${scoreClass}">${esc(statusLabel)}</div>
				<div class="overall-meta">${esc(metaParts.join(" / "))}</div>
			</div>
		</div>
		<div class="gauge-row">
			${buildGauges(categories)}
		</div>
		<div class="content-scroll">
			${buildCategories(categories)}
			${buildSummary(summary)}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// Gauge rendering
// ---------------------------------------------------------------------------

function buildGauges(categories: CategoryScore[]): string {
	return categories
		.map((cat) => {
			const offset = GAUGE_CIRCUMFERENCE * (1 - cat.score / 100);
			const strokeClass = strokeColorClass(cat.score);
			const fillClass = scoreColorClass(cat.score);

			return `
			<div class="gauge-item">
				<svg viewBox="0 0 72 72" class="gauge-svg">
					<circle class="gauge-ring gauge-track"
						cx="36" cy="36" r="${GAUGE_RADIUS}" />
					<circle class="gauge-ring gauge-fill ${strokeClass}"
						cx="36" cy="36" r="${GAUGE_RADIUS}"
						stroke-dasharray="${GAUGE_CIRCUMFERENCE}"
						stroke-dashoffset="${offset}"
						transform="rotate(-90 36 36)" />
					<text x="36" y="36" text-anchor="middle"
						dominant-baseline="central"
						class="gauge-score ${fillClass}">${cat.score}</text>
				</svg>
				<div class="gauge-label" title="${escAttr(cat.label)}">${esc(cat.shortLabel)}</div>
			</div>`;
		})
		.join("");
}

// ---------------------------------------------------------------------------
// Category sections
// ---------------------------------------------------------------------------

function buildCategories(categories: CategoryScore[]): string {
	return categories
		.map((cat) => {
			const isExpanded = expandedCategories.has(cat.id);
			const scoreClass = scoreColorClass(cat.score);
			const findingCount = cat.findings.length;

			return `
			<div class="category ${isExpanded ? "expanded" : ""}" data-id="${escAttr(cat.id)}">
				<div class="category-header">
					<div class="category-left">
						<span class="category-name">${esc(cat.label)}</span>
						<span class="category-meta">${findingCount} check${findingCount !== 1 ? "s" : ""}</span>
					</div>
					<div class="category-right">
						<span class="category-score ${scoreClass}">${cat.score}</span>
						<span class="category-toggle">&#9654;</span>
					</div>
				</div>
				<div class="category-content">
					${buildFindings(cat.findings)}
				</div>
			</div>`;
		})
		.join("");
}

// ---------------------------------------------------------------------------
// Findings list
// ---------------------------------------------------------------------------

function buildFindings(findings: Finding[]): string {
	if (findings.length === 0) {
		return '<div class="findings-list"><div class="finding"><span class="finding-label">No checks in this category.</span></div></div>';
	}

	const items = findings
		.map((f) => {
			const icon = severityIcon(f.severity);
			const scoreClass = scoreColorClass(f.score);
			const tooltipAttr = f.tooltip ? ` title="${escAttr(f.tooltip)}"` : "";
			const detailsHtml = f.details
				? `<div class="finding-details">${esc(f.details)}</div>`
				: "";
			const locationItems = f.locations && f.locations.length > 0 ? f.locations : null;
			const examplesHtml = locationItems
				? `<details class="finding-examples">
					<summary>${locationItems.length} example${locationItems.length !== 1 ? "s" : ""}</summary>
					<ul class="examples-list">${locationItems.map((loc) => {
						const ctx = loc.collection
							? ` <span class="example-ctx">${esc(loc.collection)}</span>` : "";
						return `<li>${esc(loc.name)}${ctx}</li>`;
					}).join("")}</ul>
				</details>`
				: f.examples && f.examples.length > 0
					? `<details class="finding-examples">
						<summary>${f.examples.length} example${f.examples.length !== 1 ? "s" : ""}</summary>
						<ul class="examples-list">${f.examples.map((ex) => `<li>${esc(ex)}</li>`).join("")}</ul>
					</details>`
					: "";

			return `
			<div class="finding" data-finding-id="${escAttr(f.id)}">
				<span class="finding-icon ${f.severity}">${icon}</span>
				<div class="finding-body">
					<div class="finding-label"${tooltipAttr}>${esc(f.label)}</div>
					${detailsHtml}
					${examplesHtml}
				</div>
				<span class="finding-score ${scoreClass}">${f.score}</span>
			</div>`;
		})
		.join("");

	return `<div class="findings-list">${items}</div>`;
}

// ---------------------------------------------------------------------------
// Summary section
// ---------------------------------------------------------------------------

function buildSummary(summary: string[]): string {
	if (!summary || summary.length === 0) return "";

	const items = summary
		.map((item) => `<li class="summary-item">${esc(item)}</li>`)
		.join("");

	return `
		<div class="summary-section">
			<div class="summary-heading">Top Issues</div>
			<ul class="summary-list">${items}</ul>
		</div>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreColorClass(score: number): string {
	if (score >= 90) return "score-good";
	if (score >= 50) return "score-needs-work";
	return "score-poor";
}

function strokeColorClass(score: number): string {
	if (score >= 90) return "stroke-good";
	if (score >= 50) return "stroke-needs-work";
	return "stroke-poor";
}

function formatStatus(status: DashboardData["status"]): string {
	if (status === "good") return "Good";
	if (status === "needs-work") return "Needs Work";
	return "Poor";
}

function severityIcon(severity: Finding["severity"]): string {
	switch (severity) {
		case "pass":
			return "&#10003;";
		case "warning":
			return "&#9888;";
		case "fail":
			return "&#10007;";
		case "info":
			return "&#8505;";
		default:
			return "&#8226;";
	}
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
