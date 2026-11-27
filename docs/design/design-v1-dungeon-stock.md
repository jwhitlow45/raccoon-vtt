# A generated dungeon stocked with monsters

Read at main rrnzvkps a6ed9ce2 (OP_VERSION 67, SNAPSHOT_VERSION 50). Decisions D-261127-056 to 075 and 218 to 229 and 280 to 285, with the coordinator's D-261127-216 (amended) and 217. The starting point is the Next list's agent decision D-261127-048 ("a Monsters choice in the Make dialog, starting at None, placed hidden, one undo"), held to the project's value bar of 2026-11-26.

## 1. What the DM sees

Generate a dungeon and Add a wing share their rows (dungeon/Choices.tsx). The new rows stand after Dressing and before DM key, since the key lists what they make.

- **Monsters**, a slider like Lit rooms: percent of the rooms other than the entrance, steps of 5, marks None, Few (25), Half (50), All (100). It starts at None. Its words, "About 3 rooms of 12 get monsters", use Heights' rounding (`raisedCount`), so Few always picks one room on a small map.
- While above None, help: "Each of those rooms holds one fight for the party at this difficulty, from the SRD monsters that suit the theme. They stand hidden from players until you show them."
- **Difficulty**, a segmented choice: Low, Moderate (default), High. Help from the live budget (budget.ts `partyBudgets`, `xpText`): "Moderate: 900 XP a room for 4 characters at level 3."
- **Party**: the Encounters panel's party editor, reused whole. It reads "The room's characters: 4 at level 3." with **Edit the party**, and its unleveled and no-characters lines come with it. Edited, it shows its steppers and level selects.
- **One party (D-261127-217, 219).** While Monsters and Traps are both above None and the party has a level, the Traps row's **Party level** is held at the band of the party's mean level, weighted by count and rounded down, with "Set from the party: levels 1 to 4." When a live level-up has put the party in another band since, it adds "The party is now level 5. The band moves when you next change the party or Monsters." (D-261127-229). Otherwise it is the DM's own pick, which the dialog keeps. The band moves only on the DM's own changes and Held changes, never on a level-up while the dialog is open (section 4, the band).
- With no leveled party, the room's or an edited one emptied to no levels, Monsters is held at None (`Held`, as Cave holds Secret doors) with "Give the party a level to stock rooms: set one on a character's card, or edit the party below." The pick comes back once a level is set.
- **Loading.** Above None the SRD list loads (monsters/srdBlocks.ts `useSrdBlocks`, the chunk the Monsters panel shares). The foot says "Loading monsters…" through the shared delayed indicator, and Make stays off. A failed load shows `SrdLoadFailed` under the row, and None makes Make work again.
- **Theme lines** under Monsters: Dungeon "Goblins, bandits, cultists, beasts of the deep, oozes and constructs.", Crypt "The undead and the constructs that guard them.", Cave "Beasts, swarms, oozes, fungi and the things that lair in the dark.", Mine "Elementals, constructs, burrowers, goblins and kobolds.", Sewer "Rats, snakes, crocodiles, swarms, oozes, otyughs and wererats."
- **The foot** adds "14 monsters in 3 rooms": "12 rooms (1 secret), 18 doors (3 locked, 2 secret), 4 traps, 14 monsters in 3 rooms." It counts the rooms that hold creatures, so a picked room with no spot is not counted.
- **Marks.** The preview rings each creature's footprint in the board's hostile red, outlined as light rings are (marks.ts `monsterMarks`). Look closer and the wing's ghost draw them too. All three stay on the DM's device.
- **Redraws.** Reroll and a new seed draw new monsters with the rest. The preview also redraws when a character in the room's party gains a level or the room's monster images change, since the party follows the characters live (section 4, the preview key).
- **Make** sends the creatures in the dungeon's one Setup step. Undo setup takes them back with the dungeon or wing, and the scene's Delete removes them. Past 60 the changes go out paced, and the foot counts them ("Making the dungeon… 96 of 132").

### Room edits (Edit rooms)

The panel gains a **Monsters** row shaped like Lit: **Off** and **On**, the room's list as its help ("Goblin Boss, Goblin Warrior × 3 · 350 XP"), then **Other monsters**, which draws another fight for that room as Other props does.
- Report: "No spot for monsters here, so it has none." (a picked or edited room where nothing fits).
- The entrance starts Off and may be turned On. The row shows only while Monsters is above None. Reset room puts a room back to what the share gives it.
- Changing Monsters, Difficulty or the party keeps room edits (D-261127-063). A change that moves the Traps band drops them as any choice does, with Bring them back, since the band shapes traps and Rolling Stones.
- **The creature limit (D-261127-280).** Edits are never refused or trimmed. When the rooms' claims (section 4, stocking) pass the limit, one line stands in the Monsters area, a polite live region: "Over the creature limit by 3. Turn a room's monsters off, or lower Monsters." Make is off with that reason until the claims fit again.

### DM key

