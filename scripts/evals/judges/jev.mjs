#!/usr/bin/env node
/**
 * Judge 2 of the panel: TypeSafe's Jev (a non-Claude "System One" model that
 * returns calibrated probabilities for typed questions). It never sees the
 * generator's reasoning or any automated verdict — only the request, the
 * screenshot, the layer tree, the gap notes and the design system inventory.
 *
 * The rubric is the same for every design system. For each element the request
 * calls for, Jev decides how it was handled and whether that was right:
 *   handled   right component | wrong component (stand-in) | gap note | hand-built | absent
 *   lacking   the design system truly has nothing that could serve as it
 *   placed    (gap notes) the note sits where the element belongs
 *   where     (gap notes) a box where the element should be, compared with the note
 * plus a score for each gap note's explanation, and whole-screen questions.
 *
 * Usage: node scripts/evals/judges/jev.mjs --evidence <dir> --case <case.json> [--out verdict.json]
 * Needs TYPESAFE_API_KEY (env or .env.mcp).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { treeText } from "./evidence.mjs";

function apiKey() {
	if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
	const f = join(process.cwd(), ".env.mcp");
	if (existsSync(f)) {
		const m = readFileSync(f, "utf8").match(/^TYPESAFE_API_KEY=(.+)$/m);
		if (m) return m[1].trim();
	}
	throw new Error("TYPESAFE_API_KEY not set");
}

async function ask(state, questions, pngBase64) {
	const body = { model: "jev-latest", state, questions, ...(pngBase64 ? { assets: { "screen-1": { type: "image", format: "png", data_base64: pngBase64 } } } : {}) };
	const json = JSON.stringify(body);
	for (let attempt = 0; attempt < 3; attempt++) {
		const r = await fetch("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey()}`,
				"Content-Type": "application/json",
				...(pngBase64 ? { "TypeSafe-Danger-Zone-Images": "true" } : {}),
				...(json.length > 300000 ? { "TypeSafe-Danger-Zone-Long-Context": "true" } : {}),
			},
			body: json,
		});
		if (r.ok) return r.json();
		const t = await r.text();
		if (r.status < 500 && r.status !== 429) throw new Error(`Jev ${r.status}: ${t.slice(0, 400)}`);
		await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
	}
	throw new Error("Jev unavailable after retries");
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

/** Every element and part the request calls for, as plain descriptions. */
export function expectedItems(caseFile) {
	const out = [];
	for (const el of caseFile.elements) {
		out.push({ id: el.id, describe: el.describe ?? el.id });
		for (const p of el.parts ?? []) out.push({ id: `${el.id} → ${p.id}`, describe: p.describe ?? `the ${p.id} on each ${el.id}` });
	}
	return out;
}

