# raccoon-vtt v1: full stat blocks for companions

Status: draft 2, for design review, with the project owner's answers of 2026-10-16 to draft 1's three questions (section 14). Code is cited from public main `e4ec8696`, where companions (docs/design-v1-combat-flow.md 3.6), full stat blocks on tokens (docs/design-v1-dm-tools.md 3.6) and the token panel's stat block and summary (docs/design-v1-token-panel.md 3.2 to 3.5) are built. This design ships after the PDF handouts build (docs/design-v1-pdf-handouts.md), which takes the snapshot to version 9, and builds on both without undoing either.

The project owner asked on 2026-10-16: "Add support for full stat blocks for companions (with import)." The answers that followed:

1. **Source.** Any SRD 5.2.1 stat block (an owl for Find Familiar, a wolf for a ranger), text from a book read by the existing "Paste a stat block" reader (`client/features/monsters/parse.ts`), or a block typed in the full editor (`client/features/monsters/MonsterEditor.tsx`). No file import.
2. **Who sees it.** The companion's own players and the DM. Other players see the token, its name and its HP as today.
3. **Who edits it.** The companion's players and the DM. The DM can always change it.

So "import" means bringing a block in from the SRD or from pasted text, never uploading a file.

Sizes are layout px, as in the other v1 designs. A number given as "about" illustrates a rule and is not the rule, so later layout changes do not make this document stale.

## 1. Summary

- **A character keeps its companions' stat blocks.** A new room-level collection, `companionBlocks`, holds stat blocks in the room monsters' shape, each belonging to one character. A familiar dismissed and summoned again finds its block waiting. A companion links one block through its actor: an SRD block by `srdId`, as tokens do today, or one of its character's own by the new `blockId`. An SRD pick is a link and stores nothing.
- **Readers.** A block reaches the DM and whoever owns its character, which is exactly who owns the character's companions. Other players and the table display get nothing new: the token, its name and its HP as today. The room's own monsters and the DM's default images for SRD monsters stay the DM's, and no path turns a room monster's block into a companion's. The DM pastes or types a block for a companion as a player does.
- **Picking and pasting as a player.** "Attach a stat block", the DM's picker today, opens for a creature companion's players too. It lists the character's own blocks, then the SRD's 330 with the Monsters panel's search, with "Paste a stat block" and "New stat block", which open the existing parser and editor. The SRD list is a public chunk of the app, so a player loads it without any DM data.
- **Attaching sets the numbers.** A second step offers the block's AC, max HP (its average, a typed number, or the current maximum), speed, size, senses, Passive Perception and initiative bonus, each change shown before it is sent. The link and numbers go in one op, and once it is taken the size goes as a resize of its own, by the rule of docs/design-v1-token-window.md, which owns resizing for every token: a player's companion ends only where a move could end, never across a wall, or keeps its size with "No room to grow here". Ctrl+Z right after attaching takes back the size alone (5.1). Current HP follows one rule (5.2) and never brings a creature back or puts it down. Temporary HP, conditions, effects, death saves, the Reaction and the initiative row stay. Saves and defenses are read from the block wherever they show. Detach keeps the numbers, and Change replaces the block in one step.
- **Where it shows.** The companion's token panel shows its block under the image, folded as this device left it, for the DM and its players. Its action bar shows the saves, the defenses and "Stat block". Its tracker row's and sub-row's options have "Stat block". The character's card names each companion's block and lists the character's blocks, and "Add a companion" can start from a block, which fills the form.
- **Effects.** A block belongs to a creature. An effect companion shows none and offers none, and keeps a stored link hidden, as it keeps its HP (docs/design-v1-combat-flow.md 3.6.6).
- **Scaling summons.** In this change: the block's text as printed, and the summon's AC and HP typed when it is added or attached. A spell level that fills the numbers in is later (section 7).
- **Security and limits.** Player text renders through the app's Markdown renderer as React text with links off, as stat blocks do today. Every line keeps the room monsters' bounds, a block is at most 16 KiB, a character keeps at most 100 blocks and 512 KiB, and a room at most 600 blocks and 3 MiB, six characters at their caps. The DM's snapshot budgets grow by the blocks' 3 MiB and nothing else gains a byte from it (3.4). A player's block saves share a small per-member budget, past which a save is refused without holding up their other actions. Images pass the existing asset checks.
- **Versions.** The snapshot goes to version 10, after the PDF build's 9, with a step that adds the empty collection. The op version goes to 6, shared with the token window build, since the one-link rule changes what a stored link patch does (3.6). Rolling back means restoring the backup taken before the update.

## 2. Today

### 2.1 Companions

- A companion is a token with `companion: { of, turn, reactionUsed? }` (`shared/model.ts:620-637`), an inline actor of its own, and a kind that makes it a creature (`npc`, or `monster` for one the DM made from a monster's token) or an effect (`object`). Its owners are always its character's (`syncOwners`, `shared/reducer/companions.ts:56-66`), so "the companion's players" are the character's owners, co-owners included.
- Its owners may change, beyond any token's owner fields, its name, kind, link and Reaction, and the actor fields an owner edits on a character (`OWNER_TOKEN_FIELDS` and `OWNER_ACTOR_FIELDS`, `shared/permissions.ts:60-62`, `COMPANION_OWNER_FIELDS` at `:920`, `companionUpdateCheck` at `:931-942`). Not `srdId` and not `size`.
- A player adds one from the character's card with a name, what it is, a turn, a size, HP, AC and a picture (`CompanionForm`, `client/features/tokens/CompanionsSection.tsx:138-283`). `companionInput` (`client/features/tokens/companions.ts:104-131`) builds the actor from `blankActor`, so every new companion has a 30 ft walk, Passive Perception 10, initiative +0 and no senses, whatever it is.
- The server's check of a player's new companion (`companionCheck`, `shared/permissions.ts:1012-1067`) refuses `monsterId`, `legendary`, effects and DM notes on the actor and checks no other actor field. So a crafted op could set `srdId`, `creatureType`, `cr`, `xp` or `initScore`, of which the owner can afterwards change none.

### 2.2 Stat blocks on tokens

- An actor links one block: `srdId`, an SRD monster's slug, or `monsterId`, one of the room's own monsters (`shared/model.ts:695-702`). `attachPatch` sets one and clears the other in one patch (`client/features/monsters/statBlockLink.ts:51-55`). Nothing else in `client/` writes either in a patch: placing a monster sets them on the new token's actor, and Duplicate copies the actor whole.
- `statBlockShown` (`statBlockLink.ts:45-48`) decides who reads a token's block: the DM on a monster or an NPC, and any owner when the actor has an `srdId` (a druid's Wild Shape). So a companion with an `srdId` already shows its SRD block to its players, but nothing lets them set one.
- The token panel shows the block under the image (`client/features/tokens/StatBlockSection.tsx:42-152`), folded as this device left it (one `statBlock` fold for every token, `client/features/tokens/panelFolds.ts:17`). The DM gets Edit for a room monster, "Copy to this room's monsters and edit" for an SRD one, and Detach. A token with no link offers "Attach a stat block" to the DM alone (`:104-117`), which opens `MonsterPicker` (`client/features/monsters/MonsterPicker.tsx:23-87`). Attaching sets only the link, never the token's numbers.
- The action bar's saves and defense lines and its "Stat block" button read the linked block through `useLinkedBlock` (`client/features/tokens/StatSummary.tsx:55-61`) and `linkedBlockState` (`client/features/tokens/statSummary.ts:199-212`), which know room and SRD links (`client/canvas/TokenActionBar.tsx:170-172`, `:350-354`).
- A tracker row's options offer "Stat block" to the DM on any monster or NPC token (`client/features/encounter/Row.tsx:238`, `:636-645`), and so do a companion sub-row's options (`:391-397`). A player's row options have none (`:674-684`).

### 2.3 What is the DM's alone, and what is not

- The room's own monsters (`state.monsters`) and the DM's default image for each SRD monster (`state.srdImages`) are projected to the DM only (`shared/project.ts:895-907`). `monsterId` is stripped from every owner's actor (`projectActorOwner`, `:506-509`). Other players' copies of a token carry only its life, effects and the HP the DM allows (`:539-558`).
- **The SRD list is not DM data.** It is `shared/srd/monsters.json`, loaded by a dynamic import into a chunk of its own (`loadMonsters`, `shared/srd/monsters.ts:60-69`) and served like every other file of the build, with no session check (`server/http/static.ts:27`). Only the screens that load it are the DM's today, plus the owner of an SRD-linked token. The SRD is CC-BY-4.0, and the app shows its credit with its text (`client/features/monsters/StatBlockView.tsx:8`).

### 2.4 The parser and the editor

- `parseStatBlockText` (`client/features/monsters/parse.ts:259`) reads pasted 2024 or 2014 text in the browser, never throws, and returns the block with warnings for what it could not read.
- `MonsterEditor` (`MonsterEditor.tsx:52-109`) edits every line of a block as one draft and saves one `monster.create`, or a `monster.update` of the changed lines (`monsterPatch`, `client/features/monsters/draft.ts:51-60`). It closes as soon as the op is sent, since the DM's device predicts it.
- **A gap in the editor.** `monsterPatch` diffs the draft against `props.monster`. The Monsters panel passes the monster as it was when the editor opened (`client/features/tokens/MonstersPanel.tsx:85`), but the token panel's Edit passes the live one (`StatBlockSection.tsx:124`). So while that editor is open, a line another DM changes reads as changed in the draft and is sent back with the old text, undoing the other DM's edit, and the editor reads as having unsaved changes. Section 6.2 fixes it for every caller, since co-owners editing one block would meet it more often.

### 2.5 Room data, rates and versions

- Room-level collections ride in every DM snapshot and count toward the 3 MiB a DM's projected scene may hold (`ROOM_LEVEL`, `server/rooms/sizeGuard.ts:223-237`, docs/design-v1-dm-tools.md 2.4). The room's monsters are capped at 200 and 1 MiB, 16 KiB each (`shared/limits.ts:33-41`, `checkMonsters` at `:449-460`).
- A socket may send 20 ops a second with a burst of 60, the room has a rate of its own, and a frame is at most 64 KiB (`server/rooms/budgets.ts:117-158`, `server/rooms/actor.ts:286`). A `busy` answer leaves the socket's op sequence where it was, so every later op from that device answers `gap` (`actor.ts:772-778`), and the client pauses all sending while it backs off and resends (`client/state/store.ts:631-636`). A refusal (`#refuse`) advances the sequence, so later ops go on.
- Each snapshot the server builds counts against a budget of 30 MiB a minute per session and 60 per address (`DEFAULT_SNAPSHOT_BUDGET`, `server/rooms/budgets.ts:221-227`), ten of today's largest DM snapshot, 3 MiB. A socket whose send buffer stays over 4 MiB for 10 s is closed (`server/rooms/ws.ts:74-75`, `:268-273`), so one snapshot alone never trips it.
- At the storage quota a room accepts only the ops in `DELETIONS` (`server/rooms/actor.ts:176-188`, `:858`).
- `SNAPSHOT_VERSION` is 8 and `OP_VERSION` 5 at `e4ec8696` (`shared/migrate.ts:13-14`). The PDF build takes the snapshot to 9, and the token window build takes the op version to 6.
- Setting `srdId` alone in a patch keeps an existing `monsterId` today (`applyActorPatch`, `shared/reducer/tokens.ts:107-133`). The schema accepts such a patch from any client, whatever today's UI sends.
- An open page that receives a change to an entity key it does not know throws (`writeEntity`, `shared/keys.ts:322-324`), so a new collection asks for open pages to be reloaded after the deploy, as the PDF build's documents do.

## 3. Data model and ops

### 3.1 Where a companion's block lives