- Each room's block gains, after its traps: "Monsters (Moderate, 350 of 900 XP): Goblin Boss, Goblin Warrior × 3." Names keep the SRD's spelling, and "× n" counts as sizes do, so no plurals are made.
- When any room is stocked, the intro gains: "Each room's monsters stand hidden from players. To show them, select them with the Select tool, a box drag takes a room's at once, and turn off Hidden. Start a fight from the same selection."
- Made with gains "Monsters Half at Moderate for 4 at level 3". An off-mark share reads as Lit rooms' does, "Monsters 35% at Moderate…" (keyPage.ts `onMarks` with `percent`). At None, Made with says nothing of monsters, so every keyed op at None stays as it is (D-261127-073).
- With DM key off the creatures still land, and the room panel still lists them.

### Phones, tablets, computers

The rows are existing controls in the choices column (computer, tablet) or the sheet under the pinned preview (phone upright). Phone sideways keeps the dialog's layout. The party editor's steppers are 44 px and its selects 16 px. In the wing pane (a 296 px card, or a bottom sheet under 600 px) the rows scroll above its foot. Nothing needs hover or a long press. No new key or gesture, so the shortcut sheet and its FEATURES list do not change.

## 2. Rules (SRD 5.2.1) and other tools

- "Combat Encounter Difficulty" names Low, Moderate and High, and its "XP Budget per Character" table gives each character's row. The monster step says to "spend as much of your budget as you can without going over". Each stocked room is one encounter at the chosen difficulty, and its total stays within that budget, so the Encounters panel's `difficultyOf` rates it there or lower.
- XP is each stat block's own. Creatures are placed out of their lair (D-261127-066).
- SRD 5.2.1 blocks have no habitat, so theme fit is by type, with per-theme lists (section 4).
- Ideas from other tools (no code read): donjon stocks rooms with "3 × goblin" lines, XP and a difficulty for a party level, the shape of the key line here. Watabou's One Page Dungeon writes occupants into the room key. Foundry and Roll20 leave stocking to modules.

## 3. Privacy

- Every creature is `token.create` with `visibility: "dm"` (factory.ts `monsterToken` with `hidden: true`). The projection sends no player's device the token, name, stats or place, live or on a reload. Numbers wait until the party first sees one.
- The key page stays `access: "dm"`, and its pins `visibility: "dm"`. The preview, Look closer and the ghost are local to the DM's device, and no op carries them.
- Existing residual: hidden creatures count toward the scene group's 500 tokens.
- **Twin test.** New `server/rooms/dungeon.stock.twin.test.ts`, through the room actor (`scopeActor`, `privTwins`, `FrameReader`):
  - Twin A lands the fixture's stocked dungeon. Twin B lands the same ops without the monster `token.create`s, keeping A's key page, so the twins differ in the hidden tokens alone.
  - P1's and the display's frames must match byte for byte, and a raw scan of P1's frames must find no monster srdId or name.
  - Cases:
    1. Players on another scene while the dungeon lands.
    2. Moved there on Explore, in the entrance, with no stocked room in sight.
    3. A PC walks into a stocked room on Explore, so its creatures are in the PC's sight.
    4. Reveal by hand of that room.
    5. A reload while that room is revealed.
    6. Undo setup and Redo setup on another scene.
  - Control: the DM shows one monster in A, and P1 must get it.
  - Mutation check: an in-test flip sets A's monster tokens to `visibility: "all"` before landing, with no fixture rewrite. Cases 3 to 5 must then fail. Case 2 stays equal under the flip, since fog withholds tokens outside sight, and the test asserts that too (D-261127-074).
- **Ghost.** e2e `dungeonwing.e2e.ts` step DSTOCK-W: the player's page holds no monster token and draws no ghost while the DM plans a stocked wing.

## 4. Model and code

**No format step (D-261127-056).** The creatures are ordinary `token.create` ops built by `monsterToken`, as the encounter drop builds its tokens. The Rolling Stone uses `blankToken`.
- OP_VERSION stays 67 and SNAPSHOT_VERSION 50. Replay reads the stored ops, and export, import, Duplicate and backups already carry tokens. There is no migration.
- `GENERATOR_VERSION` stays 9. At None nothing in `DungeonSettings`, the plan, Made with or the ops changes, so plan.golden.fixture.json, the op fixture and server/rooms/dungeon.fixture.json's existing entries are untouched. If any of them must be rewritten, a test checks that every old sha256 equals its new one, since `rewriteRefused` skips cases whose settings changed.

**Stock choices sit beside the settings (D-261127-061).** settings.ts adds `type StockChoices = { monsters: number; difficulty: Difficulty }`, `DEFAULT_STOCK` (`{ monsters: 0, difficulty: "moderate" }`), `clampStock` and `MONSTER_PRESETS`. `DungeonSettings` is not changed.
- remembered.ts's `Choices` gains `StockChoices`, so the dialog remembers them per room and device. The wing pane holds its own, starting at `DEFAULT_STOCK`, as its settings start at `DEFAULT_SETTINGS`.
- Choices.tsx takes `stock`, `onStock` and a `party` slot. `editLayout` and `editsHold` are untouched: their settings JSON holds no stock.
- Lane B makes the dialog's `set` (GenerateDialog.tsx:280-283) and the pane's `setSettings` (builder/WingPane.tsx:324-328) leave edits alone for a stock or party change: `onStock` and the party editor write state without `dropEdits` or `editStep`, unless the band moves.