export async function judgeWithJev({ evidence, pngBase64, pngNoGapsBase64, caseFile }) {
	const comp = evidence.composition;
	const state = {
		request: evidence.prompt,
		screenshot: "screen-1",
		design_system_components: evidence.designSystem.components,
		design_system_descriptions_of_used_components: evidence.designSystem.usedComponentDescriptions ?? {},
		design_system_component_details: evidence.designSystem.componentDetails ?? {},
		design_system_variable_collections: evidence.designSystem.variables.map((c) => `${c.collection} (${c.names.length})`),
		composition_layers: treeText(comp.layers),
		composition_gap_notes: comp.gapNotes.map((g) => ({ name: g.name, note: g.note, inside: g.parent })),
		values_not_bound_to_variables: comp.unboundValues,
		how_to_read: "ONLY layers in [brackets] are instances of design-system components (component · variant). Every other layer — FRAME, TEXT, RECTANGLE, VECTOR — is drawn by hand, whatever it is named. A layer named 'GAP: …' is a note saying the design system lacks that element.",
	};
	const items = expectedItems(caseFile);
	const questions = {};
	for (const it of items) {
		const k = slug(it.id);
		questions[`handled__${k}`] = {
			type: "choice",
			instructions: `The request calls for ${it.describe}. How does the composition provide it? Use the layer list and the screenshot.`,
			criteria: {
				right_component: `Provided by a design-system component instance that is genuinely meant for ${it.describe}.`,
				wrong_component: `Provided by a design-system component meant for something else, used as a stand-in (e.g. a single item where a whole control is needed, or a component of a different kind), or by loose parts when design_system_components has a complete component for it.`,
				gap_note: `Not built; a GAP note says the design system lacks it.`,
				hand_built: `Drawn by hand from plain frames, shapes or text so that it looks like ${it.describe}, instead of using a component or a gap note. A layer that is NOT in [brackets] counts as hand-drawn even if it is named like a component (e.g. a FRAME named "Button" is hand-drawn).`,
				absent: `Missing entirely, with no gap note.`,
			},
		};
		questions[`lacking__${k}`] = {
			type: "noul",
			instructions: `Judging only from design_system_components: the design system has nothing that could reasonably serve as ${it.describe}.`,
			criteria: { true: `No listed component is meant for this or could reasonably provide it.`, false: `At least one listed component is meant for this or could reasonably provide it.` },
		};
	}
	comp.gapNotes.forEach((g, i) => {
		questions[`explained__${i}`] = {
			type: "score",
			instructions: `Rate the gap note named ${JSON.stringify(g.name)} with text ${JSON.stringify(g.note)}: does it tell a designer what belongs in this spot and why it isn't there?`,
			criteria: ["No explanation (just a label, or empty)", "Says something is missing but not what or why", "Says what is missing and that the design system lacks it", "Says what belongs here for this specific screen and why it's missing"],
		};
		questions[`placed__${i}`] = {
			type: "noul",
			instructions: `In the screenshot, the gap note ${JSON.stringify(g.name)} sits where that element would normally appear on this screen (e.g. pagination directly under the table it pages, an image inside its card's area), rather than off to the side or collected with other notes.`,
		};
	});
	questions.fidelity = {
		type: "score",
		instructions: "Overall, how completely and faithfully does the composition deliver what the request asks for, counting honest gap notes as delivered?",
		criteria: ["Little of the request is delivered", "About half is delivered", "Most is delivered, with notable omissions or stand-ins", "Nearly everything, with minor issues", "Everything requested is delivered or honestly noted"],
	};
	questions.hand_built_lookalikes = {
		type: "noul",
		instructions: "Somewhere on this screen, plain hand-drawn layers imitate a UI component (a button, input, tab, table row, pagination, card…) instead of using a design-system instance or a gap note.",
	};
	questions.extras = { type: "noul", instructions: "The composition adds notable UI elements the request did not ask for." };
	questions.readable = { type: "noul", instructions: "In the screenshot, all text is legible with clear contrast and nothing overlaps or is clipped." };

	// Where should each gap-noted element be? (Box), compared with the note's position.
	const boxQs = {};
	comp.gapNotes.forEach((g, i) => {
		// Repeated notes ("GAP: card — image" ×3): say which one, by its frame and order.
		const same = comp.gapNotes.filter((x) => x.name === g.name);
		const which =
			same.length > 1
				? ` — specifically the one for "${g.parent}" (number ${same.indexOf(g) + 1} of ${same.length}, in reading order)`
				: "";
		boxQs[`where__${i}`] = { type: "box", instructions: `Where on this screen would ${g.name.replace(/^GAP:\s*/i, "")}${which} normally go, given the rest of the layout?` };
	});

	const res = await ask(state, questions, pngBase64);
	// Asked on the render WITHOUT gap notes, so the answer reflects the layout, not the note's position.
	const boxRes = Object.keys(boxQs).length
		? await ask({ request: evidence.prompt, screenshot: "screen-1", note: "Some elements are missing from this screen; say where they would normally go." }, boxQs, pngNoGapsBase64 ?? pngBase64).catch((e) => ({ error: String(e) }))
		: null;
	const a = res.answers;

	const verdicts = items.map((it) => {
		const k = slug(it.id);
		const h = a[`handled__${k}`];
		const lacking = a[`lacking__${k}`]?.noul ?? null;
		const how = h?.choice;
		let outcome;
		if (how === "right_component") outcome = "built-with-component";
		else if (how === "wrong_component") outcome = "WRONG-COMPONENT";
		else if (how === "gap_note") outcome = lacking !== null && lacking < 0.5 ? "FALSE-GAP" : "gap-noted";
		else if (how === "hand_built") outcome = lacking !== null && lacking >= 0.5 ? "INVENTED" : "HAND-BUILT-INSTEAD-OF-COMPONENT";
		else outcome = lacking !== null && lacking >= 0.5 ? "SILENT-OMISSION" : "MISSED";
		return { id: it.id, outcome, handled: how, handledConfidence: h?.confidence, handledProbabilities: h?.probabilities, systemLacksIt: lacking };
	});
	const gapNotes = comp.gapNotes.map((g, i) => {
		const where = boxRes?.answers?.[`where__${i}`]?.box;
		let distance = null;
		if (where && g.box) {
			const cx = (b) => (b.left + b.right) / 2;
			const cy = (b) => (b.top + b.bottom) / 2;
			distance = +Math.hypot(cx(where) - cx(g.box), cy(where) - cy(g.box)).toFixed(3);
		}
		return { name: g.name, explanation: a[`explained__${i}`]?.score, explanationOutOf: 3, placedJudgement: a[`placed__${i}`]?.noul, expectedBox: where, noteBox: g.box, centreDistance: distance, placed: distance === null ? a[`placed__${i}`]?.noul : +Math.max(0, 1 - distance / 0.5).toFixed(3) };
	});
	return {
		judge: `jev (${res.model})`,
		verdicts,
		gapNotes,
		screen: {
			fidelity: a.fidelity?.score,
			fidelityOutOf: 4,
			handBuiltLookalikes: a.hand_built_lookalikes?.noul,
			extras: a.extras?.noul,
			readable: a.readable?.noul,
		},
		usage: res.usage,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const arg = (k) => process.argv[process.argv.indexOf(`--${k}`) + 1];
	const dir = arg("evidence");
	const evidence = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
	const pngBase64 = readFileSync(join(dir, "screenshot.png")).toString("base64");
	const ng = join(dir, "screenshot-no-gaps.png");
	const pngNoGapsBase64 = existsSync(ng) ? readFileSync(ng).toString("base64") : undefined;
	const caseFile = JSON.parse(readFileSync(arg("case"), "utf8"));
	const v = await judgeWithJev({ evidence, pngBase64, pngNoGapsBase64, caseFile });
	if (process.argv.includes("--out")) writeFileSync(arg("out"), JSON.stringify(v, null, 2));
	console.log(JSON.stringify(v, null, 2));
}
