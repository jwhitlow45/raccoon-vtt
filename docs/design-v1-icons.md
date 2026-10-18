# raccoon-vtt v1: icons across the app

Status: decided by the project owner on 2026-10-17 (section 10) and built. The prototype's commits showed the rules on the Dice panel, the Token panel, the token action bar and the top bar, and the build carried section 4 across the app.

The project owner asked for it on 2026-10-17: "We should also do a pass of using icons to save space and make the app look better. there's a ton of text right now and i think some well placed icons/replacing some text with icons (which should still show the text on hover) would do a lot for usability/intuitiveness, please go a general ui/ux pass of the entire app in this category." It is part of the dice UI pass (docs/design-v1-dice-ui.md), which cites this document for every icon it uses.

Fixed by the project owner: the icon set is Lucide (ISC). The condition, status and token icons from game-icons.net stay as they are. Another design, compact side panel headers (docs/design-v1-side-headers.md), maps its headers' icons to Lucide in its section 7, and this document takes the same icon for the same meaning (2.2).

## 1. Scope and sources

- **In**: every control on every screen whose words an icon can shorten or make quicker to find: the top bar, the toolbar and every tool's options, the side panel tabs and More, every panel's header and buttons, the token action bar and Token panel, the tracker, the Dice panel, cards, sheets, dialogs, the Menu, the DM panel and Library, Home and Join, and the table display.
- **Out**: new features. No stored data, op or protocol changes. A button's name for a screen reader never changes unless section 4 says so.
- **Lucide is for interface controls**: close, back, undo, delete, edit, hide from players. Its path data is copied into `client/components/Icon.tsx` (6), never installed as a package.
- **game-icons.net is for game concepts**: a condition, a status, a creature type, a die. Lucide's `dices` is not used: a die is a game concept, and every Roll button keeps its word (3.1). Where a game concept needs an icon Lucide lacks, it comes from the game-icons files already shipped in `public/game-icons` and credited through `shared/credits.ts`, never a new source.
- **Nothing is drawn new.** The app's own icons stay where they read as well as Lucide's (5). No AI art, no new hand-drawn shapes.

The audit read every client file for visible words on controls. Its two tables (about 300 rows) are the source of section 4. Real width savings are modest, 11 to 65 px per control. Most of the gain is in scanning: a trash can is found faster than the word Delete in a row of five buttons, and one icon per meaning teaches itself.

## 2. One icon, one meaning

### 2.1 Names are meanings

`IconName` names a meaning, not a picture: `hidden`, not `eyeOff`. A caller asks for the meaning it shows, so two meanings can never share a drawing by accident, and a test checks it (8). Every meaning below has one drawing, used everywhere that meaning appears and nowhere else.

### 2.2 The vocabulary

