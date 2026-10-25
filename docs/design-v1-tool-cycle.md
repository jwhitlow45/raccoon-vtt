# raccoon-vtt v1: a tool's key moves through its main choice

Status: draft 1, for design review, decided under guess mode (the owner's answers are off). Code is cited from public main at `f84624c1`, with the Trap tool's key X (D-261025-2) assumed landed. This design amends docs/design-v1-tool-options.md 5.5 (Keys) and 11.1 (the sheet's `toolKeyShow` row). Every other rule there stands.

The project owner, 2026-10-25: "Also pressing a shortcut while that tool is selected already should cycle through the primary options of that tool".

## 1. Summary

- **The press.** With a keyboard, the key of the tool in use moves to the next option of its **main choice**: the one choice in its row that sets what a tap or a drag does, which a DM switches most while using the tool. Area's shape, Draw's drawing tool, the Ruler's Straight or Walking, Fog's Clear or Add, the builder's mode, Add token's blank kind and the Trap's zone. Shift with the key goes back. The list wraps.
- **None for four tools.** Select, Ping, Pin and Line up grid have no main choice, so their key keeps today's rule: it shows tucked options and never tucks them.
- **Safe by default.** A held key moves once. A press during a drag on the map moves nothing. A press that would throw away a shape's corners or waiting text moves nothing and says why. No cycle ever changes who sees what.
- **Seen and said.** The choice's own control changes in the row, which a tucked row shows again. One visually hidden polite status beside the toolbar says "Area: Sphere".
- **Keys only.** A tap or Enter on the active tool's button tucks as today. No op, no schema, no protocol change, no new stored key.

## 2. Decisions

1. **Seven tools have a main choice, four have none** (section 3). Rejected per tool in section 3's last column.
2. **A cycle never changes who sees what.** Shared (Ruler, Area), Look here (Ping), DM only (Draw, Pin), Hidden (Area) and Draft or Live (Fog) stay presses. A stray second press must never show players a pin or move their view. Rejected: Ping's Look here and Pin's DM only as main choices.
3. **One option per press, in the row's order, wrapping. Shift goes back** where the key is a Latin letter. A binding that is a digit or a symbol may need Shift just to type on this layout (`?`, the digits of a French keyboard), so there every press goes forward. Shift is read from the event's `shiftKey`, so Caps Lock never reverses. Rejected: no way back (the builder's eleven modes would take ten presses to step back one). Rejected: Alt or Ctrl for back (the room leaves those keys to the browser, `shortcutFor`).
4. **A held key moves once.** Its repeats do nothing, as for every shortcut today (`shortcutFor` drops `e.repeat`). Rejected: holding to spin through the list.
5. **The first press picks the tool and moves nothing.** The tool opens on the choice it had, and the second press moves on from there. Rejected: starting each pick at the list's first option (it throws away the DM's last choice).
6. **Tucked, one press shows the options and moves**, so the DM sees what changed (the coordinator's leaning, kept). Rejected: a first press that only shows (two presses for one change, and the owner asked for the press to cycle).
7. **During a drag on the map, nothing moves.** A press while the tool follows a pointer (`Stage.tsx` `toolPointerRef`) is not kept for later. Rejected: waiting for the lift (the change would land on the next drag, long after the press).
8. **Held while a pick would throw work away.** Draw's shape with corners, Draw's text waiting for words, and the builder's shape room with corners lose them on a mode change (`DrawTool.tsx:479`, `builder/Options.tsx:164`). There the press moves nothing and says why. Rejected: moving anyway, as the chip does (the chip takes two deliberate presses, and in a task it drops behind the task's own controls, 9 "The task rule").
9. **A press that moves closes any open popover first**, as a tool change does (tool options 7.4). Rejected: keeping the chip's own popover open with its pick moved (one more rule, and ⋯ would change behind the person's focus).
10. **Said once, in a status of its own.** Rejected: a toast per press (eight toasts over the map to reach Eraser). Rejected: the line for a moment (it would hide a reading the DM came for, and change the line's reserve, 10.2). Rejected: a region inside the options element (a phone sheet unmounts it, `Room.tsx:648`).
11. **The cycle reads the tool's state, not its row**, so it works while Fog's or the builder's row is loading, under a phone sheet, and with the choice waiting behind ⋯. Rejected: refusing where the choice is out of view (one more rule, rare on a computer, and the status still says it).
12. **One list and one pick per tool**, which the row and the cycle share, so the cycle's order is the row's by construction. Rejected: a copy of each order in the cycle (two lists drift).
13. **Keys only.** A tap, Enter or Space on the active tool's button, or its tile in Setup or Tools, tucks or shows as today (the owner, 2026-10-16). Rejected: a tap that cycles.

## 3. Audit

Today's rows (tool options 9, as built). "Main" is the choice this design cycles.

| Tool | DM's row | Player's row | Main choice | Why |
|---|---|---|---|---|
| Select | Multi-select's words, Actions, Done, only while Multi-select is on | the same | none | V is the key people press to get back to Select, so a second V must stay harmless. With a keyboard, Shift+click already adds to the selection. Rejected: V toggling Multi-select |
| Ruler | Shared, Measure, Keep, Clear, Kept rulers | Measure, Keep, Clear, Kept rulers | Measure: Straight, Walking | The one choice of how it measures. Shared decides who sees it (2.2) |
| Area | Idle: Shape, Spell. Placing: Shape, Size, Place, Shared, Cancel, Spell, ⋯. Picked: Size, Hidden, Damage, Copy, Delete, Done, ⋯ | the same less Hidden and Damage, plus "Not from Thorn" | Shape: Cone, Sphere, Cylinder, Cube, Line, Emanation | What an area is. Size follows the shape. Rejected: Size (a stepper, not a list) |
| Draw | Drawing tool, Color, Stroke, Fill, Undo, Redo, DM only, Clear mine, ⋯ Clear all. A text or a shape task first | the same less DM only and Clear all. Not allowed to draw: Undo and Clear mine only | Drawing tool: Pen, Line, Arrow, Box, Circle, Shape, Text, Eraser | What a drag makes. Rejected: Color (a look, ten values, one tap in its chip) |
| Ping | Look here, Ping sound | Ping sound | none | A ping is one gesture. Look here moves every player's view (2.2), and Ping sound is this device's setting |
| Add token | Blank token kind, Monster…, Character…. Cancel once something is chosen | no tool | Blank token kind: Blank monster, Blank NPC, Blank object, Blank player character | What a tap places. Monster… and Character… open panels |
| Pin | Pin color, DM only. A pin's pane open: no row. Pinning a page: Cancel | no tool | none | Its options are a new pin's look and who sees it, not what a tap does. Rejected: M through ten colors, and M flipping DM only (2.2) |
| Trap | Start from, Party level (for a preset), Zone. A pick waiting: Done. A pane open: no row | no tool | Zone: Squares, Trip wire, Door | What a drag draws, as Area's shape and Draw's tool. Rejected: Start from (ten choices read by name, and a preset sets the zone itself, `startKind`) |
| Fog | Fog off: Turn fog on. Else Clear or add fog, Shape, Brush width, Close shape, Undo corner, Undo, Reveal, Draft or Live, Discard, ⋯ Fog all, Reveal all | no tool | Clear or add fog: Clear fog, Add fog | First in the row at priority 1, and it decides what every shape does. Rejected: Shape (priority 2, its glyph shows it at a glance) and Draft or Live (2.2) |
| Map builder | Builder mode, Undo, Redo, the mode's controls, a stamp's controls, ⋯ Clear build | no tool | Builder mode: Brush, Rectangle room, Shape room, Erase, Erase area, Walls and doors, Heights and stairs, Difficult ground, Label, Lights, Stamp | The mode decides everything else in the row. Rejected: each mode's own choice, such as the edge (a second key rule per mode) |
| Line up grid | Apply, Use default, Find the grid, Nudge, the scale, ⋯ Resize scene, Grid lines. No map or no box: the line only | no tool | none | Actions and a reading, no choice of values |

The builder lists eleven modes in code (Difficult ground was added after tool options 9.9 counted ten).

## 4. The proposal

### 4.1 The press

A tool's key, as this device has it (`shortcutKeys`), passes today's gates first: no field, no modal dialog, no "view as a player", no Ctrl, Cmd or Alt, no repeat, not a key a menu's typeahead used. Then:

1. **Another tool is in use:** pick this one, as today. Its choice stays as it was. Stop.
2. **This tool is in use:** show its tucked options, as today (`tuckEvent` "show").
3. **No main choice now** (the tool has none, or its state shows none: section 4.2's "Shows when"): stop, and say nothing.
4. **A drag on the map is in progress** with this tool: stop, and say nothing.
5. **Held** (4.2): say the held words. Stop.
6. Close any open popover, by state (`popoverSlot.closeOpen("state")`).
7. **Step**: the next option in the list, or with Shift on a letter key the one before, wrapping at both ends. An option the role cannot use or the state disables is skipped (none of the seven lists has one today, and the rule stands for a later option). A current value missing from the list goes to the first option, or with Shift the last.
8. **Pick** it with the same function the row's control calls.
9. **Say** "<tool>: <option>" in the toolbar's status (4.3).

### 4.2 Each tool's cycle

| Tool | Shows when | Starts on | Held while | The pick also does, as the row's does |
|---|---|---|---|---|
| Ruler | always | this device's last (stored, `walkRuler.ts` `saveWalk`) | never | Stores the choice on this device. A ruler on the map measures again, and a shared one goes to players again |
| Area | idle, placing, and a trap's area (`TrapAreaOptions`). Not while a placed area is picked | the last shape this page used (Cone at first) | never | Placing: the draft takes the new shape's own size and keeps its point, aim and caster (`withShape`). A shared draft's new shape goes to players |
| Draw | its full row. Not the eraser-only form | the last (Pen at first) | a shape with corners: "Finish or cancel the shape first." Text waiting for words: "Add or cancel the text first." | Ends any draft (none outside a drag) |
| Fog | fog on for the scene | the last (Clear fog at first) | never: a polygon keeps its corners and a draft keeps waiting | nothing else |
| Map builder | the scene loaded | the last (Brush at first) | a shape room with corners: "Close or cancel the room first." | Clears a rectangle's start, a stroke and the note. A selected stamp stays selected and comes back with Stamp |
| Add token | nothing chosen. Not while a monster or a character waits to be placed | Blank monster (the tool resets as it closes) | never | nothing else |
| Trap | its plain row. Not while a pick waits or a trap's pane is open | the last zone, or the one Start from set (Squares at first) | never | Start from stays as it is |

### 4.3 Shown and said

- **Shown.** The choice's control changes in place: a chip's value and glyph, or a segmented choice's checked option. Chips and segmented choices keep the width of their widest value (tool options 6.2), so nothing beside them moves and the row never refits. Draw's, Fog's and the builder's line show the new mode's hint. With the choice behind ⋯ (the Ruler's Measure waits there first on a narrow row, priority 4), only the status and the ruler's reading show it.
- **Said.** One visually hidden polite status (`role="status"`, `VISUALLY_HIDDEN`) beside the toolbar, mounted with it, so a phone sheet never takes it away. Its words live in the toolbar's own state (`state/toolbar.ts`), a new node per message so a repeat is said again, as `ToastVoice` does. Words: the tool's label, a colon, the option's full name: "Ruler: Walking", "Area: Sphere", "Draw: Eraser", "Fog: Add fog", "Map builder: Heights and stairs", "Add token: Blank NPC", "Trap: Trip wire". Held, only the held words. The line's own live region may then speak the new hint as well, as it does for a pick in the chip.

### 4.4 The shortcut sheet and moved keys

- The sheet's row (`BEHAVIORS` `toolKeyShow`, "Toolbar" section) keeps its input "The tool's key" and its `when`, "for the tool in use", and its words become: "Show its hidden options and go to its next main choice, such as Area's next shape. With Shift, the one before. It never hides them". Its id stays.
- A moved key moves through the choice the same way: the press finds the tool's row by the key in effect (`shortcutFor`), and the cycle runs from that row. Shift goes back for a moved letter, never for a moved digit or symbol (2.3). The sheet's key capture never binds Shift (`bindingOf` lowercases), so no binding clashes with Shift and a letter.
- The toolbar's tooltips and the active button's description ("Press again to hide its options.") are about taps, and stay.

## 5. Edge cases

- **The pair and Setup.** The key reaches its tool whatever the toolbar draws (tool options 5.5), so a setup tool behind Setup or a tool the pair hides moves through its choice too. Nothing in the toolbar changes: Setup's icon and the pair's second button show the tool, not the choice.
- **A menu open.** With focus in Setup, Tools or More, letters type ahead and are marked used, so nothing runs. A menu opened by a pointer leaves focus on its button: a moving press closes it (4.1 step 6).
- **A popover open.** A moving press closes it with focus back on its anchor where focus was inside (tool options 7.1), then moves. A held press, a press with no choice, or one during a drag leaves it open.
- **Focus in a field.** Keys never run there (`isTextField`): Area's spell field, Draw's text, a builder label and the outliner's search all type the letter. Kept.
- **A phone with a keyboard.** The same rules. The row may be stacked or in the toolbar's row, and a choice may wait behind ⋯ (Draw's chip during a task, the Ruler's Measure), which the status covers (2.11).
- **The arrangements.** The rail and the old foot bar are gone (tool options 10.1). All four arrangements draw the same slots, and the cycle never reads the arrangement.
- **A sheet over the options.** The press moves and says it, and the row shows the new choice when the sheet closes.
- **Loading or failed options.** Fog's and the builder's rows load on first use: the press moves their state, and the row shows it once loaded. A failed row still shows its Reload, and the press still moves the state.
- **Kept per device.** Only the Ruler's Measure is stored, under its own key, and the cycle stores it as the row does. Every other choice lasts for the page, as today.
- **A rule that changes underneath.** A player whom the DM stops from drawing gets the eraser-only form, which has no choice, so the key only shows options. Fog turned off has none either.
- **Fast presses** move one each, with no delay. Two presses of different tools' keys pick the second tool.
- **"View as a player"** answers no key (`shortcutFor` `preview`), as today.

## 6. UI checklist

- **Loading states.** The press is local and instant. A lazily loaded row shows the shared "Loading the options…" after 200 ms, as today.
- **Keys and focus.** The press never moves focus, except that closing a popover returns focus inside it to its anchor. Tab order, menus, typeahead and the popover's arrow keys are unchanged. Held keys move once. Shift reverses on letters only.
- **Screen readers.** One polite status, words in 4.3. Chips stay unannounced (tool options 11), and the active tool keeps `aria-pressed`.
- **Large interface sizes.** No visible label in the room changes width. The sheet's longer row wraps under its keycap at 130%, measured (7).
- **The exact words shown.** The sheet's row in 4.4. The status words in 4.3. The held words: "Finish or cancel the shape first.", "Add or cancel the text first.", "Close or cancel the room first." FEATURES.md and the DM guide in 7.

## 7. Lane plan

Builds after the Trap key lane lands. One lane, mostly wiring.

**Files.**

- `client/features/toolChoices.ts`, new and pure: the `ToolChoice` type (`options`, `value`, `held?`), `cycleStep(options, value, back)`, and one `*Choice(state)` per tool from section 4.2 with its held words.
- `client/features/tools.ts`: `ToolDef.cycle?: { now(env): ToolChoice | null; pick(env, value): void }`.
- The seven tools wire `cycle` with the pick their row calls, made one named function: `measure/RulerTool.tsx`, `areas/AreaTool.tsx` and `AreaOptions.tsx`, `drawings/DrawTool.tsx`, `fog/tool.tsx` and `fog/Options.tsx`, `builder/tool.tsx` and `builder/Options.tsx`, `tokens/placeTool.tsx`, `traps/TrapTool.tsx`. Lists in a `.tsx` move to a `.ts` the row and `toolChoices.ts` both import (Draw's modes, the builder's, the fog modes, the blank kinds, the zones, the measures), since unit tests cannot load `.tsx`.
- `client/state/shortcuts.ts`: `toolShortcut`'s run follows 4.1. `ShortcutEnv.tools` carries each tool's label and `cycle`. `stageKeysSlot` gains `busy`, which `canvas/Stage.tsx` sets from `toolPointerRef`. The sheet's row words (4.4).
- `client/state/toolbar.ts`: the status words. `client/pages/Room.tsx`: the status beside the toolbar.

**Commits.** (1) `refactor(ui)`: the lists and named picks, no behavior change. (2) `feat(ui)`: the cycle, with its unit tests. (3) `test(e2e)`: the e2e below and the fixes of the audit. (4) the docs commit, last: FEATURES.md, the DM guide, the sheet's row with FEATURES.md's mirror of it (`shortcuts.test.ts` compares the two, so they land together), and docs/design-v1-tool-options.md 5.5 and 11.1 gain "Amended by docs/design-v1-tool-cycle.md". Sonnet suits commit 1.

**Unit tests.** `client/features/toolChoices.test.ts`: each tool's "shows when" and held states, `cycleStep` forward, back and wrapping, a value missing from the list, a skipped option. `client/state/shortcuts.test.ts`: section 8's key rows, and one randomized run of 500 presses with and without Shift on each list, whose invariant is that the position equals the forward presses less the back ones, modulo the list's length. Mutation check: remove the wrap, the Shift branch, the held check, the drag check, the popover close and the status, one at a time, and each must fail a test.

**E2E**, prefixed `tc-`, in `e2e/shortcuts.e2e.ts` (a DM on a computer and a player on a phone): the `tc-` rows of section 8. Run with `options`, `options-dm-100`, `layout`, `tools`, `traps` and `reach`, since their tests press tool keys. **The audit:** every press of the tool already in use now moves its choice. Grep e2e for the `key` helper (`e2e/optionsRoom.ts`) and for `keyboard.press` with a tool letter, and fix each test that expected the old choice afterwards (as `options.e2e.ts` test 6, which presses D on a tucked Draw).

**Alignment.** No room control changes width (4.3). The sheet's Toolbar section is measured in no file today: add a root `shortcut-sheet-toolbar` to `e2e/alignment.e2e.ts` at 1440x900, 390x844 and 320x568, at 100% and 130%.

**Docs.**

- FEATURES.md's tool options paragraph gains: "With a keyboard, the key of the tool in use shows its options if they are hidden and goes to its next main choice: Area's shape, Draw's drawing tool, the Ruler's Straight or Walking, Fog's Clear fog or Add fog, the builder's mode, Add token's blank kind and the Trap's zone. Shift with the key goes back, and a held key moves once. A drag in progress, or a shape, a room or text not yet finished, keeps the choice. Select, Ping, Pin and Line up grid have no such choice." Its Toolbar table row takes 4.4's words.
- docs/dm-guide.md, Shortcuts, after the tool keys: "Press a tool's key again while you're using it to move to its next main choice: the next shape for Area, the next drawing tool for Draw, Straight or Walking for the Ruler, Clear fog or Add fog for Fog, the next mode for the Map builder, the next blank token for Add token, or the next zone for a trap. Hold Shift to go back. If the tool's options are hidden, the same press shows them." If a guide pass owns the guide when this lands, it takes this bullet.

## 8. Cases

| Case | Expected | Test |
|---|---|---|
| A with Ruler in use | Area picked, its shape as it was, nothing said | unit |
| A, then A | "Shape: Sphere", status "Area: Sphere" | unit, tc-a |
| Shift+A on Cone | Emanation, "Area: Emanation" | unit, tc-a |
| A held down | one move | unit, tc-a |
| Area tucked by a tap, then A | the row shows, and the shape moves | unit, tc-a |
| A with a placed area picked | nothing moves, nothing said | unit |
| A while placing an area | the draft takes the next shape at its own size, at the same point | unit, tc-a |
| D eight times from Pen | through Eraser and back to Pen | unit, tc-b |
| D with a shape of 2 corners | corners kept, "Finish or cancel the shape first." | unit, tc-b |
| D during a mouse drag | the stroke goes on as Pen, nothing said | unit, tc-b |
| A typed in the spell field | the field gets "a" | tc-b |
| F, F | Add fog, then Clear fog, a polygon's corners kept | unit, tc-c |
| F with fog off | nothing moves | unit |
| R, R, then a reload | Walking, kept on this device | unit, tc-c |
| R on the player's phone with a keyboard | Walking, "Ruler: Walking" | tc-c |
| B with a shape room of 2 corners | corners kept, "Close or cancel the room first." | unit |
| T, T | Blank NPC. T while 3 Goblins wait: they stay | unit, tc-c |
| X twice from another tool | Trip wire. X while a pick waits: nothing moves | unit, tc-c |
| V, P, M, G, each pressed again | only tucked options shown, nothing said | unit, tc-c |
| D with Draw's Stroke pop-up open | the pop-up closes, the tool moves to Line | unit, tc-d |
| Area moved to K in the sheet | K moves the shape, A does nothing | unit, tc-d |
| Area moved to `!` | Shift+1 always goes forward | unit |
| Caps Lock on, A | forward | unit |
| A tap on the active tool's button | tucks, no move | existing options.e2e 6 |
| The sheet at 320x568, 130% | the row wraps under its keycap, nothing over 1 px | alignment |

## 9. As built

The builder fills this in the lane's docs commit with every place the build went its own way.