| Option | For | Against |
| --- | --- | --- |
| On the companion's token, a copy in its actor | Owners already receive the whole token. | Dismiss deletes it, so a familiar summoned again needs pasting again. A token is resent whole on every move, so up to 16 KiB would ride every drag. Tokens are scene data, so blocks would crowd a scene's own size budget. |
| Inside the character | Reused across summons, read by its owners. | A character is resent whole on every HP change, so its blocks would ride every hit on the character. |
| **A room-level collection, each block belonging to a character (chosen)** | Reused across summons. Its readers are the character's owners, who are the companions' owners. Each block is its own entity, sent only when it changes. Undo, replay, the size guard, export and remap already handle a collection of this shape (the room's monsters). | One more collection to register (3.6). |

```ts
export type CompanionBlockId = string;

/**
 * A stat block a character keeps for its companions
 * (docs/design-v1-companion-stat-blocks.md 3.1): text pasted from a book,
 * one typed in, or an SRD block copied to be edited. Read by the DM and by
 * whoever owns the character, who are the owners of its companions.
 */
export type CompanionBlock = StatBlock & {
  id: CompanionBlockId;
  rev: number;
  /** The character that keeps it. It never changes. */
  characterId: CharacterId;
  /** The SRD monster it was copied from, so its view keeps the SRD's credit. Absent for a block pasted or typed. */
  fromSrd?: SrdId;
};

// RoomState gains:
companionBlocks: Record<CompanionBlockId, CompanionBlock>;

// Actor gains:
/** One of its character's companion stat blocks, on a companion's own actor only (3.2). */
blockId?: CompanionBlockId;
```

- `StatBlock` (`shared/model.ts:813`) is the room monsters' shape: every line of a 2024 block, and an optional `defaultImage`, here the picture a companion added from the block starts with.
- An SRD pick is not copied. The companion's actor holds `srdId`, which its owners already receive and which costs no storage. A block is stored only when it was pasted, typed, or copied from the SRD to be edited. Nothing copies one of the room's own monsters into a block (Decided 1).
- `fromSrd` is set by the client on a copy and changes only the credit line under the block, so the server checks its shape alone.
- **Why the link is on the actor.** The other two links are there, and every reader of a link (`tokenStatBlock`, `attachPatch`, the summary) reads the actor, so rule 1 below can see all three in one place. And the actor is what other players never receive: the `companion` object reaches them while the token is the party's (docs/design-v1-combat-flow.md 3.6.5), so a link kept there would tell them which block a companion uses.

### 3.2 The link rules

One set of rules, enforced by the reducer for everyone, the DM included:

1. **One link.** An actor links at most one block. A patch that sets `srdId`, `monsterId` or `blockId` to a value deletes the other two from the actor. Today a patch naming `srdId` alone keeps an existing `monsterId` (2.5), and the schema lets any client send one, so this rule changes what such a stored op does. It therefore applies only to ops stored at op version 6 and later, and to live ops, through `oneLinkPerActor(opVersion)` in `shared/migrate.ts` beside `healRevivesDead`. An op stored at version 5 or earlier replays as it applied (3.6). And a player can attach a block to a companion the DM once linked to a room monster without seeing or naming `monsterId`. `tokenStatBlock` reads `blockId`, then `monsterId`, then `srdId`, which matters only for data from before this rule.
2. **Its own character's.** Only a companion's own actor holds `blockId`, and it names a block whose `characterId` is the companion's `of`. Setting a `blockId` that names no block is refused as `gone`. One of another character, or on any other actor (a character's, or a token that is not a companion), is refused as `invalid`, "a stat block belongs to its character's companions". A `token.create` whose actor holds `blockId` with another link is refused as `invalid`.
3. **It stays with its character.** A `token.update` that changes `companion.of`, or detaches the companion (`companion: null`), deletes the `blockId` the token held, in the same op. A `blockId` the same patch sets is checked against the companion as the op leaves it. An `srdId` stays, since it holds nothing of the character's.
4. **A deleted block leaves the link.** Deleting a block writes no token, as deleting a room monster writes none today. A link to a block that is gone reads as deleted (6.5) until someone attaches another or detaches. Ids are never reused, so such a link never comes to name another block.
5. **Kind changes keep it.** Making a creature companion an effect keeps its link stored and shown nowhere, as it keeps its HP, and making it a creature again shows it (5.5).

### 3.3 Ops and validation

| Op | Who | What |
| --- | --- | --- |
| `companionBlock.create { block }` | The DM, or a player who owns the character | Saves a new block under the id the client chose. `block` is `{ id, characterId, fromSrd?, ...the stat block lines }`. An id in use is `invalid`, a character that does not exist `gone`. |
| `companionBlock.update { blockId, patch }` | The DM, or a player who owns its character | The changed lines, in the shape of `monster.update`'s patch (`shared/protocol.ts:576-606`). `characterId` and `fromSrd` never change. |
| `companionBlock.delete { blockId }` | The same | Deletes the block and writes no token (3.2 rule 4). |
| `token.update` naming `actor.blockId` or `actor.srdId` | The DM, or the companion's owners | Attaches, changes or detaches a block, with the numbers of section 5 in the same patch. |

- **Schemas** (`shared/protocol.ts`). `companionBlockInput` is `z.strictObject({ id, characterId: id, fromSrd: srdId.optional(), ...statBlockFields })`, refined against `LIMITS.companionBlockBytes` as `monsterInput` is against the monster bytes (`:569`). Every line keeps its monster bound (`:521-566`): a name of 1 to 80 characters with no control or text direction characters, type and alignment 120 characters, speed 200, the other lines 500, the hit dice 40, at most 40 entries per section with a name of 120 characters and 4,000 characters of text each, scores 0 to 99, saves −20 to 40, AC 0 to 100, initiative −20 to 40 and HP 0 to 100,000. The update's patch reuses `monsterPatch` as it is. `actorSchema` gains `blockId: id.optional()` and `actorPatch` gains `blockId: id.nullable().optional()`. `server/rooms/stateSchema.ts` reuses both (`actorSchemaForImport` and `statBlockFieldsForImport`, `shared/protocol.ts:1251-1253`), so the import reads them with no second copy.
- **The reducer.** `shared/reducer/companionBlocks.ts`, new, beside `monsters.ts`: create, update and delete as `monster.*` do (`shared/reducer/monsters.ts`), with the character check on create. `characterDelete` (`shared/reducer/tokens.ts:420-429`) also removes the character's blocks, in id order, after its tokens. `characterCreate` and `characterUpdate` (`:383-418`) refuse an actor with `blockId`, a PC token's actor patch included, since it writes the character. `applyActorPatch` (`:107-133`) gains `blockId` and rule 1. `tokenCreate` and `updateCompanion` (`:46-100`, `:210-227`) gain rules 2 and 3, through one helper, `checkBlockLink(tx, token)` in `shared/reducer/companions.ts`, beside `checkCompanion`.
- **Restore** (`shared/reducer/misc.ts:168-240`). `referencesOf` adds a block's character, and the character scan of `checkReferences` counts a block as a use, as it counts a companion. So an undo never removes a character a block still names, nor puts back a block whose character is gone. A token's `blockId` is not a reference, by rule 4. A restored token holds the link it held then, which named its own character's block, and a block never changes character, so a restore cannot break rule 2.
- **Undo phrases** (`server/rooms/undoLabels.ts`): "adding the stat block Owl", "changing the stat block Owl", "deleting the stat block Owl". The DM's block ops go on the DM's stack, as every DM op does. A player's go on no stack, by the rule for players' stacks (drawings and moves today, and resizes with the token window design).
- **The log.** Block ops write no line, as monster ops write none. Attaching with new HP writes the line any set of the maximum writes.

### 3.4 Limits

