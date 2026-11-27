# Auditor brief: check the judges' work

Several independent judges graded a generated Figma screen. Your job is to check
whether their verdicts are supported by the evidence. You are not a fourth judge
casting a vote.

## Read

These files are in the directory you're given:

- `evidence.json`
- `case.json`
- `screenshot.png` (open it with the Read tool)
- every judge file: `jev.json` and `claude-*.json`
- `panel.json`: the combined view

`jev.json` has no written reasons. Use its `handledProbabilities`, `systemLacksIt` and `centreDistance` instead.

## For every item where the judges did NOT agree, and every item the panel calls a defect

1. Find the layers involved in `evidence.json`. In `composition.layers`, `type: INSTANCE` + `component` marks a real instance. Also check `composition.gapNotes`.
2. Check each judge's claim against those layers:
   - Does the layer or component it cites exist?
   - Is it an instance where the judge says instance, and hand-drawn where the judge says hand-drawn?
   - For a "the system lacks it" claim, check `designSystem.components`. Is there truly nothing that could serve? Name the closest component if there is one.
3. Decide which outcome the evidence supports. If the evidence can't settle it, say `undecidable from evidence` and say what would settle it.

Also flag any judge reason that cites a layer, component or text that is not in the evidence. That is a fabrication.

## Output

Reply with ONLY JSON, with no prose and no code fence:

{"items":[{"id":"…","supported":"<outcome the evidence supports | undecidable from evidence>","judgesRight":["…"],"judgesWrong":["…"],"evidence":"<the layer/component facts that decide it>"}],"fabrications":[{"judge":"…","id":"…","claim":"…"}],"notes":["…"]}