| Meaning (`IconName`) | Drawing | Source | Used for | Never for |
|---|---|---|---|---|
| `close` | x | app (same as Lucide `x`) | Close a sheet, dialog, pane or popover. Clear a field | Delete, Fail |
| `back` | chevron left | app (Lucide `chevron-left`) | Back to the panel, previous page | |
| `more` | three dots | app | A menu of more actions | |
| `chevronRight`, `chevronDown` | chevrons | app | A fold, folded or open | Next turn |
| `plus`, `minus` | + and − | app | Add a thing. A stepper's one step | Zoom |
| `undo`, `redo` | curved arrows | Lucide `undo-2`, `redo-2` | Undo and Redo, top bar and tool rows, Undo corner | Roll again |
| `again` | two looping arrows | Lucide `repeat` | Roll again, exactly as it went | Undo, Retry |
| `retry` | circular arrows | Lucide `refresh-cw` | Try a failed load or request again, Refresh | Roll again |
| `hidden` | eye struck through | Lucide `eye-off` | Hidden from players: a secret roll, a hidden token, DM only, players see black | The side panel's Hide (`collapsePanel`) |
| `shown` | eye | Lucide `eye` | Players see it: Shared ruler, shown handout, Reveal | View as a player, look at a thing on the map |
| `delete` | trash can | Lucide `trash-2` | Delete or remove a thing for good | Forget a saved room, Remove from the fight |
| `edit` | pencil | Lucide `pencil` | Edit | The Draw tool |
| `duplicate` | two pages and a plus | Lucide `copy-plus` | Duplicate a token, stamp or area | Copy a link |
| `copy` | two pages | app | Copy to the clipboard | Duplicate |
| `locked` | padlock | Lucide `lock` | A token that cannot be moved | Admin's pinned room |
| `speed` | footprints | Lucide `footprints` | A creature's speed | |
| `group` | two people | Lucide `users` | Several creatures at once: a group save, Members | |
| `collapsePanel` | framed panel, arrow | app (Lucide `panel-right-close`) | Hide the side panel | Hidden from players |
| `splitPanel`, `swapPanels`, `grip` | | app (Lucide `rows-2`, `arrow-down-up`, `grip-horizontal`) | The split panel, as the side headers design maps them | |
| `filter` | funnel | app (Lucide `funnel`) | Filters | |
| `expand` | four corners | app | Full screen | Fit the map (top bar's own) |

Build additions, in the same shape: `download`, `share`, `settings` (gear: settings only), `external` (`external-link`), `arrowUp` and `arrowDown` (move up and down, never a fold), `leave` (`log-out`), `crop`, `eraser` (clear a ruler or drawings), `focus` (Ping's Look here), `pass` and `fail` (`check` and `x` inside the DM desk's pair only). A picture, upload, search, paste and the X-card's pause kept their words, with no icon built for them.

Where an app icon and Lucide's draw the same shape (close, chevrons, plus, minus, copy), the app's stays, so nothing changes for no gain. The side headers design names Lucide equivalents for its icons (its section 7): this table agrees with every one, and either build may swap them without the other.

### 2.3 Collisions fixed

- Roll again used Redo's arrow (Roller.tsx:115, RecentRolls.tsx:166). It takes `again`, and Redo keeps its arrow alone.
- Ping and Pin both drew a pin. Ping takes Lucide `radar`, Pin keeps `map-pin`.
- "Show" meant four things: show to players (`shown`), look at an area on the map (`focus`), show on the map in the Outliner (crosshair), and "Show all" (no icon, words). Each keeps its words, and only the first wears the eye.
- "Clear" meant four things: close the bar (`close`), remove the ruler and drawings (`eraser`), range rings (`eraser`). The handouts' "Close" (stop showing) becomes "Hide" with `hidden`.
- `plus` also meant "larger" in Line up grid's steppers. Those take Lucide `zoom-in` and `zoom-out`.

## 3. The rules

### 3.1 When an icon replaces words

1. **Icon only, everywhere**: only for an icon read at once without hover on a phone: close, back, more, undo, redo, delete (trash can), the chevrons of a fold, plus and minus in a stepper, copy beside a link, search inside a field. The control keeps its words as its name (`aria-label`) and its tooltip.
2. **Icon only on a computer, icon plus words on touch**: an icon that a mouse user learns from its tooltip but a touch user cannot hover: hidden, locked, duplicate, edit, download, share, Undo corner. "On touch" means `(pointer: coarse)` (`lib/device.ts` `isCoarsePointer`), never the screen's width, so a tablet with a keyboard case and a phone behave as their pointer does. A touch control never relies on a long press.
3. **Icon plus words**: an icon that helps scanning where the words still carry the meaning: Secret, Group save in a menu, New page, Upload a file, Leave room, the Menu's rows. The icon sits before the words, `icon.sm` (16 px), `space(1)` apart.
4. **Words only**: an action whose meaning is specific: Roll, Apply, Send, Save, End turn, Ask the party, Next, Previous, Attack, Damage, Critical, Allow, Keep, Adv, Dis. Rules terms stay words: they are the game's vocabulary, and an icon would make a player guess.
5. **A toggle is named for the state it is in** and lit while it holds (the action bar's rule, docs/design-v1-token-panel.md 3.3), so a lit `hidden` reads "hidden", never "tap to hide".
6. **An armed control shows its words.** Delete is a trash can until its first tap, then the trash can and "Sure?" (`deleteButtonWords`), so a second tap is never a guess.

### 3.2 Text on hover

One `useTooltip` (`client/components/Tooltip.tsx`, prototyped with `IconButton`) replaces the native `title` on every icon-only control:

- **When**: on mouse hover after 500 ms, on keyboard focus (`:focus-visible`) after 150 ms, and as a bonus on a touch press held 500 ms, kept 1.5 s after the finger lifts. A pointer passing along a row shows nothing. A hold that showed the tip never also presses: the click the browser sends after it is dropped, on that control and only that once.
- **Where**: above the control with a 6 px gap, or below it where the screen's top leaves no room, centered on it and kept 8 px inside the window, at every interface size: the tip is placed in its own zoomed pixels, since the interface size zooms the chrome it sits in. It is placed before it paints, and hidden again as it closes, so a second show never paints a frame at the last spot. It never covers the control it names, so a click aimed at the button never lands on its tip, and the tip ignores the pointer (`pointer-events: none`).
- **How it stacks**: it opens in the browser's top layer (`popover="manual"`), so no scrolling pane, sheet, dialog or zoomed chrome clips it. The design's other popovers keep the shared base (docs/design-v1-tool-options.md 7).
- **Closing**: a mouse leaving (a finger or pen lifting off keeps its 1.5 s), focus leaving, a cancelled touch, Escape (caught but not marked used, so the room's own Escape still runs), any scroll.
- **Look**: 13 px text on a raised surface, a `border` outline, radius `sm`, shadow `float`, at most 240 px wide.
- **Screen readers**: the control's `aria-label` is its name. The tip is not read again, except where its words add words the name lacks: then it joins the control's own `aria-describedby`, if it has one.

The native `title` stays only on plain words that are cut (a long name in a chip), where the browser's own tip is what a user expects.

### 3.3 Touch, names and targets

- Nothing needs hover or a long press. A touch screen shows words wherever rule 2 asks, and the long-press tip is a bonus.
- Every icon-only control keeps its `aria-label` (the words it replaced, or better ones) and a 44 x 44 target. The icon draws at `icon.md` (20 px) inside it, `icon.sm` (16 px) beside words.
- An icon is decoration: the SVG stays `aria-hidden` (`Icon.tsx`).
- Color never carries the meaning alone: a lit toggle is the pressed look, not a tinted icon.

## 4. Replacements by screen

Widths at 100%: a small button is 7.7 px a character at 14 px weight 600 plus 24 px padding, an icon button 44 px. "Saved" is the width gone from its row. Rule numbers are 3.1's.

| Screen | Control | Today | Icon | Rule | Saved |
|---|---|---|---|---|---|
| Top bar | Undo, Redo | filled arrows | `undo`, `redo` (Lucide) | 1 | 0, one style |
| Side panel | More tab | "More" and a caret | `more`, the held panel's name kept when one is open | 1 | 31 |
| Toolbar | Ping | a pin | Lucide `radar` | label kept | 0, collision |
| Toolbar | Panels | inline hamburger | `panels` in Icon.tsx (Lucide `menu`) | label kept | 0 |
| Token action bar | Hidden | "Hidden" | `hidden` | 2 | 26 |
| Token action bar | Locked | "Locked" | `locked` | 2 | 26 |
| Token action bar | Duplicate | "Duplicate" | `duplicate` | 2 | 49 |
| Token action bar | Delete | "Delete" | `delete`, "Sure?" beside it when armed | 1 and 6 | 26 |
| Token action bar | More (group) | "More" | `more` | 1 | 11 |
| Token action bar | Clear (group) | "Clear" | `close` | 1 | 18 |
| Token action bar | Size − and + | text glyphs | `minus`, `plus` | 1 | 0, one style |
| Token panel | Speed, Passive Perception, Initiative | words in the stat block's header | `speed`, then "PP", "Init" (dice UI doc 5.1) | 3 | a line |
| Token panel | Change image, Add another image, Crop, Remove | four buttons under the picture | the Image group, Crop with Lucide `crop` and Remove with `delete`, Change image and Add another image in words alone (4.1) | 3 | about 100 px of height |
| Token panel | Delete this token | words | `delete` and the words | 3 | 0 |
| Dice panel | Again (newest roll) | redo arrow and "Again" | `again` and "Again" | 3 | 0, collision |
| Dice panel | Roll again (Recent rolls) | redo arrow | `again` | 1 | 0, collision |
| Dice panel | Secret | "Secret" | `hidden` and "Secret" | 3 | 0 |
| Dice panel | Group save | "Group save, DC 21 Dex" | "Group save", its DC in the row's header | 4 | about 80 |
| Tracker | Move up, Move down (ties) | words | Lucide `arrow-up`, `arrow-down` | 2 | 34 and 49 |
| Tracker | Remove from the fight | words | Lucide `user-minus` and "Remove" | 3 | 118 |
| Tracker | Undo an HP change | "Undo" | `undo` | 1 | 11 |
| Tracker | Clear selection, Close alerts | "Clear", "Close" | `close` | 1 | 18 |
| Draw, Fog, Builder | Undo corner | "Undo corner" | `undo` | 2 | 65 |
| Draw, Pin, Area, Stamps | DM only | "DM only" | `hidden` and the words | 3 | 0 |
| Ruler, Area | Shared | "Shared" | `shown` and the words | 3 | 0 |
| Ruler | Clear | "Clear" | Lucide `eraser` and "Clear" | 3 | 0 |
| Area, Stamps, Pin, Light, Label panes | Delete | "Delete" | `delete` | 1 and 6 | 26 each |
| Area, Stamps | Copy, Duplicate | words | `duplicate` | 2 | 11 to 49 |
| Grid | Nudge ← → ↑ ↓ | text glyphs | Lucide arrows | 1 | 0, one style |
| Grid | Squares smaller, larger | `minus`, `plus` | Lucide `zoom-out`, `zoom-in` | 1 | 0, collision |
| Scenes, Phases, Journal, Monster editor | Move up, down | "↑", "↓" | `arrowUp`, `arrowDown` | 1 | 0, one style |
| Journal | Edit | "Edit" | `edit` | 2 | 11 |
| Journal | Hide, Reveal a block | words | `hidden`, `shown` | 2 | 26, 11 |
| Journal, Areas, Monsters, Encounters | Delete, Remove | words | `delete` | 1 and 6 | 26 each |
| Handouts | Show, Close | "Show", "Close" | `shown` "Show", `hidden` "Hide" | 3 | 0 |
| Handout popup | Download, Share | words | Lucide `download`, `share` | 2 | 42, 18 |
| Log | Export | "Export" | `download` | 2 | 26 |
| Members | Manage | "Manage" | `more` | 1 | 26 |
| Menu | Members, Room settings, This device, About, Leave room | rows | `group`, `settings`, Lucide `smartphone`, `info`, `leave` before the words | 3 | 0 |
| PC stats editor | ↗ after D&D Beyond | glyph | `external` | 3 | 0 |
| DM desk | Pass, Fail | words | `pass`, `fail` before the words | 3 | 0 |
| Home, Admin | Refresh, Try again, Sign out | words | `retry`, `leave` before the words | 3 | 0 |
| Table display | Previous page, Next page, Close | words | `back`, `chevronRight`, `close` | 1 | 80, 49, 18 |

Stays words, by rule 4: Roll and every roll option, Apply, Send, Save, End turn, Ask the party, Next and Previous turn, Allow, Keep, Accept failure, Adv, Dis, Critical, Used, Short rest, Long rest, Ready, the X-card. The tools' labels under their icons stay: the toolbar is a row of icons already, and its words are what a new player reads first.

### 4.1 What the build changed from the table

- **Undo corner keeps its words** beside the undo arrow on every pointer (rule 3, not 2). While a polygon is drawn, Undo's arrow alone stands in the same row, and two bare arrows side by side would read as one control.
- **A tool row's Delete keeps its words** beside the trash can (Stamps, and every confirm button in a slot). A slot holds its widest form so a row never moves (docs/design-v1-tool-options.md 6.2), and the armed words are its widest, so a trash can alone saves nothing there. The Area's Delete, which acts at once, is the trash can alone. The Light, Pin and Label panes' Delete is the trash can until armed (rules 1 and 6).
- **The Monsters panel's Edit and Delete** keep their words beside their icons: the two share their row half and half.
- **The Image group's Change image and Add another image** keep their words alone. With an icon each, the pair no longer fit beside the 48 px picture in the side panel or on a 390 px phone, and that compact row (docs/design-v1-token-panel.md) is worth more than the icons. Crop and Remove, on their own line, wear `crop` and `delete`.
- **The side panel's More tab** is left to the compact side headers build (docs/design-v1-side-headers.md), which owns the tab row.
- **The Menu's DM guide row** takes Lucide `book-open` (`guide`), so every row has its icon.
- **Tags** take an icon before their words: the tracker's Hidden and "Secret until its turn" wear `hidden`.
- **Try again** wherever a load failed takes `retry` (rule 3), and the outside links ("Open the sheet", D&D Beyond) take `external` after their words in place of "↗".
- **Pass and fail** draw the app's own check and cross: they share those drawings on purpose, the one listed exception to 2.1 (`components/icons.test.ts`).

## 5. The app's own icons: kept or replaced

- **Replaced**: `undo` and `redo` (filled arrows, the only filled shapes in a stroked set) by Lucide `undo-2` and `redo-2`, in Icon.tsx and in the top bar's own copy (RoomChrome.tsx), which then draws from Icon.tsx.
- **Kept, same as Lucide's shape**: close, back, chevrons, plus, minus, check, copy, filter, expand. The side headers design's mapping to Lucide names is a rename at most.
- **Kept, better than any Lucide icon**: the area shapes (`areaCone` and the rest: game templates), `fogBrush`, `fogRoom`, `windowHome`, `resetZoom`, `noCaster`, `collapsePanel`, `splitPanel`, the tool shapes.
- **Kept as game-icons**: conditions, statuses, token icons, unchanged.

## 6. Copying and credit

- **Copy, do not install.** Each Lucide icon's `iconNode` (version 0.525.0, as the build's reference) becomes the JSX of one `SHAPES` entry: its paths joined into one `d` where they share the stroke, with a comment naming the Lucide icon and the meaning. The stroke is the app's `STROKE` (2 px, round caps and joins), which is Lucide's. A test (8) holds the list of Lucide-sourced names, so the credit names exactly the icons copied.
- **Credit.** `shared/licenses.ts` gains `ISC`. `shared/credits.ts` gains the group "Interface icons" with Lucide's credit: its authors (Lucide Contributors, with portions by Cole Bemis as part of Feather, MIT), the source, the license, and in its changes the full ISC notice (`LUCIDE_NOTICE`), which the license asks to appear in all copies, then Feather's MIT notice (`FEATHER_NOTICE`) for the copied icons Lucide's license lists as derived from Feather (`FEATHER_ICONS`). The About page shows both from there. `CREDITS.md` gains the section "Interface icons" with the icons listed and both license texts verbatim. Both are in the prototype.
- **Repository notices**: the README's license section links CREDITS.md already, so no new file is needed.

## 7. Screenshots

Under `screenshots/icons/`, `before/` from the stacked tip (with this pass's fixture option, `?diceui=1`) and `after/` from the prototype. `p-` is 390 x 844 on touch, `d-` 1280 x 800:

- `room-dm-bar` and `p-room-dm-bar-foot`: the DM's goblin with its action bar. Hidden, Locked, Duplicate and Delete as icons on a computer. On the phone, Hidden, Locked and Duplicate keep their words beside their icons and Delete is its trash can alone (the foot shot scrolls the bar to them).
- `draw-options`: the Draw tool's row and the top bar, Undo and Redo in the stroked Lucide arrows.
- `dice`: the Dice panel's Secret chip with its icon, and Recent rolls' Roll again.
- `token-panel`: the quick numbers under the name, speed after its footprints.
- `d-tooltip-hover` and `d-tooltip-focus`: the tip above Recent rolls' Roll again on hover, and above Hide panels on keyboard focus. Before, the hover shows nothing in a headless shot (the native `title` waits about a second and draws outside the page) and focus shows no name at all.

## 8. Tests

- `components/Button.test.ts` (extended): every `IconName` draws and hides itself, an icon alone is named by its words and shows them in its tooltip, never a native `title`, and words beside an icon keep the native one.
- `components/icons.test.ts` (new): every meaning draws a shape no other meaning draws, except the listed pair (pass and fail), and the Lucide-sourced names (`Icon.tsx` `LUCIDE`) match `shared/credits.ts` `LUCIDE_ICONS`, the credit's changes and CREDITS.md, so a new copied icon cannot ship uncredited.
- `components/Tooltip.test.ts` (new, node:test with a fake clock): hover waits 500 ms and a quick pass shows nothing, focus by keyboard shows after 150 ms and a mouse focus never, a held touch in the browser's own order (enter, down, up, leave) shows after 500 ms and stays 1.5 s, the click after a hold that showed it is dropped once, Escape, scroll, a cancelled touch and a mouse press close, a randomized run of the timer's events, and the placement above with room, below without, never over the control, at interface sizes from 85% to 130%.
- `components/icons.test.ts` also checks that the ISC credit carries the license's whole notice, and that every copied icon from Feather, and only those, carries Feather's MIT notice on the About page and in CREDITS.md.
- A source scan (`lib/uiPassScan.test.ts`, the drift test's pattern): no text glyph (← → ↑ ↓ ↗ × − + as a whole label) inside a button, a `SmallButton` included. The native `title` cannot reach an icon alone: `Button`, `IconButton` and the top bar's buttons draw the tooltip in its place.
- e2e: the touched files only. `e2e/size.e2e.ts` and `e2e/reach.e2e.ts` (every control still in reach at every size), and the action bar's names (`Hidden`, `Locked`, `Duplicate`, `Delete` stay its buttons' accessible names, so `getByRole("button", { name })` queries keep working).

## 9. Build plan

One part, after the dice UI part's Icon.tsx commit (which brings the first Lucide icons and the credit), in this order:

1. `useTooltip` adopted by IconButton and every icon-only Button, `title` removed from them (the drift scan above).
2. Icon.tsx's build additions (2.2), each one commit with its callers: the action bar and panes, the tracker, the tool rows, the panels, the pages.
3. The collisions (2.3) in their own commit, since they change what an icon means.
4. FEATURES.md: "Icons with their names on hover and focus" under the interface section.

The side headers build and this one both touch Icon.tsx: whichever lands second rebases onto the other's names, which agree (2.2).

## 10. Decided by the project owner (2026-10-17)

1. **The toolbar keeps its labels.** The words under the tool icons stay on every screen: they teach the tools, and dropping them would save no width in a fixed row.
2. **The Menu's rows take leading icons** (rule 3): Members, Room settings, This device, About and Leave room, each with its icon before its words.
