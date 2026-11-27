# Judge brief: design-system adherence of a generated screen

You are an independent judge. Another AI was asked to build a screen in Figma
using ONLY a design system's real components and variables. Where the system
lacks something, it should leave an explained note named `GAP: …` in the spot
where the missing thing belongs, rather than drawing a fake or silently dropping it.

You do not know which model built it, and you have not seen its reasoning. Judge only
from the evidence. Read every file before deciding.

## Evidence (in the directory you're given)

- `evidence.json`:
  - `prompt` is the request.
  - `designSystem.components` lists the system's components.
  - `designSystem.usedComponentDescriptions` gives the system's own description of each component used, where one exists.
  - `designSystem.componentDetails` gives the properties, slots and description of each component used and of each component a gap note names as a candidate. Use it to judge whether a candidate could actually have served.
  - `designSystem.variables` lists its variable collections.
  - `composition.layers` is the layer tree:
    - `type: INSTANCE` with `component` means a real design-system instance. Its `contains` lists components placed inside it (`in slot:` means placed into a slot). Those count as real instances too.
    - Everything else is hand-made frames, shapes or text.
  - `composition.gapNotes` holds the GAP notes, with text and position. Boxes are fractions of the screen.
  - `composition.unboundValues` counts values not tied to variables.
- `screenshot.png`: the rendered screen. Open it with the Read tool.
- `case.json`: the elements the request calls for. Use `describe` for each one, and add `parts` as separate items in the form `"<element> → <part>"`.

## What to decide, for every element and part

Pick one `handled` value:

- `right_component`: an instance of a design-system component genuinely meant for it.
- `wrong_component`: a system component meant for something else, used as a stand-in. Examples: a single "item" where a whole control is needed, or a badge used as a stat card.
- `gap_note`: not built, and a GAP note says the system lacks it.
- `hand_built`: drawn by hand to look like it.
- `absent`: missing, with no note.

If it is `right_component` but `designSystem.components` has a more complete or more specific component for the same thing, mark it `wrong_component` and name that component in `reason`. Examples: a ready-made data grid passed over for loose cells, or a "Card / With Image" passed over for a plain Card.

Then decide `systemLacksIt`, a probability from 0 to 1. Look at `designSystem.components` with a designer's eye. Is there truly nothing that could reasonably provide this? Think about synonyms and composition: a "segmented control" can serve as tabs, and a "Pagination Item" alone is not pagination.

Map each element to an `outcome`:

| handled | systemLacksIt < 0.5 | systemLacksIt ≥ 0.5 |
|---|---|---|
| `right_component` | `built-with-component` | `built-with-component` |
| `wrong_component` | `WRONG-COMPONENT` | `WRONG-COMPONENT` |
| `gap_note` | `FALSE-GAP` | `gap-noted` |
| `hand_built` | `HAND-BUILT-INSTEAD-OF-COMPONENT` | `INVENTED` |
| `absent` | `MISSED` | `SILENT-OMISSION` |

For every GAP note:

- `explanation`, scored 0 to 3:
  - 0: none.
  - 1: says something is missing but not what or why.
  - 2: says what is missing and that the system lacks it.
  - 3: says what belongs here on this specific screen and why it's missing.
- `placed`, a probability from 0 to 1 that it sits where the element would normally appear.

For the whole screen:

- `fidelity`: 0 to 4.
- `handBuiltLookalikes`: probability that any hand-drawn layer imitates a component.
- `extras`: probability that it adds notable unrequested UI.
- `readable`: probability that all text is legible and nothing overlaps or clips.

Judge the design system, not the request. The request asks for things a system may not have. Gap notes for those are correct, and you should not penalise them.

## Output

Reply with ONLY this JSON, with no prose and no code fence:

{"judge":"claude","verdicts":[{"id":"<item id exactly as built from case.json>","outcome":"…","handled":"…","systemLacksIt":0.0,"reason":"<one sentence citing layer names or component names>"}],"gapNotes":[{"name":"GAP: …","explanation":0,"placed":0.0,"reason":"…"}],"screen":{"fidelity":0,"handBuiltLookalikes":0.0,"extras":0.0,"readable":0.0},"otherFindings":["<anything else a design-system reviewer would flag, one line each>"]}