| Item | Limit | Why |
| --- | --- | --- |
| One block, serialized | 16 KiB (`companionBlockBytes`, the monsters' number) | The longest SRD block is about 5 KB. |
| A character's blocks | 100, and 512 KiB together (Decided 2) | The project owner's numbers. An SRD pick takes no room. |
| A room's blocks | 600, and 3 MiB together (Decided 2) | Six characters at their caps, so each of a party of five or six can use its full 512 KiB. |
| A DM's snapshot | 3 MiB for everything else, as today, plus the blocks: at most 6 MiB | Below |
| A player's block saves | a burst of 10, then one every 6 s, per member | 3.5 |

**Why 600 and 3 MiB for a room, and what grows with it** (the project owner's answer, Decided 2).

- **A room cap is needed.** A room may hold 50 characters (`LIMITS.charactersPerRoom`), and 50 at 512 KiB would be 25 MiB, three times the room's 8 MiB state limit (`LIMITS.stateBytes`). So the character's caps alone cannot bound a room, and a room full of characters at their caps stops at the room cap.
- **It is six characters at their caps.** 6 x 512 KiB is 3 MiB and 6 x 100 is 600, so each character of a party of five or six can use its full 512 KiB. A typical block is about 2 KB serialized (the SRD's median is about 1.4 KB), so a party's real use is tens of KB. The 512 KiB a character may hold matters for long blocks: it is 32 blocks at the 16 KiB maximum, so for long blocks the bytes bind before the count.
- **The DM's scene budget grows by the blocks' cap, and only for them.** Blocks are room-level data and ride in every DM snapshot. Today the size guard holds a DM's projected scene, the room-level part plus the viewed scene's own part, to `LIMITS.projectedSceneBytes`, 3 MiB (`server/rooms/sizeGuard.ts:223-237`). The guard's measure leaves `companionBlocks` out, and the room cap holds them to 3 MiB on their own (`checkLimits`). So `projectedSceneBytes` keeps its 3 MiB for the monsters, the journal, the characters and the maps, exactly as today, and a DM's snapshot may hold the blocks on top: at most 6 MiB. That is the literal "raise by the block cap", without letting a map, a monster or a journal page grow a byte into the blocks' room. `checkWholeScenes`, the import's whole-room check (`:377-389`), reads the same measure.
- **What else counts a snapshot grows with it.** The snapshot budget (`DEFAULT_SNAPSHOT_BUDGET`, `server/rooms/budgets.ts:221-227`) holds ten of the largest DM snapshot, 30 MiB a minute per session and 60 per address. It becomes 60 and 120, ten of the new 6 MiB. The send-buffer limit (`server/rooms/ws.ts:74`, closed after 10 s over it) is 4 MiB, 1 MiB over today's largest snapshot. It becomes 7 MiB, the same margin over 6 MiB, so one snapshot alone never closes a slow socket. A player's snapshot holds only their own characters' blocks, under the same bounds.
- **The 8 MiB state limit still holds.** The size guard measures the serialized state before every op that could cross 8 MiB and refuses it (`SizeGuard.check`), so nothing ever passes it. What changes is how much room is left. With the blocks (3 MiB), the monsters (1 MiB) and the journal (1 MiB) all at their caps, those three take 5 MiB. The rest of the room-level data in a large room, 50 characters, the 200 log lines in memory, saved encounters, SRD images, the PDF build's handout documents and the fight with its history, is usually well under 1 MiB, and only reaches about 3 MiB with every one of those at its own worst case at once. So a room that heavy keeps about 2 MiB, at worst a few hundred KB, for every scene's maps, walls, fog and tokens, and meets the state limit on a map edit in the guard's words. The block cap binds before the state limit whenever the rest of the room is under 5 MiB, and when it is not, a block save gets the block's own words (below).
- **The DM's room load grows with it.** Every DM device downloads every block in every snapshot: each join, reload and scene switch. A room at the block cap adds up to 3 MiB to each, a few seconds on a slow phone link, behind the loading indicator that already covers a snapshot. A room with a few pasted blocks adds tens of KB. A block's change sends that one block, at most 16 KiB, to the DM and its readers.
- **Export and import.** `room.json` is the stored state, under 8 MiB, and the import applies every block cap absolutely (3.6), so no file brings in more.
- **The count bounds the scans.** 600 bounds every pass over the collection. `checkLimits` totals the blocks by character only when the collection changed, with each block's size measured once per version, so an op that touches no block costs a lookup.

**Every refusal of a block save says what to do about blocks.** `checkLimits` refuses with `quota` the op that would pass a cap: "Bree can keep at most 100 stat blocks. Delete one first.", "Bree's stat blocks can take at most 512 KiB together. Delete one first.", and "The room can hold at most 600 companion stat blocks. Delete one first." or "...3 MiB of companion stat blocks...". Where another guard refuses a `companionBlock.create` or `companionBlock.update`, the actor gives it the block's own words in place of the guard's, keeping the code: the state limit, "The room is too full to save this stat block. Ask the DM to free some space, then save again.", and the storage quota (2.5), "The room is at its storage limit, so stat blocks cannot be saved until the DM frees space. Deleting a stat block still works." The DM snapshot's guard never refuses a block save, since it no longer counts blocks. The editor shows a block's size against its 16 KiB from three quarters up, as it does for monsters (`MonsterEditor.tsx:154-157`).

### 3.5 Rate of edits

A save is a whole block of up to 16 KiB, and every op is stored. The socket's 20 ops a second would let one player write about a quarter of a megabyte a second. So the room actor keeps a token bucket per member for a player's `companionBlock.*` ops, holding 10 and refilled at one every 6 seconds (`LIMITS.companionBlockWriteBurst` and `companionBlockWriteRefillMs`).

- **A refusal, never `busy`.** `busy` would leave the device's op sequence unadvanced, so every later op from it, moves and HP changes included, would answer `gap` and the client would pause all sending until the save went through (2.5). So an op past the bucket is refused with `quota` through `#refuse`, which advances the sequence, and the device's other ops go on at once. It is checked where the storage quota's check is, after the op is read and before it is applied or stored (`server/rooms/actor.ts:858`). Its words are one exported constant, `BLOCK_SAVES_TOO_FAST`: "Too many stat block saves at once. Wait a few seconds, then save again."
- **The editor keeps the draft and offers the retry.** The companion editor waits for its save's answer (6.2), so the refusal shows in it with the draft intact. On that constant's words it disables Save for `companionBlockWriteRefillMs` with "You can save again in a few seconds.", then enables it again. The picker's and the panel's flows that save through the editor wait with it.
- A person saving by hand never meets it. The DM's block ops are not counted, as the DM's monster saves are not. A delete counts as a save, so a script cannot churn the op log with create and delete pairs.

### 3.6 Registering the collection, versions, export and import

The checklist every new collection follows (docs/design-v1-dm-tools.md 2.2):

- `shared/keys.ts`: a `companionBlock` kind, `companionBlock:<id>`, in the collection `companionBlocks`, for `parseKey`, `readEntity` and `writeEntity`. `shared/initial.ts`: `companionBlocks: {}`.
- `shared/project.ts`: `projectCompanionBlockCtx` in `projectEntityCtx` and `projectState`, `allKeys`, and the visible set (4.3). `dependents` needs nothing new: a block's readers change only with its character's owners, and a change of owners is already global (`isGlobalChange`, `shared/reducer/tx.ts:437-442`).
- `shared/reads.ts` (4.4), `shared/permissions.ts` (4.1), `shared/referencedAssets.ts` (4.3), `server/rooms/undoLabels.ts` (3.3), and `shared/testutil.ts` for the random fan-out test.
- `server/rooms/sizeGuard.ts`: the DM's projected scene measure (`ROOM_LEVEL`, `roomLevelBytes`, `SHELL_BYTES`) leaves `companionBlocks` out, and `checkLimits` holds them to their own cap, so a DM's snapshot is at most 3 MiB plus the blocks' 3 MiB (3.4). `server/rooms/budgets.ts` (`DEFAULT_SNAPSHOT_BUDGET` to 60 and 120 MiB a minute) and `server/rooms/ws.ts` (the send-buffer limit to 7 MiB) grow by the same 3 MiB per snapshot.
- `server/rooms/actor.ts`: `companionBlock.delete` joins `DELETIONS` (`:176-188`), so at the storage quota the DM and a block's owners can still delete blocks, the space the room most needs back. The per-member save bucket and the block words for a guard's refusal live there too (3.4, 3.5).
- **Snapshot version 10.** `SNAPSHOT_VERSION` goes from 9, after the PDF build, to 10, with a step that adds `companionBlocks: {}` to a state without it, as the journal's step did. If this build lands before the PDF build, it takes 9 and the PDF build takes 10, with the steps' contents unchanged.
- **Op version 6.** Rule 1 changes what a stored patch naming `srdId` alone does, keeping or clearing `monsterId` (2.5), so it applies from op version 6, the boundary the token window build introduces for its resize, through `oneLinkPerActor(opVersion)` in `shared/migrate.ts`: false for an op stored before version 6, true for one stored at 6 or later and for a live op, read in `applyActorPatch` with `tx.env.opVersion` as `healRevivesDead` is. The migration step from 5 to 6 returns the op unchanged, as the earlier steps do, and its comment names both builds' rules. If the two builds deploy together they share version 6. If the token window build deploys first, ops stored at 6 by then were made under today's link rule, so this build takes version 7 for rule 1 and its own step, with the same fixtures one version later. Everything else here changes no stored op's result: the new ops and `blockId` are new, and every permission change is checked only where ops arrive, never on replay.
- **Export and import** (`server/rooms/remap.ts`). `room.json` carries the blocks as stored. The import gives each block a new id, maps its `characterId` and drops a block whose character did not come through, maps its `defaultImage` with `image()` (`:139-145`) and drops one that did not come through, and maps every actor's `blockId` as it maps `monsterId` (`:129-135`), dropping a link whose block did not come through. Then `normalizeCompanionState` (`shared/reducer/companions.ts:179-207`) brings a hand-made file within rules 1 to 3: a `blockId` on an actor that is not a companion's, or naming another character's block, is dropped, and an actor holding `blockId` with another link keeps `blockId` alone. `checkLimits` runs on the import with absolute caps, as for every collection.
- **Deploy.** Nothing to run. The snapshot step runs on load. Reload every page left open across the update, table displays included: an old page cannot apply a change to a stat block (2.5). Only DM pages and the block's owners' pages ever receive one.
- **Rollback is a restore.** An older build cannot load a version 10 snapshot or replay an op stored at version 6, since `runMigrations` refuses to migrate down, and a clean shutdown writes one for every loaded room. So going back means restoring, on the older build, the backup taken just before the update, which README's Updating section already takes first. Rooms changed after the update lose those changes, and README's Updating section says so for this update. An export from this build is refused by an older build's import, whose schema is strict.

## 4. Permissions and projection

### 4.1 Who may do what

| On a creature companion, or its character's blocks | Its players (the character's owners, co-owners included) | The DM |
| --- | --- | --- |
| Create, edit and delete the character's blocks, every line and the picture | yes | yes |
| Link a block (`srdId`, `blockId`), change it, detach it | yes | yes |
| Link a room monster (`monsterId`) | no, and never sees one | only by making a monster's token a companion, and its players never read that block (6.5). The companion picker offers no room monster (6.1). |
| AC, HP, speeds, initiative bonus, Passive Perception, senses, notes, sheet link | yes, as today | yes |
| Size of a companion already on the map | yes, by the resize rule of docs/design-v1-token-window.md (8.6), which checks every player's resize like a move or refuses it (Decided 3) | yes, by the same op, never checked |
| Size of a new companion | yes, as today, judged where it lands | yes |
| Initiative score, creature type, CR, XP | no | yes |
| Legendary uses | no | yes |
| DM notes | no | yes |
| Whose companion it is, hidden, locked, number, owners, party vision, the HP other players see | no, as today | yes |

- **A placed companion's size is its players' too, by one rule this design does not own** (Decided 3). docs/design-v1-token-window.md defines resizing for every token an owner may change, companions included: the op, which sizes, the permission and the wall check. A player's resize, growing, shrinking or keeping its size, is checked like a move: on a scene whose walls block players' moves, it may not carry the token's middle across anything that blocks moves, and the new footprint must stand where a move could end, by the move rules' own standing test. A growth grows into the space around the creature: its only candidates are footprints that cover every square it filled before (every quarter square, for a Tiny one), so it never leaves the squares it stood on. Where the base spot fails, it takes the passing candidate nearest the creature's middle, and where no candidate passes, the resize is refused with "No room to grow here". Beside a wall that leaves fewer spots than a free shift would, so more growths there are refused, as the token window design decided in its review's second round. The DM's resizes are never checked, and on a scene whose walls do not block players' moves nothing is checked. This design adds no size permission, op or check of its own, and every size change it makes (the numbers step, 5.1) goes through that rule.
- **What "clear of walls" means here: the move rules' standing test** (the coordinator's decision for both designs). A spot passes when the creature's core there touches no movement blocker and its middle got there without crossing one (`coreBlocked` and `legClear`, `shared/rules/movement.ts:312-360`, `:443-448`). The core is one size smaller than the footprint (`coreSize`, `:39-45`), so a passing footprint's outer half square may overlap a wall, as it may after any move, while its middle and its core stay on its own side. A Large creature therefore cannot grow in a 5 ft corridor: on whole squares its core always meets a wall, and it gets "No room to grow here", which matches the rules, since a Large creature needs 10 ft. Its sight starts from its middle and its next move from where it stands, both on its own side.
- **`companionCheck`** also refuses a new actor holding a DM field: `initScore`, `creatureType`, `cr` or `xp`, beside today's `monsterId`, `legendary` and DM notes. A link is allowed: `srdId`, or `blockId` naming one of the character's blocks, which the reducer checks (3.2). So a player's new companion carries only what its player could change afterwards.
- **`companionUpdateCheck`** lets the actor patch name `srdId` and `blockId` beside `OWNER_ACTOR_FIELDS`. Every other refusal stays, and a size change is the token window design's (above).
- **A `blockId` a player names** must be a block of a character they own, on a create or an update, else `gone`, before the reducer's own rules run. So a player never learns from an answer that a block they cannot see exists, as with any id outside their view.
- **The block ops.** A player's create names a character that exists (else `gone`) and that they own (else `NOT_YOURS`). An update or a delete names a block of a character they own, and any other block answers `gone`, the answer for anything outside their view (`shared/permissions.ts:18-23`). An image the op names passes `canUseAsset` with kind `token` (`imageUsable`), for the DM too. A player needs no room setting, as adding a companion needs none.
- `client/features/tokens/access.ts` mirrors all of it, and `access.test.ts` checks it against `canApply`, as today.

### 4.2 What each viewer receives

| Viewer | Blocks | A companion's actor |
| --- | --- | --- |
| DM | all | whole |
| The character's owners, co-owners included | the character's, with `rev` 0 as their characters have | whole but `dmNotes` and `monsterId`, so with `srdId` and `blockId` |
| A player who owns a token of the character but not the character | none | as any other player |
| Other players | none | life, effects and the HP the DM allows, as today |
| The table display, a player who owns nothing | none | as other players |
| "View as a player" | the previewed player's: the DM's device runs the same projection (`client/features/dm/preview.ts:23`) | as that player |

- `projectCompanionBlockCtx` returns the block to the DM, the block with `rev` 0 to a player who owns its character (`ownsCharacter`), and null to anyone else. The character's ownership is its only input, so who reads a block cannot drift from who plays the companions.
- During a blackout a player keeps their characters' blocks, as they keep their characters: neither is scene data.
- No DM-only data moves. `state.monsters`, `state.srdImages` and `monsterId` keep their DM-only projections, and nothing copies a room monster's block, or the DM's image for an SRD monster, into a companion's block (6.1, Decided 1).

### 4.3 Images

- `entityAssetRefs` and `IMAGE_COLLECTIONS` (`shared/referencedAssets.ts:44-50`, `:69-77`) gain the block's `defaultImage`, kind `token`. Cleanup, the library's in-use mark, the delete route's in-use check and `restoreAddedAssets` then see it, and the file's own test fails until both lists name it.
- `visibleAssetIds` (`shared/project.ts:1652-1686`) adds each projected block's image, so the DM and the character's owners can load it and no one else can.
- A player's image passes the existing upload checks and `canUseAsset`: their own upload, or an image already in their visible set.

### 4.4 Prediction (`shared/reads.ts`)

- `companionBlock.create` reads the character's key, for its owners. The DM's and the owners' devices hold it, so a create is predicted there.
- `companionBlock.update` and `companionBlock.delete` read the block's key.
- A `token.update` that names `actor.blockId` reads the token, as today, and the named block's key, for its `characterId`, which the DM's and the owners' devices hold. So attaching, changing and detaching are predicted. A patch that also names `companion` stays `NEVER`, as today.
- A companion's `token.create` stays `NEVER`, as today. A resize, the numbers step's included, reads what docs/design-v1-token-window.md 8.6 states for `shared/reads.ts`.

The companion editor still waits for the server before it closes (6.2), so a refusal shows where the draft is.

### 4.5 Security

- **Text only.** A block renders as Markdown through `client/components/Markdown.tsx`, which builds React elements and never an HTML string, with links on only in the journal (`client/components/markdown.ts:123`). `statBlockMarkdown` escapes the emphasis marks in every line (`escapeMd`, `shared/statBlock.ts:117`). So a player's block can shape at most its own layout, such as a stray heading, never markup, a link or an image. The editor's preview uses the same renderer, and the parser runs on the sender's own device.
- **Bounds.** Every line and the whole block are bounded (3.3), a block op stays far under the 64 KiB frame, and the character's and the room's totals bound what rides in snapshots (3.4). Names refuse control and text direction characters, and other lines control characters, as the monsters' do.
- **Rates.** The per-member bucket (3.5), beside the socket's op rate and frame budget.
- **Images.** Only through the existing asset checks (4.3).
- **What players learn.** Nothing about the room's monsters, the DM's SRD images or another player's blocks. No path turns a room monster's block into a companion's: the companion picker lists none, for the DM either, and no action copies one (6.1). A companion linked to a room monster shows its players no block (6.5).

## 5. What attaching does to the companion

### 5.1 The numbers

Attaching or changing a block on a creature companion opens a step, "Attach Owl", with "Use Owl's numbers" (the default) or "Keep Hoot's numbers". Using them sets these. Every one but the size goes in the same `token.update` as the link, and the size goes after it as a resize of its own (below):

| Field | From | Note |
| --- | --- | --- |
| AC | the block's | |
| Max HP | the block's average, a typed number, or the current maximum (5.2) | Average is offered only when it is at least 1. |
| Speeds | every mode, with hover | `speedsOf` for a stored block, the SRD's own speeds for an SRD one, as placing a monster reads them |
| Initiative bonus | the block's | The initiative score stays the DM's to type. Absent, nothing changes (`shared/rules/initiative.ts:120`). |
| Passive Perception | the block's | |
| Senses | the block's special senses, cut with an ellipsis to the 80 characters an actor holds (`fitLine`) | Party sight reads them as it reads any creature's, within its caps. |
| Size | the block's first size | For its players and the DM alike, through docs/design-v1-token-window.md's resize (4.1, Decided 3) |

- Each line shows the new value and the current one, such as "AC 13, now 11", and a value that would not change shows no line.
- **Two ops, always.** Attach sends the link and every number but the size in one `token.update` and waits for its answer. Only once that is `taken` does it send the size, as its own op: the resize patch the token window design's `resizePatch` builds (docs/design-v1-token-window.md 8.6), judged by the same `resizeCheck` as any resize. That check takes only a patch of resize fields, so the size can never ride with the link. One rule for the DM and players: the DM's resize is the same op, never checked. The size is sent at all only when it differs, the numbers are used, and the viewer may resize the token (`canResize`).
- **The Size line**, one line under the size row, says each case in turn:
  - **Before Attach**, the outcome of that design's shared check on the view as it stands: "Size Large, now Small", with "It moves a little to clear the wall." where the spot shifts (still covering every square the companion filled), or "No room to grow here: Hoot keeps its size." where nothing nearby passes, and then no resize will be sent. The DM's line shows neither, since the DM's resize is never checked.
  - **A locked companion**, for its players: "Size Large: Hoot is locked, so its size stays. Ask the DM." No resize is sent, and the link and the other numbers apply, as a lock stops moves and resizes but not an owner's numbers.
  - **While the link's op waits**: Attach is busy as "Attaching…". A refusal shows above the footer in the server's words, nothing more is sent, and Attach is offered again. An `unknown` answer (the connection dropped) says "The connection dropped before the server answered. Check Hoot's panel before attaching again." and sends no resize.
  - **Once it is taken**: the device builds the resize again from its view as it now stands, since a wall or a lock may have changed meanwhile, and the Size line reads "Resizing…". If that fresh check now refuses, no resize is sent and the line says why.
  - **The resize's answer**: `taken` closes the dialog. A refusal, such as "No room to grow here." after a wall drawn meanwhile, or "that token is locked", stays on the Size line in the server's words, the link and the other numbers stay applied, and the footer's Attach becomes Done.
  - **Cancel, Escape or the dialog's Close before the link's answer** closes the dialog and sends nothing more. A late `taken` for the link lands the link and numbers but sends no resize, and a toast says so: "Owl is attached to Hoot. Its size stayed Small." A late refusal is a toast in its words, as the companion form's late answers are (`lateCompanionText`).
  - **Closing while the resize waits** lets it land. A late refusal is the room's refusal toast in its words, as any resize's is.
- **Undo, by one rule: a resize is a resize, whoever starts it.** The token window design puts a resize on its maker's undo stack, a player's included, and its undo puts back the size and the place and keeps every later edit (docs/design-v1-token-window.md 8.7). A player's attach goes on no stack, as no player's `token.update` of numbers does. So for a player, Ctrl+Z right after attaching a Large wolf to a Small companion takes back the size alone: the companion is Small again where it stood, and keeps the wolf block, its AC, HP, speeds and senses. Detach, or attaching with "Keep Hoot's numbers", changes those. For the DM, whose every op is on the stack, the first Ctrl+Z takes back the resize and the second the attach. The reason for not keeping the attach's resize off the stack: a stack decided by where an op came from would need the op to carry its origin, which no op does, and a player who resized by attaching expects Ctrl+Z to take that resize back like any other. The numbers step says which numbers it set before Attach, and FEATURES.md says what Ctrl+Z does (section 12).
- One pure function, `blockNumbers(view, token, actor, hp)` in `client/features/tokens/companionBlocks.ts` (new), builds both the patch and the lines, from the block in the SRD monsters' shape (`StatBlockMonster`, through `monsterView` for a stored block), so every kind of block goes through one path.
- "Keep Hoot's numbers" sends the link alone.
- Picking the block already linked offers its numbers again, which is how a player resets the numbers after editing the block.

### 5.2 Current HP

One rule: **attaching never brings a creature back or puts it down.**

- A living creature at its maximum, 0 of 0 included, stays at its maximum: the patch sets the maximum and the current HP to the new maximum.
- Any other creature, hurt, dying, stable or dead, gets the new maximum alone. Its current HP is cut to it if it was higher (`applyHpSet`, `shared/rules/hp.ts:266-295`), and a maximum of at least 1 never takes it to 0. A set of the maximum alone never revives (docs/design-v1-combat-flow.md 3.4), so a dying spirit stays dying and a dead one stays dead, whatever "Healing brings back the dead" says.
- "Keep" sends no HP.

The step says which applies, such as "Hoot is unhurt, so it stays at full HP: 11 of 11." or "Hoot keeps its 4 HP, now of 11."

### 5.3 What stays

Temporary HP, conditions and effects with their durations, death saves and life, a spent Reaction (`companion.reactionUsed`), the initiative row and its value, the name, the picture, notes and the turn. Saves and resistances are not numbers on the token. They are read from the block wherever they show (6.5, 6.6), so they change with the link.

### 5.4 Detach and change

- **Detach** clears the link and keeps every number. A stored block stays in the character's list.
- **Change** opens the picker, and its pick replaces the link through its own numbers step, so one patch swaps the block, with no Detach first.
- A player's link patch names only `srdId` and `blockId`. Rule 1 clears a `monsterId` the DM set (3.2).

### 5.5 Effects, kind and character changes

- **An effect companion** (kind `object`) has no block. Its panel shows no Stat block section, its bar no saves and no button, and the add form hides its stat block field while "An effect" is chosen. Its HP-less state is unchanged (`hpLess`, docs/design-v1-combat-flow.md 3.6.6).
- **Creature to effect** keeps a link stored and shows nothing of it. **Effect to creature** shows it again. The change never writes the actor, as that design says of HP.
- **Given to another character** by the DM's "Belongs to", a companion drops its `blockId`, since the block is the old character's, and keeps an `srdId` and every number. While a stored block is linked, "Belongs to" says under it: "Its stat block is Bree's and stays with Bree."
- **Stop being a companion**, the DM's, drops `blockId` the same way, with the same line beside its button.

### 5.6 Adding a companion from a block

Picking a block in the add form (6.3) fills each field still as it started: the name (when empty), the size, HP with the average, AC, and the picture with a stored block's when none is chosen. It also takes the block's speeds, initiative bonus, Passive Perception and senses, which the form lists under the field. Each filled field stays editable, and HP and AC are where a summon cast at a higher level gets its numbers (section 7). The new token's actor carries the link, built by `companionInput`. The add's own placement check judges the block's size, so a Large wolf goes only where it fits and could step from its character.

## 6. UI per surface

### 6.1 The stat block picker

`MonsterPicker` gains a character: from a companion's panel, or from the add form, it opens for that companion's character.

- **Its lists, in order:** "Paste a stat block" and "New stat block" on one row, as in the Monsters panel, then the search field, above every list it narrows, then "Bree's stat blocks (N)", then "Same name" (Bree's and the SRD's of exactly the companion's name, from today's `nameSuggestions` without its room monsters), then "SRD 5.2.1 (330)" and the SRD credit. Search narrows every list with the Monsters panel's matcher (`monsterMatcher`, `client/features/tokens/monsterSearch.ts:60`), so "owl" or "cr 0-1" finds the same as there. Rows are today's `MonsterList` rows. Bree's carry a muted "Bree's" tag, as the room's carry "This room" in the Monsters panel.
- **The help line** at the top reads "Bree's players and the DM read it. Next you choose whether it sets Hoot's numbers." in place of today's "Links the block only."
- **A player's picker** lists only what their view holds: Bree's blocks and the SRD. No room monster and no SRD default image is in their view, so none can show. Rows carry no image, as today.
- **The DM's picker on a companion** is the same: it lists no room monster (Decided 1). On a companion, every block the picker offers is one its players read. The DM pastes or types a block for a companion through the same "Paste a stat block" and "New stat block" a player has, and the room's monsters stay in the Monsters panel. The DM's picker on any other token is unchanged.
- **"Paste a stat block" and "New stat block"** open the editor for Bree (6.2), and the block it saves becomes the pick.
- **Attaching**, from the token panel: a pick moves the dialog to its second step, "Attach Owl", with the numbers (5.1), Back to the lists with the search kept, and Attach in the footer. Each step's title takes focus as a dialog's steps do (`useStepFocus`, `client/components/Dialog.tsx:226`), and closing hands focus back to the button that opened it. **Choosing**, from the add form: a pick closes the picker, fills the form and hands focus back to the field's Change.
- **The save-then-use rule.** A flow that saves a new block and then uses it ("Paste a stat block" and "New stat block" from the picker, "Copy to Bree's stat blocks and edit") goes through the editor's answered save (6.2) and sends the link, or fills the form, only once the save is taken. A refused save sends nothing more and says why in the editor. A copy of an SRD block never takes the DM's default image for that SRD monster, which stays the DM's, and keeps `fromSrd`.
- **Loading.** The SRD chunk loads when the picker opens, behind the shared indicator, and a failure shows today's "did not load" with Reload (`client/features/monsters/SrdLoadFailed.tsx`). Bree's blocks list at once, since they are in the view.

### 6.2 The editor

`MonsterEditor` gains a target: a room monster, as today, or a character's block.

- The title is "New stat block for Bree" or "Edit Moth Spirit". The paste box, every field, the preview, the size notice and the parser's warnings are as today.
- The image group reads "Picture", with "Each companion added from this stat block starts with this picture." The legendary hints, which promise tokens their uses, are left out, since attaching never sets legendary uses.
- **Save waits for the server's answer**, busy as "Saving…", with the fields held still until it comes, and the editor closes only once the draft it holds is stored. A refusal shows in the editor's problem list with the draft intact, which is where a player at a cap can act. An `unknown` answer is read from the view, which after a reconnect's snapshot shows what the op did: a create stored, or an update whose lines read as it set them, closes the editor, and otherwise it says "The connection dropped before this stat block was saved. Save it again." (or "these changes were saved. Save them again.") and keeps the draft. An op dropped as too old before any new snapshot leaves Save off with "The connection dropped. Checking whether it was saved…" until the next snapshot says. A create is never sent again while the first may still land, and once a create that lost its answer shows in the view, a later Save sends the draft's changes as an update and waits for it (`client/features/monsters/blockSave.ts`). After Cancel, a late answer adds the block and does nothing more, and a late refusal is a toast, as the companion form's late answers are (`lateCompanionText`, `client/features/tokens/companions.ts:39-45`). The save bucket's refusal (3.5) keeps the draft, disables Save for a few seconds and then offers it again, and a guard's refusal comes in the block's own words (3.4).
- **A block or character that leaves this device's view** while its editor is open, deleted, or with the character no longer the player's, shows "This stat block was deleted or is no longer yours, so it cannot be saved." above the fields, disables Save, and keeps the draft so its text can be copied. The same holds for a new block whose character leaves the view.
- **The editor is held over the room**, apart from whatever opened it (`client/features/monsters/openEditors.ts`): a token panel, a picker or a character's stat blocks page. So it stays, with its draft, when the block is deleted or the token's link moves to another block, when the companion or its character is deleted, or when the character is no longer the viewer's, and only Save or Discard closes it.
- **The opened block is the base.** The editor keeps the block it opened with and diffs the draft against it, for monsters and blocks alike, and Save goes to that block whatever the token's link says later. A line another DM or a co-owner changes meanwhile is kept unless this draft changed the same line, where the later save wins. Whether the draft holds anything to lose is read against the same opened block, so a co-owner's edit arriving meanwhile leaves an untouched draft free to close. This fixes the token panel's Edit, which passed the live monster (2.4).

### 6.3 Adding a companion

The add form (`CompanionForm`) gains one field after "It is", shown only while "A creature" is chosen:

- **Stat block**, with its label above it as Turn's is, so a long name shortens rather than widening the form. With none: "Choose a stat block" and "Optional: an SRD creature, one of Bree's, or one you paste." With one: its name, its source tag ("SRD" or "Bree's"), Change and Remove, and a line such as "From the block: speed 5 ft, fly 60 ft. Darkvision 120 ft. Passive Perception 15. Initiative +1."
- Picking fills the form (5.6). HP's help names the average and the dice, such as "The block's average, 1 (1d4 − 1). Type another for a higher-level casting."
- "An effect" hides the field and keeps the choice in the draft, unsent, as it keeps HP.
- A chosen block that leaves the view, deleted by a co-owner or the DM, is unchosen with "The chosen stat block was deleted." The numbers it filled stay.
- **Add and place** sends the companion with its link, busy until the server answers, with today's placement, refusal and late answer rules. A block made from the picker is saved before it can be chosen (the save-then-use rule), so the add never waits on a save.

### 6.4 The Characters panel

- **The companion list** in a character's card (`CharacterCompanions`, `CompanionsSection.tsx:83-123`) names each companion's block before its turn: "Owl · On Bree's turn, listed". A link to a deleted block reads "Stat block deleted".
- **"Stat blocks (N)"** sits beside "Add a companion", for the DM and the character's players. It opens "Bree's stat blocks" in the panel's place, as the add form does, with focus on its heading and a Done that hands focus back. It holds "Paste a stat block" and "New stat block", then each block as a disclosure row (its name, then its size, type and CR) that opens the block's view under it with Edit and Delete. Delete takes two taps ("Tap again to delete") and says under it: "Companions using it keep their numbers and show that it was deleted." With none: "Bree's companions' stat blocks go here. Paste one from a book, start one, or pick an SRD creature when you add a companion."
- Other players' rows (`PartyRow`) are unchanged.

### 6.5 The token panel

`statBlockShown` gains the companion: the DM on a monster or an NPC, as today, a companion's player on a creature companion whatever it links, and any other owner on an SRD link, as today. So the Stat block section, with its summary header and its remembered fold, shows under the image for a creature companion's players (`panelSections`, `client/features/tokens/panelOrder.ts:47-60`, puts it first when shown). On a creature companion, for the DM and its players:

| Link | The section shows | Buttons |
| --- | --- | --- |
| None | the summary line | "Attach a stat block" on the heading's row |
| SRD | the block and the SRD credit | "Copy to Bree's stat blocks and edit", Change, Detach |
| Bree's block | the block, and the SRD credit when `fromSrd` is set | Edit, Change, Detach |
| A deleted block | the summary and "This companion's stat block was deleted." | "Attach a stat block", Detach |
| A room monster, which only the DM sees | the block, and "Bree's players do not see this block: it is one of this room's own monsters. Change it to an SRD block or one of Bree's for them to read one." | Edit (the room monster, as today), Change, Detach |

- Only "Make a companion" on a token placed from a room monster gives a companion this link. Nothing copies the block (Decided 1).
- A player sees a companion linked to a room monster as one with no link, since their actor has no `monsterId`, and is offered "Attach a stat block". Attaching clears the DM's link (3.2 rule 1).
- On a token that is not a companion, the section is unchanged.
- **Resizing a placed companion** outside the numbers step is the token window design's control and rule, for a companion as for every token an owner may change (4.1). This design adds no size control of its own.

### 6.6 The action bar

The bar of a creature companion with a block shows its players the saves line, the defense lines and "Stat block" in its read-more row, as the DM's bar does for a monster (`TokenActionBar.tsx:170-172`, `:350-354`). `linkedBlockState` reads a stored block from the view at once, so only an SRD block loads the chunk. Other players' bars are unchanged.

### 6.7 The tracker

- A companion sub-row's options (`Row.tsx:391-397`) offer "Stat block" to its players wherever its bar would. The DM's stays as it is.
- An own-turn companion's row options offer its players "Stat block" by the same rule, after Ready (`:674-684`).
- "Stat block" opens the panel at the block through `openStatBlock`, as everywhere.

### 6.8 Keys and pointer behaviors

This design adds, changes and removes no key or pointer behavior, so the shortcut sheet's registry (`client/state/shortcuts.ts`) and FEATURES.md's "Keyboard shortcuts" section need no change. Its dialogs keep the dialog shell's keys (Escape closes, Tab moves), and its new controls are buttons and fields. Resizing, with any key or gesture it has, is docs/design-v1-token-window.md's, which lists them under the shortcut rule.

### 6.9 Mockups

#### 6.9.1 The character's card and "Bree's stat blocks" (390 x 844, the bottom sheet, Bree's player)

```
+--------------------------------------+   +--------------------------------------+
| v (B) Bree       HP 24/31, Ana       |   | Bree's stat blocks           [Done]  |
|   [Place my token]                   |   | [Paste a stat block][New stat block] |
|   COMPANIONS                         |   | v Moth Spirit                        |
|   (H) Hoot                        >  |   |   Small Fey, CR 1/4                  |
|       Owl · On Bree's turn, listed   |   |   Moth Spirit                        |
|   (M) Moth                        >  |   |   Small Fey, Unaligned               |
|       Moth Spirit · Its own turn     |   |   AC 12  Initiative +2 (12)  ...     |
|   [Add a companion]                  |   |   [Edit]  [Delete]                   |
|   [Stat blocks (2)]                  |   | > Owl, Bree's version                |
|   ...the character's card...         |   |   Tiny Beast, CR 0                   |
+--------------------------------------+   +--------------------------------------+
```

The two buttons share a row where the width holds both and wrap where it does not, as here at 390 px. Moth Spirit is a block the player pasted, so its text is theirs.

#### 6.9.2 Add a companion with a block chosen (390 x 844)

```
+--------------------------------------+
| Add a companion for Bree    [Cancel] |
| Name    [Hoot                     ]  |
| It is   [A creature][An effect]      |
| Stat block                           |
| Owl  SRD             [Change][Remove]|
| From the block: speed 5 ft, fly      |
| 60 ft. Darkvision 120 ft. Passive    |
| Perception 15. Initiative +1.        |
| Turn                                 |
| [On Bree's turn, listed under Bre v] |
| It acts on Bree's turn and shows     |
| under Bree in the initiative order.  |
| Size    [Tiny v]                     |
| HP      [ 1 ]                        |
| The block's average, 1 (1d4 − 1).    |
| Type another for a higher-level      |
| casting.                             |
| AC      [ 11 ]                       |
| Picture [image field]                |
| [Add and place]                      |
| Goes next to Bree on the map.        |
+--------------------------------------+
```

#### 6.9.3 The picker, both steps (390 x 844, the whole screen, Bree's player)

```
+--------------------------------------+   +--------------------------------------+
| Attach a stat block               X  |   | (<) Attach Owl                    X  |
+--------------------------------------+   +--------------------------------------+
| Bree's players and the DM read it.   |   | [Use Owl's numbers][Keep Hoot's]     |
| Next you choose whether it sets      |   | AC 11, now 10                        |
| Hoot's numbers.                      |   | Speed 5 ft, fly 60 ft, now 30 ft     |
| [Paste a stat block][New stat block] |   | Darkvision 120 ft, now none          |
| BREE'S STAT BLOCKS (1)               |   | Passive Perception 15, now 10        |
| Moth Spirit          Bree's  CR 1/4  |   | Initiative +1, now +0                |
|   Small Fey                          |   | Size Tiny, now Small                 |
| [Search: owl, cr 0-1             ]   |   | MAX HP                               |
| SRD 5.2.1 (330)                      |   | [Average 1][Type one][Keep 6]        |
| Aboleth                       CR 10  |   | Hoot is unhurt, so it stays at full  |
|   Large Aberration                   |   | HP: 1 of 1.                          |
| ...                                  |   | Temporary HP, conditions and effects |
| Stat blocks from the System          |   | stay.                                |
| Reference Document 5.2.1 ...         |   |                                      |
+--------------------------------------+   +--------------------------------------+
                                           |                     [Back] [Attach]  |
                                           +--------------------------------------+
```

Here Hoot was added earlier with typed numbers (AC 10, 6 HP, Small, a 30 ft walk), and its player now attaches the SRD Owl. Shrinking needs no room, so the Size line says nothing more. Attaching a Large wolf to Hoot beside a wall would add "It moves a little to clear the wall.", or in a corridor too narrow, "No room to grow here: Hoot keeps its size." The DM's picker on a companion shows the same lists, with no room monster among them.

#### 6.9.4 The Stat block section in a companion's panel (1280 x 800, the side panel), its player and the DM

```
Bree's player, Hoot linked to the SRD      DM, Moon Hound linked to a room monster
+--------------------------------------+  +--------------------------------------+
| Hoot                                 |  | Moon Hound                           |
| (image row)                          |  | (image row)                          |
| v STAT BLOCK                         |  | v STAT BLOCK                         |
|   [AC 11] Speed 5 ft, fly 60 ft      |  |   [AC 13] Speed 40 ft                |
|   Passive Perception 15              |  |   Passive Perception 14              |
|   Owl                                |  |   Moon Hound                         |
|   Tiny Beast, Unaligned              |  |   Medium Fey, Unaligned              |
|   ...                                |  |   ...                                |
|   Stat blocks from the System        |  |   Bree's players do not see this     |
|   Reference Document 5.2.1 ...       |  |   block: it is one of this room's    |
|   [Copy to Bree's stat blocks and    |  |   own monsters. Change it to an SRD  |
|    edit] [Change] [Detach]           |  |   block or one of Bree's for them to |
| HIT POINTS ...                       |  |   read one.                          |
|                                      |  |   [Edit] [Change] [Detach]           |
+--------------------------------------+  +--------------------------------------+
```

Moon Hound became Bree's companion through "Make a companion" on a token the DM placed from a room monster, the only way a companion gets that link.

#### 6.9.5 The action bar for Hoot's player (390 x 844)

```
+--------------------------------------+
| :: Hoot                           X  |
| [AC 11] HP 1/1  Speed 5 ft, fly      |
| 60 ft  Passive Perception 15         |
| [Damage][Heal][Set][Temp]            |
| [            ]  [Apply]              |
| Saves Str −4  Dex +1  Con −1  Int −4 |
|       Wis +1  Cha −2                 |
| [Stat block] [Details]               |
| ...the bar's rows as today, with     |
| Dismiss in Delete's place...         |
+--------------------------------------+
```

## 7. Scaling summons

The 2024 summon spells print one stat block whose AC, HP and attacks are written in terms of the spell's level, and each casting fills them in.

- **In this change.** The player pastes or types the block once, as printed. The parser keeps what it cannot read as a number as a warning, and the player types a base value in the editor. At each casting, the add form's HP and AC (5.6), or the numbers step's typed HP and then the panel's Stats, take this casting's numbers. They are the token's own, so two summons from one block at different levels each keep theirs. Attack bonuses and damage stay in the block's text, read as printed, and the app rolls nothing.
- **Later.** A spell level on the companion that fills in every number written in terms of it. That needs numbers in the block that are formulas rather than text, a change to the block's shape that every reader of it would follow.

## 8. Interfaces with planned and parallel work

- **The DM's auto-roll saves (designed next).** That design will roll a group's saves from stat blocks. A companion's six saves live where every token's do: in the linked block's `abilities[k].save`, in `StatBlock`'s shape for an SRD link, a room monster and a stored block alike, read through one function, `linkedBlockState`. The DM's device holds every companion block (4.2), so it can roll a companion's saves as it rolls a monster's. The saves are never copied onto the token, so there is one place to read. A companion with no block has no saves to read, as a monster token with no link has none today. If that design wants saves editable per token, it adds such a field for every creature, not for companions alone.
- **The PDF handouts build.** It also changes `shared/migrate.ts`, `shared/keys.ts`, `shared/initial.ts`, `shared/limits.ts`, `shared/project.ts` (`allKeys`, `projectState`, `visibleAssetIds`), `shared/referencedAssets.ts`, `server/rooms/sizeGuard.ts` (`ROOM_LEVEL`), `server/rooms/stateSchema.ts` and `server/rooms/remap.ts`, each with an addition beside this one's. This build lands after it and keeps both, and takes snapshot version 10 (3.6).
- **The token window design** (docs/design-v1-token-window.md, beside this one). It owns resizing for every token an owner may change, companions included: the op and its `resizePatch`, the sizes, `resizeCheck`, the wall check by the move rules' standing test for every player's resize ("No room to grow here"), its reads in `shared/reads.ts` (8.6), its undo, which puts back size and place and keeps later edits (8.7), its tests and its keys and gestures. This design's only size change, the numbers step's, is that resize sent as a second op after the link's answer (5.1). The two builds share op version 6, or this one takes 7 if the token window build deploys first (3.6). This build lands after the one that builds the resize, or ships the numbers step's Size line once it lands.
- **docs/design-v1-token-panel.md and docs/design-v1-combat-flow.md**, both built. Their rules hold. This design changes `statBlockShown`, the Stat block section's buttons, the action bar's "Stat block" and saves for a companion's players, the tracker's options, the add form's field, the card's companion list, and the Companion section's line under "Belongs to". The DM's tokens that are not companions keep today's section, picker and buttons.

## 9. Edge cases and states

### 9.1 By role

| Role | Reads | Changes | Notes |
| --- | --- | --- | --- |
| DM | Every block, and every companion's section, bar and rows | Every block and link, and the numbers with size. Never a room monster made into a companion's block (Decided 1). | Edit diffs against the opened block (6.2). Every DM change goes on the DM's undo stack. |
| Owner | Their characters' blocks: in the panel, the bar, the rows, the card and the picker | Their characters' blocks, and the link and numbers of their creature companions, size included (Decided 3) | Saves wait for the server. No undo of a block or an attach, as for every player op but drawings, moves and, with the token window design, resizes (5.1). |
| Co-owner | As the owner | As the owner | Two edits of different lines both stay. On one line, the later save wins. Each sees the other's save as it lands. |
| Other player | The token, its name and its HP, as today | Nothing new | Their projection holds no block and no link (4.2). |
| A player who owns the character's token but not the character | As other players, for companions | Nothing new | A companion's owners are its character's (docs/design-v1-combat-flow.md 3.6.4). |
| Table display | As other players | Nothing | |
| View as a player | The previewed player's blocks and sections | Every change flashes refused, and the editor stays open with its draft | The projection runs on the DM's device (4.2). |
| A member removed, or made DM | Removed: the blocks go with the characters' ownership. Made DM: every block. | | Both are owner or member changes, which are global (3.6). |

### 9.2 By state

| State | DM | The companion's players | Other players and the display |
| --- | --- | --- | --- |
| A creature companion with no block | "Attach a stat block" in its section and today's row and sub-row "Stat block" | The section with "Attach a stat block". No "Stat block" in the bar or rows until one is linked. | The token, its name and HP |
| SRD link | The block with its credit, Copy, Change, Detach | The same, and saves, defenses and "Stat block" in the bar and rows | As above |
| A pasted block, saved as Bree's | The block, Edit, Change, Detach | The same. It is in Bree's stat blocks and in the picker for the next summon. | As above |
| A block edited later | Every companion linked to it reads the new text and saves at once. Their numbers stay until someone picks the block again. | The same | As above |
| An SRD block copied and edited | As a pasted block, with the SRD credit (`fromSrd`) | The same | As above |
| A room monster link, from "Make a companion" on a monster's token | The block, with the line that its players do not see it, and Edit, Change and Detach. No way to copy it. | No block, and "Attach a stat block", which clears the DM's link | As above |
| The companion picker, opened by anyone | Bree's blocks, the same-name list and the SRD. No room monster. | The same | Never opens it |
| A block deleted while linked | "This companion's stat block was deleted.", Attach, Detach. The numbers stay. | The same. The card's list reads "Stat block deleted". | As above |
| An effect companion | No section, no picker and no saves, since a block belongs to a creature (5.5) | The same. The add form hides the field. | As above |
| Creature made effect, then creature again | Link stored and hidden, then shown again | The same | As above |
| In a fight, own turn | Attaching changes AC in the row and on the map. The row's value stays. | Their row's options have "Stat block". | The row as today |
| In a fight, on its character's turn | The sub-row's AC and HP follow the numbers. The spent Reaction stays. | The sub-row's options have "Stat block". | The sub-row as today |
| Hurt, dying, stable or dead when attached | The maximum alone: hurt keeps its HP, cut to the new maximum, and the dying and the dead stay so (5.2) | The same | HP as their rule shows it |
| Resized by its players, through the numbers step or the token window's resize, near a wall on a scene whose walls block moves | Never checked when the DM resizes (docs/design-v1-token-window.md 8.4) | Growing, shrinking or the same size, the middle never crosses a wall, and the footprint ends where a move could end: its core clear, its outer half square perhaps over a wall as after any move (4.1). A growth still covers every square it filled before. Where the base spot fails it takes the passing spot nearest its middle that covers them, and the Size line says so first. With no spot nearby, such as a Large one in a 5 ft corridor, it keeps its size, the line reads "No room to grow here: Hoot keeps its size.", and the link and the other numbers still apply (5.1). | They see it where it lands, its middle on its own side |
| Resized on a scene whose walls do not block players' moves | Never checked | Never checked, as for the DM | As above |
| Attached to a locked companion | The resize is the DM's, never checked | The Size line says Hoot is locked and its size stays. The link and the other numbers apply, and no resize is sent (5.1). | Nothing |
| The attach dialog closed before the link's answer | The same rule | A late `taken` lands the link and numbers and sends no resize, with a toast saying the size stayed. A late refusal is a toast (5.1). | Nothing |
| Ctrl+Z right after attaching with a size change | The first undo takes back the resize, the second the attach | Takes back the size alone: the companion keeps the block and its numbers, as FEATURES.md says (5.1) | They see the size change back |
| A wall drawn, or a lock set, between the preview and the resize | Not checked for the DM | The fresh check after the link's answer, or else the server, refuses the resize in the token window design's words, shown on the Size line. The link and the other numbers stay. | Nothing |
| On another scene | Its block is in Bree's stat blocks, the token in that scene's view | The same. The card lists only companions on the scene in view, as today. | Nothing |
| Character deleted | Its blocks go with its companions, in the same op. An open editor says the block is gone. | The same, and the picker's list loses them | Nothing |
| Owners changed | Blocks follow the character: the new owner reads them, the old one stops | The old owner's open editor says it cannot be saved, disables Save and keeps the draft (6.2) | Nothing |
| Given to another character, or stopped being a companion | `blockId` drops (5.5), `srdId` and the numbers stay. The line beside the control says so first. | They read the new character's state, as today | Nothing |
| At a cap: 100 blocks or 512 KiB for the character, 600 or 3 MiB for the room | The cap's own words in the editor, with the draft kept (3.4, 6.2) | The same | Nothing |
| A room whose blocks, monsters and journal fill their own caps | A DM snapshot of up to 6 MiB, within the raised snapshot and send-buffer budgets. A map edit may meet the 8 MiB state limit first, in the guard's words. A block save the state limit refuses gets the block's words (3.4). The DM's snapshot guard never refuses a block save. | A block save refused by the state limit gets the block's words | Nothing |
| The room at its storage quota | Deleting a block is accepted, and a create or edit is refused in the block's words (3.4, 3.6) | The same | Nothing |
| The SRD chunk did not load | The picker's SRD list says so with Reload. Bree's blocks still list. | The same, and the bar's saves line says so, as today | Nothing |
| Offline, or the answer lost | The editor shows "Saving…" until the server answers, or the `unknown` line (6.2) | The same | Nothing |
| Saves past the budget | Not counted | Refused with `quota`, never `busy`, so the device's moves and HP changes go on at once. The editor keeps the draft and offers Save again after a few seconds (3.5). | Nothing |
| A character no player plays (the DM's own) | Its blocks and its companions' sections, as for any character | None reach any player | Nothing |
| A companion duplicated, or its scene duplicated | The copy keeps the link, which names the same character's block (3.2 rule 2) | The same, for a copy they own | Nothing |
| A room exported and imported | Blocks, links and pictures come through, remapped (3.6) | The same, for the new room's members | |
| Undo, the DM's | A block create, edit or delete is one step. Undoing a delete makes its links read it again. Undoing a create after a companion linked the block leaves the link reading deleted, as for a room monster today. | No undo | |
| A page left open across the update | Throws on the first change to a block, until reloaded (3.6) | The same | Never receives one |

### 9.3 By screen

Every surface is one already in the app, so each keeps its container's rules at every size: the Characters panel's sheet or side panel, the dialogs' shapes (`dialogCard`, `client/components/Dialog.tsx:63-104`), and the bar's dock.

| Size | Card, add form, stat blocks page | Picker and editor | Panel section and bar |
| --- | --- | --- | --- |
| 390 x 844 | The bottom sheet. One column, the Stat block label above its value, buttons wrapping. | The whole screen, under 600 layout px | The Token sheet. The bar where the dock puts it. |
| 390 x 844 at 130% (300 x 649) | The same at 300 px: the source tag and Change and Remove wrap under the name, and nothing scrolls sideways | The whole screen. The numbers step's lines wrap. | As at 100%, the saves wrapping between units |
| 844 x 390 | The right sheet | A card in the middle, 560 px wide for the picker and 720 for the editor at most, under the window's height, its body scrolling with its footer in view | The right sheet. The bar beside it. |
| 844 x 390 at 130% (649 x 300) | The sheet, or the full-screen modal sheet where its body would be too short (docs/design-v1-layout-hierarchy.md 4.2) | A card about 268 px tall. Its header and footer stay, and its body scrolls. | As the layout design places them |
| 1280 x 800 | The side panel's Characters tab | A card up to 760 px tall | The side panel, with the bar beside it while the block is open |
| 1280 x 800 at 130% (984 x 615) | The side panel | A card | The side panel |

### 9.4 Self-sweep

Each row above was checked against the rules of 3.2, the permissions of 4.1, the projection of 4.2, the HP rule of 5.2, the save-then-use rule of 6.1 and the decisions of section 14. Draft 1's sweep found six problems, each fixed as a class rather than at the row that showed it:

- **An answer could tell a player that a block they cannot see exists**, since the reducer refuses another character's block as `invalid`. Fixed by one permission rule: every `blockId` a player names is checked against their view first and answers `gone` otherwise (4.1), for creates and updates alike.
- **Size changes could reach past walls.** Draft 1 kept a placed companion's size the DM's. The project owner let its players change it too, and then, told that a footprint grown over a wall could put its middle past it, chose "Grow away from walls" (Decided 3). That rule is the token window design's, for every token an owner may change, so this design keeps no size rule of its own: 4.1, the numbers step (5.1), the matrix rows on growing and section 10 all point to it.
- **A player could not clear a link they cannot see.** Fixed by the reducer's one-link rule (3.2 rule 1), which every attach and change relies on, rather than by special cases for `monsterId`.
- **A refusal after the editor closed lost a player's draft.** Fixed by one rule: the companion editor waits for the answer (6.2), which also covers the caps, the rate budget and a lost connection.
- **Making a block and using it could leave half a change.** Fixed by the save-then-use rule (6.1), which every flow that saves a block and then uses it follows. With room monsters never copied (Decided 1), those are the editor's flows alone.
- **The editor diffed against a moving target.** Fixed for every caller by keeping the opened block as the base (6.2), which co-owners need and the DM's token panel already needed.

Draft 2 swept again after the decisions. Every row that named a room monster's copy now names none, and the companion picker has a row of its own (Decided 1). Every row and number that names a cap uses the caps of Decided 2. The owner's row and the three rows on growing follow Decided 3: a player's growth never leaves a footprint over a wall, and no row describes one.

Design review round 1 found six problems in this doc, each fixed as a class:

- **One attach mixed two kinds of op** (DW5-ASTRA-01, W5-DATA-03, PDW-P-2). The combined-patch alternative is gone: the attach is always two ops, the link and numbers and then the resize, and the Size line covers the preview, a lock, both refusals, a cancel and a late answer. The undo outcome is chosen and said in 5.1 and FEATURES.md.
- **"Clear of walls" had two meanings** (W5-DATA-05, the coordinator's decision). Every place now uses the move rules' standing test: the core clear and the middle on its own side, with the footprint's outer half square allowed over a wall (4.1, 9.2, section 10, FEATURES.md).
- **A changed reducer rule replayed old ops differently** (DW5-ASTRA-05). The one-link rule applies from op version 6, with version 5 fixtures (3.2, 3.6, section 10).
- **A rate refusal could stall the device** (DW5-ASTRA-10). The bucket refuses with an answer that advances the sequence, and the editor offers the retry (3.5, 6.2).
- **Blocks could not be deleted at the storage quota** (W5-DATA-08). `companionBlock.delete` joins `DELETIONS` (3.6).
- **The room budget was a cap, not an increase** (PDW-P-6, the project owner's answer). Blocks get 3 MiB of their own, the DM's snapshot and the budgets that count it grow by that much, and every guard's refusal of a block save speaks of blocks (3.4).

The sweep after round 1 rechecked every row these touch: the resize rows, the locked, cancelled and Ctrl+Z rows, the cap, full-room and storage quota rows, and the budget row. Each now matches 3.4, 3.5, 4.1 and 5.1, and no row promises a footprint wholly clear of a wall or a resize riding with the link.

Round 2 changed one rule this doc cites: a growth's candidates must cover every square the creature filled before. The sweep rechecked every place that describes a growth's shift: 4.1, the Size line in 5.1, the resize row of 9.2, the resizing tests, e2e step 7 (its wall now on the companion's right, so a covering shift exists, and a corridor with walls on both sides for the refusal) and the FEATURES.md text. Each now says the shift stays over the squares the creature filled. The mockup caption's two outcomes still hold.

## 10. Tests

Unit tests, `node:test`:

- `shared/reducer/companionBlocks.test.ts`, new. Create stores the block with `rev` 0, refuses an id in use as `invalid` and a missing character as `gone`. Update changes only the named lines and answers `gone` for a missing block. Delete removes the block and writes no token, and a companion linking it keeps the link. Deleting a character removes its blocks, in id order, with its companions.
- `shared/reducer/companions.test.ts`, the link rules. Setting `srdId` clears `monsterId` and `blockId`, and each of the others clears the rest. `blockId` on a token that is not a companion, on a character's actor (by `character.create`, by `character.update`, and through a PC token's actor patch) and naming another character's block is `invalid`, and naming no block `gone`. A create holding `blockId` and `srdId` is `invalid`. Changing `of` or detaching drops `blockId` and keeps `srdId`. One patch that changes `of` and sets the new character's block passes. Creature to effect and back keeps `blockId`. A stored attach patch, `{ srdId, monsterId: null }`, replays to the same actor at any version.
- `shared/reducer/opVersion5.test.ts`, new, with a version 5 fixture beside `opVersion4.test.ts`: a `token.update` stored at version 5 whose actor patch names `srdId` alone, on an actor holding `monsterId`, replays keeping `monsterId`, as it applied. The same op stored at version 6 and the same live op clear it. `shared/migrate.test.ts`: the step from 5 to 6 returns the op unchanged, and `oneLinkPerActor` answers false at 5 and true at 6 and with no version. The token window build's version 5 fixtures (a combined size and place update) sit in the same file, whichever build adds it first.
- `shared/reducer/restore.test.ts`. Undoing a block delete brings it back, and its links read it again. An undo that would remove a character a block names is refused as depended on. An undo that puts back a block whose character was deleted since is refused as its parent gone. Undoing a character delete brings back its blocks and companions together.
- `shared/permissions.companionBlocks.test.ts`, new. A player creates, edits and deletes blocks of their own character with no room setting, and a co-owner may too. Another's character answers `NOT_YOURS` on create and `gone` on update and delete, a missing character `gone`, and an image not theirs `gone`. A companion's owner may set `srdId` and `blockId`, and may not set `monsterId`, `legendary`, `initScore`, `creatureType`, `cr`, `xp` or `dmNotes`. A new companion with `srdId` or `blockId` passes, and one with `initScore`, `creatureType`, `cr` or `xp` is refused. A player who owns Bree's token but not Bree may not link Bree's companion's block. A `blockId` naming another character's block answers `gone` to a player, on a create and on an update, the same answer as an id that names nothing. The DM may do all of it.
- `shared/project.test.ts`. Blocks reach the DM whole and the character's owners, co-owners included, with `rev` 0, and reach neither another player, nor the table display, nor a player who owns a token of the character but not the character. After the owners change, the new owner gets them and the old one does not. During a blackout, owners keep them. `blockId` reaches owners only. `visibleAssetIds` holds a block's image for the DM and the owners alone. The random fan-out invariant (`shared/fanout.test.ts` through `shared/testutil.ts`) generates blocks, links, block ops and owner changes.
- `shared/limits.test.ts`: 100 blocks and 512 KiB per character, and 600 blocks and 3 MiB per room, each refused in its words, an SRD link counting nothing, and 32 blocks of 16 KiB filling a character's bytes before its count. Fifty characters each adding blocks up to their caps stop at the room's caps, refused in the room's words, with the serialized state under `LIMITS.stateBytes`.
- **Resizing's own tests are the token window design's**: the permission for a companion's owners, every resize checked whether it grows or shrinks, the move rules' standing test, growth candidates that cover every square the creature filled before, the nearest of them to its middle, "No room to grow here", the DM never checked, scenes whose walls do not block moves, the resize's undo and its reads. This design tests only that the numbers step goes through it (below).
- `shared/migrate.test.ts`: version 9 to 10 adds `companionBlocks`, leaves a state that has it alone, and version 10 refuses to migrate to 9.
- `shared/reads.test.ts`: the reads of 4.4. `shared/referencedAssets.test.ts`: a block's image, kind `token`, in both lists. `shared/protocol.test.ts`: a 16 KiB block op fits the 64 KiB frame with its envelope, a larger block is refused by the schema, and a patch cannot name `characterId` or `fromSrd`.
- `server/rooms/sizeGuard.test.ts`: blocks are outside the DM's projected scene measure, so with 3 MiB of blocks a map edit whose scene part fits 3 MiB without them passes, and one that does not is refused as today. `checkWholeScenes` on an import reads the same measure. A block save the 8 MiB state limit refuses gets "The room is too full to save this stat block..." in place of the guard's words, with `quota`.
- `server/rooms/budgets.test.ts` and `server/rooms/ws.itest.ts`: `DEFAULT_SNAPSHOT_BUDGET` takes ten 6 MiB snapshots a minute per session before delaying, and a socket sent a 6 MiB snapshot over a slow link stays open under the 7 MiB send-buffer limit.
- `server/rooms/remap.test.ts` and the state schema test: blocks get new ids, a block whose character did not come through is dropped, its image is mapped or dropped, an actor's `blockId` is mapped or dropped, a cross-character link and a link on a non-companion are dropped, and an actor holding `blockId` and `srdId` keeps `blockId`.
- `server/rooms/undoLabels.test.ts`: the three phrases.
- `server/rooms/actor.test.ts`: a player's eleventh block save in a burst is refused with `quota` and `BLOCK_SAVES_TOO_FAST`, never `busy`, and a move and an HP change sent right after it from the same socket apply at once, with no `gap`. One passes again after 6 s. The DM's are not counted. At the storage quota, `companionBlock.delete` by the block's owner and by the DM is accepted, and a create or update is refused in the block's words.
- `client/features/monsters/statBlockLink.test.ts`: `tokenStatBlock` reads a stored link and a deleted one. `statBlockShown` is true for a creature companion's player with no link, false for an effect companion's player, and as today for other owners and the DM. A player's `attachPatch` names only `srdId` and `blockId`.
- `client/features/tokens/statSummary.test.ts`: `linkedBlockState` reads a stored block at once, and a deleted one as none.
- `client/features/tokens/companionBlocks.test.ts`, new. `blockNumbers` for an SRD block and a stored one: the fields and lines, Use and Keep, HP average, typed and kept, an unhurt creature full at the new maximum, 0 of 0 counted as unhurt, a hurt one with the maximum alone and its HP cut, the dying, stable and dead with the maximum alone, an average under 1 not offered, senses cut with an ellipsis, and never `initScore`, `creatureType`, `cr`, `xp`, `legendary` or `dmNotes`. Every player patch passes the `token.update` schema and `canApply`. The size never rides in the numbers patch. The attach's two ops, driven through a fake dispatch: the resize is built by `resizePatch` and sent only after the link's `taken`, from the view as it then stands. The Size line's cases: the preview (no change, a shift, or "No room to grow here", which sends no resize), the DM's line with no check, a locked companion (no resize, the link and numbers sent), the link refused (no resize), `unknown` (no resize), the fresh check refusing after the link's answer, the resize refused (the link and numbers stay, Done offered), a cancel before the link's answer (a late `taken` sends no resize and toasts), and a close while the resize waits (a late refusal toasts). The picker's lists: a player's and the DM's both hold Bree's and the SRD's and no room monster, and search narrows each.
- `client/features/tokens/companions.test.ts`: a block fills only untouched fields, `companionInput` carries the link and the block's speeds, Passive Perception, senses and initiative bonus, an effect sends no link, and a chosen block that leaves the view is unchosen.
- `client/features/monsters/draft.test.ts`: the editor's patch, diffed against the opened block, keeps another's change to another line.
- `client/features/tokens/access.test.ts`: the companion owner's new fields agree with `canApply`. `client/features/tokens/panelOrder.test.ts`: the section shows for a creature companion's player with no link.
- `client/state/store.test.ts`: a player's block create, update and delete and an attach are predicted, a companion create with a block is not, and a block save refused by the bucket rolls back its prediction while the moves queued after it are sent and taken in order.
- `client/features/monsters/draft.test.ts`, the editor's save logic: on `BLOCK_SAVES_TOO_FAST` the draft stays and Save is disabled for `companionBlockWriteRefillMs`, then enabled. A guard's refusal shows in the block's words.

Integration, `*.itest.ts`:

- `server/rooms/manager.itest.ts`: a room stored at snapshot version 9 loads at 10 with an empty collection, and a block create is stored and replays.
- `server/rooms/projection.itest.ts`: over the socket, a player receives their character's blocks and no other's, the table display receives none, and an owner change moves them.

e2e, in `e2e/companions.e2e.ts`, new, on `E2E_PORT` plus 16 (plus 12 to 15 are other files'), run one after another with the other files:

1. A player, with "Players can create their own characters" off, opens Bree's card, Add a companion, Choose a stat block, searches "owl" and picks Owl. The name, Tiny, HP 1 and AC 11 fill, and the line lists fly 60 ft. After Add and place, the bar shows AC 11, HP 1/1, the speeds, and saves "Str −4" to "Cha −2", and "Stat block" opens the panel at the Owl block with the SRD credit.
2. The same player pastes a made-up block, written in the test, through Stat blocks, Paste a stat block, and saves it. A companion added from it is dismissed, and Add a companion offers the block again and fills the form.
3. Attaching to a companion made with typed numbers: the numbers step, Average and a typed HP, an unhurt companion full at the new maximum, a hurt one keeping its HP, temporary HP and a condition kept, and the block's size applied for the player as a second op through the token window design's resize. Ctrl+Z right after takes back the size alone: the companion is its old size where it stood, with the block and its numbers kept.
4. Detach keeps the numbers. Change swaps the block in one step.
5. A second player sees the companion's token, name and HP, with no Stat block section in its panel and no saves or "Stat block" in its bar. What their socket receives is the integration test's.
6. The DM sees the block in the companion's panel. The DM makes a companion of a token placed from a room monster: the DM's panel shows its block with the line that Bree's players do not see it, and no way to copy it. The player's panel shows "Attach a stat block" and no block. Neither's picker lists a room monster. The DM's "Copy to Bree's stat blocks and edit" of the Owl, for which the DM set a default image, saves a block with no picture.
7. On a scene whose walls block moves, the player attaches a Large block to a Small companion with a wall along its right side and open floor to its left. The Size line says it moves a little to clear the wall, and after Attach the companion is Large, grown to the left over the square it stood on, with its middle on its own side of the wall and its core clear of it, where a move could end. In a 5 ft corridor, walls on both sides, the Size line reads "No room to grow here: Hoot keeps its size.", and after Attach the companion is Small with the block linked and its other numbers applied. The same attach to a locked companion keeps its size with the lock's line. The DM's attach of the same block grows it at the base spot, unchecked. A player who saves blocks past the bucket sees the refusal in the editor while their companion's drag and an HP change go through at once.
8. Deleting a block in Bree's stat blocks leaves its companion's panel reading "This companion's stat block was deleted.", with the numbers unchanged.
9. Viewing as the player, Save in the editor flashes refused and the editor stays open.
10. At 390 x 844, 844 x 390 and 1280 x 800, at 100% and 130%, the add form, both picker steps and the stat blocks page show without sideways scrolling, with Attach and Save in reach.

`e2e/size.e2e.ts`'s sweep of every dialog gains both picker steps and the editor for a character's block. `smoke`, `table`, `regress`, `tokenpanel`, `combat` and the phone files run unchanged, since the DM's flows on other tokens keep their roles and names.

## 11. Build plan

One part, in one workspace from the PDF build's tip or later, and after the token window build lands its resize, which the numbers step's Size line calls (section 8). Commits:

1. `feat(companions): stat blocks a character keeps for its companions`. `shared/model.ts`, `shared/protocol.ts`, `shared/keys.ts`, `shared/initial.ts`, `shared/limits.ts` (the caps and the bucket), `shared/migrate.ts` (snapshot 10), `shared/reducer/companionBlocks.ts` (new) and the reducer's dispatch, `characterDelete` in `shared/reducer/tokens.ts`, `shared/project.ts`, `shared/reads.ts`, `shared/referencedAssets.ts`, `shared/permissions.ts` (the block ops), `shared/testutil.ts`, `server/rooms/sizeGuard.ts` (blocks outside the scene measure), `server/rooms/budgets.ts` and `server/rooms/ws.ts` (the raised snapshot and send-buffer budgets), `server/rooms/stateSchema.ts`, `server/rooms/remap.ts`, `server/rooms/undoLabels.ts`, `server/rooms/actor.ts` (`DELETIONS`, the per-member bucket's refusal and the block words for a guard's refusal), and their tests.
2. `feat(companions): a companion links one of its character's stat blocks`. `Actor.blockId`, the link rules in `shared/reducer/tokens.ts` and `shared/reducer/companions.ts` (`checkBlockLink`, `normalizeCompanionState`), the one-link rule behind `oneLinkPerActor` and the op version 6 step in `shared/migrate.ts` (shared with the token window build, or 7, by 3.6) with `shared/reducer/opVersion5.test.ts`, the restore's references in `shared/reducer/misc.ts`, the owner fields (`srdId` and `blockId`) and `companionCheck` in `shared/permissions.ts`, `client/features/tokens/access.ts`, and their tests. A companion's size permission and wall check come from the token window build (section 8).
3. `feat(ui): pick, paste and edit a companion's stat block`. `client/features/monsters/MonsterPicker.tsx` (the character, both steps), `MonsterEditor.tsx` (the target, the answered save, the opened base) with `draft.ts`, `statBlockLink.ts`, `client/features/tokens/statSummary.ts`, and new `client/features/tokens/companionBlocks.ts` and `CompanionBlocks.tsx` (the numbers step and "Bree's stat blocks"), with their tests.
4. `feat(ui): a companion's stat block in its panel, bar and tracker rows`. `client/features/tokens/StatBlockSection.tsx`, `StatSummary.tsx`, `client/canvas/TokenActionBar.tsx`, `client/features/encounter/Row.tsx`, the Companion section's line in `CompanionsSection.tsx`, and their tests.
5. `feat(ui): add a companion from a stat block`. `CompanionForm` and `CharacterCompanions` in `CompanionsSection.tsx`, `client/features/tokens/companions.ts`, the stat blocks page's state in `CharactersPanel.tsx`, and their tests.
6. `test(e2e): companion stat blocks`. `e2e/companions.e2e.ts` and the `e2e/size.e2e.ts` cases.
7. `docs: companion stat blocks in the feature list and the update notes`. FEATURES.md as section 12, README's Updating section (reload open pages, rollback is a restore of the pre-update backup, and a DM's snapshot may now be up to 6 MiB), and a line in docs/design.md section 6 naming `companionBlocks` and pointing here.

## 12. FEATURES.md

Under "Companions", after the line on adding a companion:

- "A creature companion can have a full stat block: an SRD 5.2.1 creature, such as an owl for Find Familiar or a wolf, text pasted from a book with "Paste a stat block", or one typed in the editor. Its players and the DM read it in its panel, and its action bar shows its saves, resistances and immunities. Other players see its token, name and HP as before."
- "A character keeps up to 100 stat blocks for its companions, so a familiar summoned again starts from the same block. Its players and the DM add, edit and delete them from the character's card. "Add a companion" can start from one, which fills in the form."
- "Attaching a block can set the companion's AC, max HP (the block's average, a typed number, or the maximum it has), speed, size, senses, passive Perception and initiative. An unhurt companion stays at full HP, and a hurt, dying or dead one stays so. Conditions, effects and temporary HP stay."
- "A block's size goes through the same resize as any token's: a companion its player grows near a wall grows into the space around it, still covering where it stood, and moves just enough to stand where a move could end, never across the wall, or keeps its size with "No room to grow here", while the block and its other numbers still apply. Ctrl+Z right after attaching takes back the size change alone, and the block and its numbers stay. Detach takes the block off."
- "A summon cast at a higher level takes its AC and HP as you type them when you add it."

Under "Characters and monsters", the line "A player whose token is an SRD monster, such as a druid's Wild Shape, can read its SRD block. A room monster's block never reaches players." becomes: "A player whose token is an SRD monster, such as a druid's Wild Shape, can read its SRD block, and a companion's players read its block. A room monster's block never reaches players, a companion's included."

Under "Secrets stay secret", the list of what players' devices never receive gains "other players' companion stat blocks".

## 13. Not changed, with the reason

- **The DM's tokens that are not companions** keep today's section, picker and buttons. Linking there sets only the link, as docs/design-v1-dm-tools.md 3.6 decided, so Change and the numbers step are a companion's.
- **A room monster copied from the SRD shows no credit.** A room monster has no field for where it came from. Companion blocks keep `fromSrd`, and the same optional field on a room monster is a small follow-up.
- **Player characters** get no stored stat blocks: their sheets live on D&D Beyond (features section 19), and a Wild Shape token keeps its SRD link as today.
- **A block never moves to another character.** Its readers are its character's owners, so moving one would change who reads it. A player pastes it again for another character.
- **No spell level and no dice** (section 7). Saves and attacks are read, never rolled. The auto-roll saves design decides rolling (section 8).
- **Other players never read a companion's block**, by the project owner's answer 2.
- **A room monster's block never becomes a companion's** (Decided 1), as wave 5 decided for players (docs/design-v1-dm-tools.md 3.6). The DM pastes or types a block for a companion, as its players do.
- **The Monsters panel and the encounter builder** do not list companion blocks. They are the characters', and the DM finds them in each character's card.
- **Blocks still ride in every DM snapshot**, in a budget of their own on top of the 3 MiB for everything else (3.4). Loading them on demand, so a DM's snapshot holds only the blocks in view, is a later change if rooms need more.
- **The 8 MiB state limit stays.** It still holds, and the blocks' 3 MiB comes out of what a room can store (3.4). Raising it is a separate question, for the database and the backups as much as for blocks.

## 14. Decided

The project owner answered draft 1's three questions on 2026-10-16. Each answer is applied through the whole design: rules, matrix, tests, build plan and FEATURES.md text.

1. **A room monster's block for a companion: no.** Room monsters stay the DM's alone. Players use an SRD pick, a paste or the editor, and the DM can still paste or type a block for a companion. There is no copy flow: the companion picker lists no room monster for anyone (6.1), no action copies one (6.5), and a companion linked to a room monster through "Make a companion" shows its players no block.
2. **The limits.** "100 stat blocks, 512kb per character, and whatever size increase would be appropriate to match." So a character keeps at most 100 blocks and 512 KiB, and a block stays at most 16 KiB. Draft 2 capped a room at 1 MiB inside the existing budgets. In design review round 1 the project owner chose to raise the room's budget instead: about 3 MiB of blocks per room, so each of five characters can use its full 512 KiB. So a room keeps at most 600 blocks and 3 MiB (six characters at their caps), the DM's snapshot holds the blocks on top of the 3 MiB for everything else (at most 6 MiB), the snapshot budget and the send-buffer limit grow by the same 3 MiB per snapshot, the 8 MiB state limit still holds with the rest of the room at its caps, every guard's refusal of a block save speaks of blocks, and the DM's room load grows with it (3.4).
3. **A placed companion's size: its players too, checked like a move.** The project owner first answered "Its player too", with walls checked at the next move. Told that a footprint grown over a wall could put its middle past the wall, the project owner chose "Grow away from walls": a player's resize is checked like a move, shifting the least distance needed to stay on its own side of every wall that blocks moves, judged from the token's current middle, and refused with "No room to grow here" when no spot nearby fits. In design review round 1 the coordinator settled two points for both designs: every player's resize is checked, shrinking and same-size patches included, and "clear of walls" means the move rules' own standing test, the core clear and the middle on its own side, so a Large creature in a 5 ft corridor gets "No room to grow here" (4.1). In round 2 the coordinator added that a growth's candidates must cover every square the creature filled before, so a growth beside a wall shifts only within the space around where it stood, or is refused. The DM's resizes are never checked, and nothing is checked on a scene whose walls do not block players' moves. docs/design-v1-token-window.md owns this rule, with its op and permission, for every token an owner may change, companions included. This design defers to it in 4.1 and sends the numbers step's size through it, always as a second op after the link's answer, with the undo outcome of 5.1.