**The band (D-261127-219).** `settings.band` is frozen by `editLayout`, and `planFitted` (plan.ts:272) ignores edits whose layout fails `editsHold`. So the band never changes behind the edits.
- Choices keeps `band`, the band the settings carry, and `ownBand`, the DM's own pick (remembered).
- The followed band is worked out only at these transitions:
  - Monsters crossing None, either way
  - Traps crossing None while Monsters is on
  - a party editor edit
  - Monsters' Held state changing as the room's characters gain or lose their last level.
- A transition that changes `band` writes through `set`, with the normal drop and Bring them back. One that keeps the band writes the stock alone, and the edits stay.
- A live level-up in a standing party moves the budget and the monsters (062), never the band.
- With Traps at None nothing follows, since the row is hidden (Choices.tsx:196).
- `Before` (GenerateDialog.tsx:72) and `WingBefore` (WingPane.tsx:250) gain `stock` and the edited party (or null). So Bring them back (GenerateDialog.tsx:294-299 and the pane's) restores the choices with their band, the stock and the party, and the edits hold again.

**The party is not a setting (D-261127-062).** The request carries `partyFromCharacters` of the room's characters, live, or the dialog's edited party, kept until close. The seed's promise becomes "on the same version of the app, at the same feet per square, for the same party".

**Contract (the first commit, lane A):**

```ts
// stockPools.ts
export type StockMonster = Omit<SrdMonster, "statBlock"> & { image?: ImageRef };
export function stockPool(list: readonly SrdMonster[], theme: Theme, images: Pick<RoomState, "srdImages">): StockMonster[];
// worker.ts and client.ts: the preview and wing requests gain
stock: { choices: StockChoices; party: PartyGroup[]; pool: StockMonster[]; tokensLeft: number } | null; // null at None, without a party, or before the list
// shared/limits.ts: exported beside sceneCounts
export function sceneTokensLeft(state: RoomState, sceneId: string): number; // 500 less every token on the scene's floor group
// Its doc says it counts seat-held tokens on purpose, though restLimits' restOf (limits.ts:2209) leaves them out: it may stock fewer, never be refused.
// plan.ts
export type PlanMonster = { srdId: string; room: number; x: number; y: number }; // the token's corner as placed
// DungeonPlan gains monsters?: PlanMonster[] (absent at None). KeyRoom gains monsters?: { lines: [string, number][]; xp: number; budget: number }
// Planned gains standable(i: number, k: number): boolean
// RoomEdit gains monsters?: boolean and monstersDraw?: number. RoomFacts gains share: boolean and monsters: { on: boolean; lines: [string, number][]; xp: number } | null
// stock.ts: the pure check the dialog, the pane and the tests share
export function stockClaims(rooms: readonly Pick<RoomFacts, "room" | "share">[], edits: DungeonEdits["rooms"] | null, perRoom: number): number;
export function stockCapacity(tokensLeft: number, stones: number): number; // min(MAX_MONSTERS, tokensLeft - stones)
export function perRoomCap(capacity: number, keptRooms: number): number; // clamp(floor(capacity / keptRooms), 1, MAX_ROOM_MONSTERS)
// client.ts: Summary gains monsters: number and stockedRooms: number
```

**The preview key (D-261127-220).** The dialog's key (GenerateDialog.tsx:174, its effect at :233) and the pane's effect dependencies add a cheap stock identity:
- the stock choices
- the party's JSON (at most 10 groups)
- the scalar `tokensLeft`
- `${theme}:${listLoaded}:${imagesRev}`, where `imagesRev` counts changes to `state.srdImages`'s identity.

The 50 KB pool is never stringified. Make reads `sceneTokensLeft` again and runs the same claim check. When the claims no longer fit, it sends nothing and shows the over-limit line.

**Pools (`stockPools.ts`, new, D-261127-065 with 216 amended).** Families are by base type, with the swarms folded in ("Swarm of Tiny Beasts" is Beast). A theme's first family weighs 3 and the rest 1.
- Dungeon: Humanoid, Fey (Goblinoid), Monstrosity, Aberration, Ooze, Construct, Giant.
- Crypt: Undead, Construct.
- Cave: Beast, Monstrosity, Ooze, Aberration, Plant, Giant, Dragon.
- Mine: Elemental, Construct, Monstrosity, Ooze, Fey (Goblinoid), Dragon.
- Sewer: Beast, Ooze, Aberration, Monstrosity (Lycanthrope), Humanoid.

Every pool leaves out Gargantuan, aquatic (walk 10 ft or less with a swim speed) and 0 XP blocks, Beast (Dinosaur), livestock, mounts and pets (Camel, Deer, Draft Horse, Elk, Giant Elk, Goat, Mule, Pony, Riding Horse, Warhorse, Elephant, Mammoth, Hippopotamus, Rhinoceros, Cat, Mastiff), open-sky birds (Eagle, Hawk, Owl, Raven, Vulture), and Commoner, Noble, Troll Limb and Homunculus.

Per theme:
- Dungeon, Crypt, Mine and Sewer also leave out wilderness animals and flying mounts: Lion, Tiger, Saber-Toothed Tiger, Panther, Polar Bear, Giant Goat, Blood Hawk, Swarm of Ravens, Hyena, Giant Hyena, Jackal, Axe Beak, Hippogriff, Griffon, Giant Vulture.
- Cave keeps its bears, apes, spiders, bats and wolves, and leaves out that list but Polar Bear, plus Pteranodon.
- Mine leaves out Adult and Ancient dragons, so its Dragon family brings kobolds, wyrmlings, Young dragons and the rest.
- Sewer's beasts come only from the vermin allow-list, by SRD id (D-261127-223). There are 23 at main, the insects counting Giant Wasp and Giant Fire Beetle:
  bat, giant-bat, swarm-of-bats, rat, giant-rat, swarm-of-rats, giant-centipede, spider, giant-spider, giant-wolf-spider, venomous-snake, giant-venomous-snake, constrictor-snake, giant-constrictor-snake, swarm-of-venomous-snakes, crocodile, giant-crocodile, frog, giant-frog, giant-toad, giant-fire-beetle, giant-wasp, swarm-of-insects.

Counted at main, the pools hold Dungeon 89, Crypt 28, Cave 131, Mine 88 and Sewer 64 blocks. Their cheapest blocks run 10 to 50 XP, within the smallest budget (50 XP). At levels 17 to 20 a Sewer's or Mine's strongest blocks (8,400 and 15,000 XP) can leave a High fight well under budget, which the key's "of" shows. stockPools.test.ts prints each pool's names for review.

**Stocking (`stock.ts`, new, pure).** It runs in the worker after `planFitted`, before landing (scratch.ts `previewOf`, `wingPreviewOf`).
1. Capacity is `stockCapacity(tokensLeft, plan.stones.length)`, which is `min(MAX_MONSTERS, tokensLeft - stones)`, so the planned Rolling Stones are reserved. `tokensLeft` comes from the page's `sceneTokensLeft`: a new scene gets 500, a new floor its beside scene's group, a wing its scene's group, sibling floors included.
2. The share's rooms are every kept room but the entrance, shuffled on lane `LANE_STOCK_ROOMS = 7`, first `raisedCount(monsters, kept)` of them, marked `share` in the facts. `perRoom` is `perRoomCap(capacity, kept.length)`, `clamp(floor(capacity / keptRooms), 1, MAX_ROOM_MONSTERS)` over every kept room, entrance included, so every room can be On at once within capacity and `perRoom` does not move with the Monsters slider (D-261127-285). It is 3 a room on Medium and 2 on Large, and the budget still applies, so the creatures come fewer and stronger. The over-limit line then shows only where kept rooms pass capacity, on a scene group near 500 tokens.
3. **Claims (D-261127-280, 281).** Each room claims a number that depends on the current choices alone, never on a draw, the budget or the pool:
   - an edit of On or Other monsters claims `perRoom`
   - Off claims 0
   - an unedited share room claims `perRoom`
   - any other room claims 0.

   `stockClaims` sums them. The dialog and the pane run it on every render against `stockCapacity`, and past capacity they show the over-limit line with Make off (section 1).
   - Nothing is trimmed, redrawn, reserved or stored to fit, and neither the planner nor the scratch landing asserts on capacity: an over-limit state is the DM's, not a bug (D-261127-282).
   - Bring them back, Reset room, a Difficulty, party or pool change, a sibling floor's tokens, and two taps before the worker answers all just change the claims or the capacity. The same check shows the result, and `EditsState` gains nothing (D-261127-283).
4. **Draws.** Each claiming room draws its fight on lane `1024 + 16 * i + (monstersDraw % 16)`, clear of the props lanes, with at most its claim's creatures. A room's fight depends on its own claim, lane and contents alone, so an edit never changes another room's fight (D-261127-064).
   - Tests: Off B, On A, On B at a capacity of 4. Low then High with an edit at the cap. Capacity 5 to 4, then Bring them back. Two taps with a delayed worker. Each ends within capacity or in the over-limit state with Make off, never an assert. Medium at Half with the entrance On, and Large with every room On, stay within the limit (285).
   - stock.prop.test.ts asserts that the creatures landed never pass capacity whenever the check lets Make on.
5. One fight:
   - The budget B is `partyBudgets(party)[difficulty]`, with no second table.
   - The pool is filtered to xp of B or less and to footprint sizes with an anchor in the room.
   - The draw picks a family by weight, then a shape: solo (25%), a leader with followers (45%) or a band of one kind (30%). Each shape spends as much of B as it can, and falls back to the most XP within B that fits.
   - A room gets at least one creature while any pool block fits.
6. Placement, without `firstFreeSpot`, whose rings run over the scene (SOL-06):
   - Per footprint size (Tiny and Small to Medium 1, Large 2, Huge 3), list the anchors inside the room's own box whose covered cells (`occupiedHexes` and `placedOnHex` on hexes) are all `standable` in that room on one ground.
   - Biggest creatures first, each takes the free anchor nearest the room's middle, ties by row then column. Its cells then leave every size's list.
   - On a wing, the scene's tokens (`occupiedBoxes`) are taken cells too.
   - A creature with no anchor is dropped with its XP, so the key lists what lands.
7. `standable` is read after the edit pass (plan.ts:766-905) from the final contents (SOL-02). It is room floor minus:
   - doorway inside cells, `clear`, stairs and dais stairs
   - overlay (pits, rubble, water, pillars, columns)
   - every final trap's squares (`picked.squares` after :899)
   - each final light's square and its stamp's cells (`stampSquares`, `fixedLight` lights included)
   - each final prop's squares
   - the key pin square.

   plan.ts changes only by building and exposing it.

**Ops (ops.ts).** `monsterOps(plan, pool, chunks, sceneId)` writes one `token.create` per creature:
- `monsterToken(m, { hp: null, hidden: true, inLair: false }, …)` with `statBlock: ""`
- the room's default image, carried on the pool (`monsterImage`)
- `placeOnGround` on the built chunks, so a dais raises it.

The order is build, dress, traps, monsters, key, and `withIds` freshens token ids already. send.ts:158 compares a token with an srdId without its place or visibility, so a DM who drags or shows one during a dropped connection's check does not read "incomplete" (D-261127-070).

**Key (keyPage.ts):** `roomLine`, `keyIntro` and `madeWith` take the stock as in section 1, with nothing added at None.

**Server:** no change. The creatures meet the checks every DM `token.create` meets.

## 5. Caps and performance

- **Caps.** `MAX_MONSTERS = 40` a dungeon or wing, `MAX_ROOM_MONSTERS = 6`, and `MAX_OPS = 100 + MAX_MONSTERS`. scratch.ts:133 and :290 keep the non-monster ops within 100.
- **Measured at main.** The largest square dungeons send 76 to 81 ops and hex ones 44 to 55. With creatures the most is about 121, which adds about 2 s past the burst of 60 at 20 a second.
- **The hand plan (lane A owns handPlans.ts).** `hundredPlan` stays as it is, and a new `handPlan140` adds 40 monsters, exactly 140 ops, with its fixture entry "hand140" and `Summary.monsters`.
  - ops.test.ts:144-146 asserts `MAX_OPS` on it, and scratch.test.ts:157-163 refuses it plus one trap with "141 ops, past 140".
  - caps.test.ts and caps.hex.test.ts titles say "Make's 140 ops".
  - Lane C moves dungeonsend DG2B-1 and DG2B-2 to "hand140" with their limits unchanged.
- **Fallbacks (D-261127-060).** If DG2B fails at 140, `MAX_MONSTERS` drops to 30, then to 20. If 120 also fails, the lane stops and reports. The remedy then is a `token.createMany` format step at op 68, opened with Next-list item 7.
- **Stocking speed.** The anchor lists cover at most a few hundred cells a room per size. caps.test.ts times stocking on the largest All, High, 8-at-level-20 case and asserts it under 50 ms in node, with the time in its DG_CAPS_REPORT line.
- **Request size.** Cave's pool, the largest, is about 130 blocks and under 50 KB per request, a cheap structured clone. The SRD chunk (about 0.5 MB) loads once, shared with the Monsters panel.
- **Bytes.** 40 inline actors come to about 20 KB of the DM's 3 MiB scene share.

## 6. Accessibility

- The rows reuse the labeled slider, segmented choice and party editor, and focus follows the column. Edit the party moves focus to its first stepper.
- Marks are `aria-hidden`, and the preview's name carries the counts through the summary.
- Ring contrast: hostile red with `RING_OUTLINE` against the board, checked with the contrast helper. Nothing moves.
- Lane B adds a stocked, party-open variant to the alignment sweep's "dungeon-dialog" roots, at all six sizes.

## 7. Assets

None. Tokens wear the shipped SRD icons (`SRD_TOKEN_ICONS`, already credited) or the room's chosen image.

## 8. UI checklist and cases

Loading words: "Loading monsters…" (delayed 200 ms), then "Drawing the dungeon…". Keys: the sliders keep arrows, Home, End and Page keys, and Other monsters keeps focus. At 130% the rows and the list line wrap. The exact words are in section 1.

| Case | Expected | Test |
|---|---|---|
| Monsters None | Settings, plans, keyed ops and every fixture unchanged | plan.golden.test.ts, ops.fixture.test.ts (untouched) |
| Half, Moderate, 4 at level 3 | About half the non-entrance rooms picked, each total ≤ 900 XP | stock.test.ts |
| Any seed, grid, theme, party | Each creature inside its room, standable, on one ground, no overlap, within caps | stock.prop.test.ts (fast-check) |
| Trap added or replaced, light pinned, by Edit rooms | No creature on its squares, on squares, Hex rows and Hex columns | stock.prop.test.ts, stock.test.ts |
| Edit On, Off, Other monsters, Reset room | Only that room changes. Past capacity the over-limit line shows, Make is off, and no room is trimmed | stock.prop.test.ts, GenerateDialog.test.ts, WingPane test |
| Monsters, Difficulty or party changed | Edits kept, monsters redrawn | GenerateDialog.test.ts, WingPane test |
| Monsters None to Few with a differing band, and back | Band follows through `set`, edits dropped, Bring them back restores band, stock, party and edits | GenerateDialog.test.ts, WingPane test |
| Live level-up across a band with edits standing | Band unchanged, edits kept, monsters redrawn | GenerateDialog.test.ts, WingPane test |
| Traps None with Monsters on | Band not followed | GenerateDialog.test.ts |
| A sibling floor's tokens change during a stocked preview | Preview redraws, and the claim check (at render and at Make) shows the over-limit line when short | GenerateDialog.test.ts, send.test.ts |
| No leveled or an emptied party | Monsters held, no creature sent | Choices.test.ts, dungeon.e2e.ts |
| SRD list loading or failed | Make off with the words, None works again | GenerateDialog.test.ts |
| Dais room | Elevation is the dais's ground | ops.test.ts |
| New floor or wing, group near 500 over two floors | Capacity is the group's room less stones, and nothing is refused | send.test.ts, send.wing.test.ts, dungeon.wing.itest.ts |
| Largest choices, All, High, 8 at level 20 | Within 140 ops, 40 creatures, a 32 KiB key page, 50 ms | caps.test.ts, caps.hex.test.ts |
| Undo setup and Redo setup | Creatures go and come back | dungeon.itest.ts, dungeon.wing.itest.ts |
| Players | Nothing until shown, frames byte-equal, the flip fails cases 3 to 5 | dungeon.stock.twin.test.ts |
| Pools | Per-theme lists hold, every theme covers levels 1 to 20 at each difficulty | stockPools.test.ts |

## 9. Tests by file

- **Unit, new:** stock.test.ts, stock.prop.test.ts, stockPools.test.ts.
- **Unit, changed:** keyPage, ops, scratch, edits, settings, remembered, caps, caps.hex, send, send.wing, marks, RoomPanel, Choices, GenerateDialog and wingGhost tests, plus the limits test for `sceneTokensLeft`.
- **Fixture:** ops.fixture.test.ts adds a stocked Narrow dungeon and "hand140". The existing entries stay byte-equal.
- **Integration:** dungeon.itest.ts, dungeon.wing.itest.ts and dungeon.stock.twin.test.ts.
- **E2E:** dungeon, dungeonsend, dungeonwing and encounters (the moved party editor), plus reach.
- **Mutants to kill:** visibility (the in-test flip), the final trap squares in `standable`, the budget comparison, the per-room lane, the claims sum and its comparison, the draw within a claim, the band transitions and the stone reserve.

## 10. Lanes

- **Contract commit (S, lane A).** The section 4 contract types, StockChoices and `sceneTokensLeft`.
- **Lane A, stocking core (M).** stockPools.ts, stock.ts, scratch.ts, ops.ts, keyPage.ts, edits.ts (REPORTS only), fit.ts, plan.ts (`standable`), send.ts, worker.ts, client.ts, handPlans.ts, shared/limits.ts (the helper), their unit and caps tests, and ops.fixture.test.ts with server/rooms/dungeon.fixture.json.
- **Lane B, UI (M).** Choices.tsx, GenerateDialog.tsx, remembered.ts, RoomPanel.tsx, words.ts, marks.ts, Preview.tsx, LookCloser.tsx, builder/WingPane.tsx, builder/wingGhost.ts, builder/BuilderLayer.tsx and encounters/PartyEditor.tsx (moved out of EncountersPanel.tsx), with e2e dungeon, dungeonwing, encounters and alignmentRoom.ts.
- **Lane C, privacy and server tests (S).** dungeon.stock.twin.test.ts, dungeon.itest.ts, dungeon.wing.itest.ts and dungeonsend.e2e.ts. It starts after lane A's fixture commit.
- **Docs (S, last).** FEATURES.md, the DM guide's Generating a dungeon with one new stocked-preview picture, and this note as docs/design/design-v1-dungeon-stock.md.

## 11. Entry points for DFEAT

Everything here is under the dungeon generator's module:
- the Monsters, Difficulty and Party rows, and the held Party level line, in Generate a dungeon and the wing pane
- the room panel's Monsters row and Other monsters
- the foot's monster count
- the marks on the preview, Look closer and the ghost
- the key's Monsters lines and paragraph, which are journal text and stay in pages already made.

The party editor also lives in the Encounters panel and must not hide with the generator.

## 12. Decisions

- **056:** no format step: ordinary `token.create` ops. Rejected: `token.createMany` now (a format step for a client cap). It stays the last fallback (060).
- **057:** each stocked room is one encounter at the chosen difficulty. Rejected: one dungeon-wide budget (the SRD has none), Mixed (later, if asked).
- **058:** creatures are placed hidden. Rejected: visible under fog (Reveal by hand or sight would show them before the DM chose).
- **059:** `MAX_OPS` is 100 + `MAX_MONSTERS`, proved by "hand140". Rejected: fitting creatures into about 19 spare ops, and a second send (two undo steps).
- **060:** 40 a dungeon and 6 a room, measured at 140. Fallback 30, then 20, then the format step. Rejected: no cap (a 40-room High dungeon would want 200).
- **061:** StockChoices sit beside DungeonSettings, remembered in the dialog's Choices, starting at None. Rejected: new DungeonSettings fields (they move the golden settings and every keyed op), and None at every open.
- **062:** the party is the room's characters, live, or the dialog's edit until close. Amended by 217: the trap band follows it. Rejected: a remembered party (it goes stale).
- **063:** stock and party changes keep edits, with the UI skipping `dropEdits` for them. Rejected: dropping them (stocking moves nothing they pin).
- **064:** per-room lanes, each room drawing inside its own claim, with `perRoom` from every kept room (285). Rejected: `perRoom` from the share's count (one extra On at Half on Medium passes the limit), and a cap from the stocked count after edits (one edit redraws every room).
- **065:** per-theme pools as 216 amended. Rejected: one global ban (bears gone from caves, lions in sewers).
- **066:** out of their lair. Rejected: In lair on (the DM ticks it).
- **067:** the entrance is never in the share, but an edit may stock it. Rejected: a fight on arrival.
- **068:** SRD monsters only. Rejected: the room's own (no reliable type).
- **069:** per-room Other monsters only. Rejected: a dungeon-wide one (it breaks the seed's promise with no edit to disclose).
- **070:** send.ts compares monster tokens without place or visibility. Rejected: either kept (a DM's drag or show reads as incomplete).
- **071:** encounters/PartyEditor.tsx serves both. Rejected: a second editor.
- **072:** no saved encounter per room. Rejected: duplicates of placed tokens.
- **073:** `GENERATOR_VERSION` stays 9, and None leaves every fixture byte-equal. Rejected: a bump.
- **074:** the twin is the same ops without the tokens, with the key page kept, an in-test flip and the case 2 control. Rejected: a generator-made None twin, and a fixture rewrite to mutate.
- **075:** capacity is the scene group's tokens left less the planned stones, and placement reads the final reconciled contents. The scratch landing's capacity check is gone (282). Rejected: a fresh 500 for a new floor or a wing's floor alone (a partial send), and the pre-edit `used` set (creatures on edited triggers).

- **218:** the wing pane holds its own stock, starting at `DEFAULT_STOCK` each time it opens, with no wing-specific default. Rejected: remembering the wing's stock (its settings are not remembered either). This is the draft's 075 under a fresh id.
- **219:** the band follows the party only at the DM's transitions and Held changes, always through `set`. Live level-ups move the budget, never the band, and Traps None follows nothing. Bring them back restores the band, stock and party. Rejected: following live levels (it silently drops edits), and writing the band outside `set`.
- **220:** `tokensLeft` joins both preview keys, and Make reruns the claim check. Rejected: reading it once at open (a sibling floor's tokens could leave a ready preview past capacity).
- **280 (coordinator):** the creature cap is a pure claim check over the current choices, with the over-limit line and Make off. Rejected: tap-time acceptance with stored allocations, and reservations with fixed baselines recomputed per tap.
- **281:** the claims: On and Other monsters claim `perRoom`, Off 0, an unedited share room `perRoom`, any other room 0. Rejected: Other monsters claiming its last fight's count (that hangs on a draw).
- **282:** neither the planner nor the scratch landing asserts on capacity. The prop test holds landed creatures within capacity whenever Make is on. Rejected: a generator-bug assert (it fires on a DM's own state).
- **283:** no reset and no edit state: `stockReset` is gone, Reset room returns a room to its share claim, and `EditsState` is unchanged. Rejected: stripping monster pins on a share or capacity change (nothing is stored that could go stale).
- **284:** 221, 222 and 224 to 228 are withdrawn, since claims replace refusals, held places, acceptance, resets and the counter.
- **285:** `perRoom` is `perRoomCap(capacity, keptRooms)` over every kept room, entrance included, so turning every room On stays within capacity. The over-limit line is left for a scene group near 500 tokens. Rejected: `perRoom` from the share's count (Medium at Half plus one extra On is over by 2).
- **229:** the held band line reads "Set from the party: …", plus the level-up line when they differ. Rejected: "Follows the party below" (false after a live level-up).
- **223:** the Sewer allow-list is 23 SRD ids, Giant Wasp and Giant Fire Beetle counted as insects. Rejected: category words (they do not fix the set).

**Reviewers, look hardest at:** 059 and 060 (the op cap), 064 and 280 to 283 (claims), 065 (the pools), 075 (capacity and exclusions), 219 (the band).

## As built

Built as designed, with these places where the build went its own way or settled a gap the design left open (decisions D-261127-320 to 339):

- **Summary counts (320).** `Summary.monsters` and `stockedRooms` are optional, present whenever a preview is stocked (0 included) and absent at None, so the "hundred" fixture entry's stored summary stays byte-equal. The foot says ", no monsters" for a stocked dungeon with no creature.
- **The op caps (321).** Landing checks `MAX_OPS` (140) first, then the plan's own ops against `MAX_PLAN_OPS` (100) with "101 ops besides the creatures, past 100", so stocking never makes room for a plan the caps held before.
- **Standable (322).** Besides the listed exclusions, the cells under a statue's stamp are left out, though its trap's squares already hold it on every plan the tests drew.
- **Edits that do not hold (323).** A room's Monsters pin is read only while the edits hold on the plan's layout, the rule the planner already applies to every other pin.
- **The fight's shapes (324).** Each shape takes the highest total within the budget and the claim, drawing among exact ties, which are common since XP follows CR. A leader is any block of the family with followers of another block no stronger than it, a band is two or more of one block, and a shape that cannot be made falls back to the most XP one creature brings.
- **The timing (325).** caps.test.ts times stocking as the fastest of three runs per case, so a test run beside other work measures the stocking, not the machine's load. The slowest case was about 7 ms.
- **The privacy twin (326).** Twin B cannot drop the creature ops outright: the room's sequence and clock count every op, so the frames would differ from the first event after landing. Twin B lands each creature's `token.create` as a hidden "Stand-in" object on a scene no player is on, so the twins differ in the stocked creatures alone. Under the in-test flip, cases 3, 4 and 5 fail (and case 6, which compares frames from the start), and cases 1 and 2 stay equal, which the test asserts.
- **The wing's itest (327).** The wing fixture has no creatures and itests import no client module, so the stocked wing's creatures are the stocked fixture's tokens placed in the wing's rooms, not a generator-made stocked wing. Stocked wings made by the generator are covered by send.wing.test.ts and dungeonwing.e2e.ts.
- **A near-full wing (334, superseding 328).** On a wing whose own scene is within a few tokens of 500, the scratch landing refuses the creatures. The wing then lands again without them (`Preview.unstocked`), so the pane keeps its ghost, room facts and room panel, shows the creature limit, and keeps Add off.
- **Key rooms (335).** A key room names its place in `plan.rooms`, and a fight its board index, so the key finds each fight through `kept`. A property test drives dropped rooms with a small search budget (339), since full-budget plans seldom drop one.
- **The journal check (336).** The dialog measures the key page with the fights and Monsters line of the stock its preview was drawn with, as Make sends it.
- **The edited party (337).** An edited party keeps its rows while Monsters is at None, so Edit the party moves focus to its first stepper, and closing the editor gives focus back to Edit the party, in the dialog and the Encounters panel.
- **Fight order (338).** A fight lists its leader before its followers, though placement takes the biggest first, and the key and the room panel write a fight with one helper.
- **The party editor (329).** Its room-party lines stand in one block above Edit the party, so its notice keeps its fill on the column's edge in the alignment sweep. Nothing moves on screen, in the dialog or the Encounters panel.
- **The UI's guesses (330 to 333).** The Party row shows while Monsters is held, since the held line points to it. A mixed party's Difficulty help reads "for 5 characters: 4 at level 3, 1 at level 4". The theme's line follows Monsters' help in one paragraph. The seed's help adds "for the same party" only while Monsters is on. The over-limit line is a polite live region shown only past the limit, and it also stands under the room panel's Monsters row. Other monsters also turns its room On. The band follows the party as the dialog opens. The claim check, the stock request and its preview key live in dungeon/stockSource.ts, since builder files may not read the whole room view, and the token count must.

## Round 1 changes

- Section 5: R1-01 (the hand plan, lane A owning handPlans.ts) and SOL-06 (with stocking step 6).
- Section 1 and the case table: R1-02 and SOL-04 (900 and 350 XP), R1-10 (Hold, the foot, empty-room report), D-217.
- Section 4: R1-03 (stock choices), R1-04 and SOL-01 (stocking steps 2 to 4), R1-05 and SOL-05 (StockChoices, D-061, D-073), R1-06 with D-216 (pools), R1-08 (the preview key), R1-11 (`blankToken`, send.ts visibility, Made with, D-060's chain), SOL-02 and R1-09 (step 7), SOL-03 and R1C-01 (step 1).
- Section 3: R1-07 (twin cases, flip, key page kept, D-074).

## Round 2 changes

- Section 4: R2-01 and SOL-R2-02 (the band, D-219), R2-02 and SOL-R2-03 (the preview key, D-220), R2-04 (D-218, the `sceneTokensLeft` doc line), SOL-R2-04 (the Sewer ids, D-223).
- SOL-R2-01 and R2-03 (D-221, 222) are superseded by the claims of round 4.

## Round 3 changes

- R3-01: section 1, the held band line, D-229. SOL-R3-01 and R3-02 (D-224 to 228) are superseded by round 4.

## Round 4 changes

- R4-01 = SOL-R4-01, SOL-R4-02 and SOL-R4-03 (per D-280): `monstersHeld`, tap-time acceptance, `stockReset` and the scratch capacity check are removed. Stocking steps 3 and 4 now hold the claims and draws, section 1 the over-limit line, the contract `stockClaims`, `stockCapacity`, `perRoomCap` and `RoomFacts.share`, and the case table and mutants follow. See D-280 to 284.
- R4-02: no reset on a `tokensLeft` change (D-283). `tokensLeft` stays in the preview key (D-220).

## Round 5 changes

- R5-01: stocking step 2 (`perRoom` from every kept room), the contract's `perRoomCap(capacity, keptRooms)`, the step 4 test line, D-064 and D-285.
