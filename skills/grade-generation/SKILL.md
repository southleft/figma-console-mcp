---
name: grade-generation
description: Independently grade a generated Figma design or generated UI code against the original request and the design system, using a separate grader subagent that never saw the generator's reasoning. Deterministic tool evidence first, judgment second; returns a fixed PASS/FAIL verdict. Use after any design or code generation, when the user asks to "eval", "grade", "verify", "QA" or "check" a generation, or when running a generate → grade → fix loop.
---

# Grade a generation with an independent grader

> **Tools (Local Mode):** this skill uses tools outside the core set. If they aren't in your tool list, call `figma_enable_toolsets({ toolsets: ["parity", "inspect"] })` once at the start; if they still don't appear, call them through `figma_call({ tool, arguments })`. Cloud Mode lists every tool, so skip this there.

The agent that generated the work doesn't grade it. A separate grader, with fresh context, gets only the request and the location of the artifact. It checks with tools first and uses judgment second. **Evidence beats opinion:** every blocking finding must cite tool output (a nodeId with its audit rule, or a file:line with its rule). A finding the grader can't back with evidence is a note, not a FAIL reason.

## Orchestrator: spawn the grader

In Claude Code, use the **Agent** tool with a fresh agent, e.g. `subagent_type: "general-purpose"`, which has the figma-console tools. **Don't use a fork.** A fork inherits the generator's context, which defeats the point. In other clients, use whatever starts a new agent with empty context.

Send only this brief. Leave out the generator's plan, its notes, its own audit results, and "I already fixed X".

```
You are grading a generated artifact. You did not create it. Be strict and cite evidence.

REQUEST (verbatim from the person):
<original request text>

ARTIFACT:
- Kind: figma | code
- Figma: file <fileKey or URL>, root nodeId <id>
- Code: files <path1>, <path2>

DESIGN SYSTEM:
- Figma library file keys: <keys, or "active file">
- Code: packages <@acme/ui>, components <list or "inspect package">, tokens <path>
- Code component counterparts (for parity), if any: <Figma nodeId ↔ code file>

GAP POLICY: <"note in place" (default: anything the system lacks gets an explained GAP note where it belongs) | the person's list of approved gaps>

PASS CRITERIA:
- Adherence score >= <90>, zero adherence errors
- No WCAG A/AA critical findings
- Every requested element present; nothing extra; no invented components or tokens
- Every missing component or part marked with an explained gap note in the right spot; no gap notes for things the system has

Follow the grade-generation skill's grader procedure and return its verdict format exactly.
```

## Grader procedure

### A. Deterministic checks (always run, in this order)

**Figma artifact:**
1. `figma_list_open_files`. If the artifact's file isn't the active one, run `figma_navigate({ url, lock: true })`.
2. `figma_audit_adherence({ nodeId, libraryFileKeys, minScore })`. Record `pass`, `score`, `componentCoverage`, `tokenCoverage`, `counts.byRule`, `componentsUsed`, `declaredGaps`, plus each error and warning finding with its `nodeId`. If `stats.truncated` is set, re-run on a smaller frame or with a higher `maxNodes`. Never grade from a truncated audit.
3. `figma_lint_design({ nodeId, rules: ["wcag"] })`. Record findings by severity and WCAG level.
4. `figma_capture_screenshot({ nodeId })` for the visual check in B.
5. For each node the brief lists as having a code counterpart: `figma_check_design_parity({ nodeId, codeSpec, canonicalSource })`. Build `codeSpec` from reading the code file.

**Code artifact:**
1. `figma_audit_code_adherence({ files, designSystem: { packages, components, tokensPath }, minScore })`. Record `score`, `pass`, and each finding with `file:line` and its rule.
2. If the code can be rendered to HTML (static markup, or a story's rendered output): `figma_scan_code_accessibility({ html, tags: ["wcag2a","wcag2aa","wcag22aa"] })`.
3. If a Figma counterpart is listed: `figma_check_design_parity({ nodeId, codeSpec: { filePath, … } })`.

If a tool errors (connection, missing library, empty catalog), stop and report `INCONCLUSIVE` with the error. Don't grade on partial evidence, and don't substitute your own impression.

### B. Judgment (after A, anchored to it)

Compare the artifact to the **request**, not to what you would have built:
- **Fidelity:** list every element the request asks for, and mark each one present (cite nodeId or file:line), declared gap, or missing.
- **Nothing extra:** flag elements the request didn't ask for.
- **No invention:** look at the screenshot and the code for anything that looks like a system component but isn't an instance or import. Confirm it with the audit's `imitates-component`, `looks-hand-built`, `reimplements-component` or `raw-element` findings, or inspect the node with `figma_get_component_for_development_deep({ nodeId, depth: 2 })`.
- **Gaps marked in place:** for every requested element or part, decide independently whether the system has it. Use `figma_search_components` and `figma_get_component_details`, not the generator's word.
  - **System lacks it:** there must be a `GAP:` note (from the audit's `gapNotes`) in the spot where it belongs, explaining what goes there. A silent omission or a hand-built fake is blocking.
  - **System has it:** it must be an instance. A gap note in its place is blocking (`gap-but-component-exists`).
  - **Placement:** check each note's position on the screenshot. It must be where the element would be (pagination under its table, a card image within the card's group), not collected in a corner.
- **Visual sanity (Figma):** overlaps, clipped text, broken alignment. These are non-blocking unless they make a requested element unusable.

### C. Verdict rules

- FAIL if any of these hold:
  - an adherence error,
  - score below the threshold,
  - a WCAG A/AA critical finding,
  - a requested element or part missing without a gap note,
  - a gap note for something the system has,
  - an invented stand-in (hand-built look-alike) instead of a gap note,
  - a truncated audit.
- PASS otherwise. Warnings go in the report but don't fail on their own unless the brief says so.
- Each blocking finding must quote the tool, the rule, and the nodeId or file:line. If you can't cite it, move it to Notes.

### Verdict format (return exactly this)

```
VERDICT: PASS | FAIL | INCONCLUSIVE

SCORES
- Adherence: <score>/100 (threshold <n>) — componentCoverage <x>, tokenCoverage <y>   [or code: score <n>]
- Accessibility: <critical>/<warning> findings (WCAG A: <n>, AA: <n>, AAA: <n>)
- Parity: <score or "n/a">
- Request fidelity: <present>/<requested> elements

BLOCKING FINDINGS
1. [<tool> · <rule>] <nodeId | file:line> — <what is wrong> — fix: <specific action>
...

GAPS
- Declared and approved: <list>
- Undeclared / missing: <list>

NON-BLOCKING
- <warnings, visual notes>

NOTES (judgment without tool evidence — not used for the verdict)
- <...>
```

## The loop

1. The generator builds, then the orchestrator spawns grader #1.
2. On FAIL, the orchestrator passes only the **BLOCKING FINDINGS and GAPS** sections to the generator, which fixes them.
3. The orchestrator spawns a **new** grader (fresh subagent, same brief) for each round. Never reuse a grader that saw an earlier round.
4. Stop at PASS or after **N rounds** (default 3). A FAIL after N rounds goes to the person with the last verdict verbatim. Don't summarize it into a pass, and don't lower thresholds to get one.
5. If a finding can only be fixed by inventing something (a missing component or token), the generator marks it with a gap note instead. That isn't a grader failure.

INCONCLUSIVE isn't a pass. Fix the tooling problem (see `troubleshoot-connection`) and re-grade.
