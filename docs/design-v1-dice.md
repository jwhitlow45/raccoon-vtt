# raccoon-vtt v1: dice rolls, the shared contract

Status: draft 3, after design-wave7 rounds 1 (section 1.1) and 2 (section 1.2), with the project owner's answers of 2026-10-17 (section 17). Code is cited from the wave 6 design tip `da0e973d`, whose code is the wave 5 tip's. This is the first of four wave 7 designs and the contract the other three build on: docs/design-v1-pc-stats.md ("doc 2", PC stat blocks), docs/design-v1-roll-options.md ("doc 3", per-creature roll options and group rolls) and docs/design-v1-roll-request.md ("doc 4", the request sheet and its cards). Section 10 lists every change to another design, in one place. Error words, sizes, layouts and worked examples are in the appendices, which verify rounds need not re-read.

The project owner asked on 2026-10-17: "We should also add support for rolling dice for everyone. There should be a side panel called dice with a dice roller at the top where any dice formula can be entered (10d4+1d8 for example). [...] when a dm prompts someone for a save or other roll that player should be able to either input a manual roll or click a button to roll the save." Their answers the same day: rolls happen on the server, with a cryptographic random source, so everyone sees the same result and nobody can fake one, and a roll needs a connection. Rolls are public by default, in the log. The DM's rolls for monsters are hidden by default: players see that the DM rolled, not the number. Anyone can roll to the DM only, for a single roll.

## 1. Summary

- **One grammar** (`shared/dice/formula.ts`): dice `NdM` and `d%`, keep or drop the highest or lowest (`4d6kh3`, `2d20kl1`, `4d6dl1`), numbers, any mix joined by + and -, then words: `adv` or `dis`, and a label ("2d6+3 fire"). At most 100 dice and 20 parts a roll.
- **The server rolls.** A client sends `dice.roll` (1 to 20 formulas), `roll.dice` (a request's answer, rolled with the creature's own bonus) or doc 3's `actor.deathRoll`. The room actor turns each into a stored server op, `sys.dice`, holding every die it drew, as it turns an undo into `sys.restore`. The reducer only copies those dice, so replay never rolls. The random source is Web Crypto's `getRandomValues` through the passphrase generator's rejection sampling. An op holds 20 rolls, 3 KiB and 100 dice, so a line stays near the size of the longest whisper the log holds, and larger groups go in batches every viewer sees as one.
- **The record is a log line.** A free roll writes one `dice` line, a rolled answer the request's `roll` line with its dice. Snapshots, reconnects, older log pages and the session export carry both. A lost result is looked up, never rolled again.
- **Who sees it.** Everyone, by default. A secret roll ("to the DM only", where a DM's roll for a monster starts) reaches the DMs and the roller with its numbers, and other players as a bare line, "Mara rolled in secret", only when the same roll made public would have reached them. A hidden creature's roll leaves no trace. A request's answer stays between the DM and the creature's players.
- **Every d20 roll is a `D20Test`**: saves (concentration and save ends included), death saves, checks, initiative and attacks. Advantage and disadvantage travel as named sources and resolve once, just before the op is built. Bonuses come from stat blocks through `creatureBonus` over `RollNumbers`, and attacks, save actions and heals share `NamedRoll`.
- **The Dice panel**, for everyone: a sticky line with your last result, the formula field and Roll, quick dice, Adv, Dis and Secret as one-roll choices taken at the tap, then doc 3's options, then Recent rolls. Every surface that rolls shows the result at the control that rolled it. Others' rolls show as toasts.
- **The request card always offers Roll** (doc 4 lays it out): with the creature's bonus, or "Roll d20" and a bonus the player types. A rolled answer is final for its player. The DM approves a reroll or an added die in one tap, and never overwrites an answer that came first.

### 1.1 What round 1 changed in the contract

Stated first because docs 2 to 4 call these exactly:

- **`D20Test`** has five kinds: `save` (with `cause?: 'concentration' | 'saveEnds'` and `spell?`), `deathSave`, `check`, `initiative` and `attack` (`range?`, `spell?`), and the helpers `isSave`, `isCheck` and `abilityOf` (6.1).
- **Advantage is sources.** `AdvantageSource = { kind: 'adv' | 'dis', from }`, and `resolveAdvantage(sources)` gives `'adv'`, `'dis'` or none: any advantage with any disadvantage is a normal roll, however many of each. Presets, the panel's buttons, typed words and a card's chips each add sources. Only the builder of an op resolves them, once (3.3).
- **`take()` at the tap.** A panel roll takes the one-roll choices when it is sent, so two taps never share one Advantage, and a late result never clears a newer choice (8.4).
- **`AdvantageMode`** names `'adv' | 'dis'`, since `client/features/encounter/autoRoll.ts:31,136` already has `Advantage` and `RollMode` (W7-P-23). Fields keep the name `mode`.
- **`batchRolls`** splits at all three op bounds (8.4). **`batch`**, an opaque id, groups a batch for every viewer (5.1).
- **`roll.dice`** (doc 4 7.1's four needs): a player's roll needs a waiting target, `bonus` is used only when the server knows none, `change` is the DM's Allow, naming the ask's id (doc 4's `roll.change`, doc 4 1.1), and the server records `fails` on a rolled save (4.1, 4.3, 5.4). **`dice.roll`** gains `ac` beside `dc`, and each roll `critOn` (5.6).
- **`testOf(request, choice)`** takes the request, so doc 4's `RollRequest.spell` and its public `cause: 'saveEnds'` reach the test (6.1). **`NamedRoll`** gains `conditions`, `saveEnds`, `lasts`, a rider's `name` and doc 2's `critOn` (6.2). **`RollNumbers`** gains doc 2's `deathSave`, and `creatureNumbers` and `creatureBonus` follow doc 2's shapes (6.1). Doc 3's **`actor.deathRoll`** is a dice op (4.1).
- **`useReceipt(tag)`** and the feedback rule (8.7), with round 2's receipts (1.2).

### 1.2 Settlement: receipts, not history

Stated here once. Docs 3 and 4 call it for every surface, request answers included (W7-ASTRA-02, W7-DATA-04, W7-ASTRA-26):

- **Every op that rolls or applies carries a client id, `tag`** (an `id`, minted on the device): `dice.roll` (with `part` for each batch), `roll.dice` (approved changes included), `actor.deathRoll`, and doc 3's `actor.outcome`, whose plan id is its tag. Doc 4's `roll.answer` carries one too, and the answer keeps it as `tag` (doc 4 1.1). A tag is unique per member and room.
- **Admission comes first** (W7-ASTRA-32, W7-DATA-18). A new tagged op is admitted only when the room is writable, the day's cap and the member's share have room (below), and the member's budget (4.4) covers its admission cost, `admissionCost(op)`: `dice.roll` and `roll.dice` their roll count, and every other tagged op (`roll.answer`, `actor.outcome`, `actor.deathRoll`) one (W7-P-54, W7-ASTRA-34, W7-DATA-18). The cost is charged at admission, before any permission check, so an op that permissions later refuse, such as a `roll.answer` naming no request or a player's `actor.outcome`, has paid for its receipt. An admission refusal advances the client's watermark as every refusal does, and allocates no receipt, draws nothing and applies nothing, so a flood of refused ops, a player's over budget included, leaves the receipt count as it was. The device normally reads that refusal in its `ev`. One lost on the way stays `unknown` through the lookup, which is safe, since unknown never sends again on its own. The socket and room op rates answer `retry` with `busy` before any of this (docs/design.md 7.2), so they consume nothing.
- **The server keeps a receipt for every admitted op**, per member, `tag` and `part`, written in the same transaction as the batch that settles the op, beside `client_watermarks` (`server/rooms/persistence.ts:201-204`): `committed` with the op's `seq`, or `refused` with the code and message of a refusal after admission (permissions, the resolve, the reducer, the limits). An op whose payload fails the schema has no readable tag and gets none. Table `roll_receipts (room_id, member_id, tag, part, state, seq, code, message, at)`, primary key `(room_id, member_id, tag, part)`, so one member's tag never meets another's.
- **The receipt is the dedupe record, apart from the result.** A row holds only the state, seq and refusal words, a hundred bytes or so. The result itself is the log lines the seq names, which the archive may prune by count (`:266-272`) without touching the receipt, so a committed op never turns into a missing one.
- **Retention** (W7-ASTRA-27, W7-DATA-16): a receipt younger than 24 hours is never evicted, by count or by anything else. Pruning, daily as watermarks are (`pruneWatermarks`, `:277-280`), deletes rows older than 7 days, and of the rows older than 24 hours keeps the newest 10,000 per room. The room's quota counts the rows.
- **The cap reserves before it admits, and never evicts.** A room holds at most `receiptsPerDay` (10,000) receipts younger than 24 hours. Admission reserves one slot for the op's receipt, counting the receipts held and the slots of ops admitted and not yet committed, so the cap is never passed, by work in flight either. When no slot is left, the new tagged op is refused at admission with `quota`, "This room has rolled and applied 10,000 times in the last day. Wait a while.", and that refusal takes no slot. A duplicate is still answered from its receipt. Slots come back as receipts pass 24 hours, and a batch that fails to commit gives back its slots with the rest of its staged work. A heavy session uses one or two thousand. Every admitted op costs at least one token, so a member uses slots no faster than their budget: the DM's full rate would take about 80 minutes to fill them.
- **A player's daily share.** A player's receipts younger than 24 hours, with their slots in flight, count against `receiptsPerPlayerDay` (2,000). At that many, the player's new tagged ops are refused at admission with `quota`, "You have rolled and answered 2,000 times in the last day. Wait a while.", with no receipt. A DM's share is the whole room cap. So no single player can fill the room's day, whatever they send, and a heavy session's player uses a few hundred. The DM can still sign out a player who misbehaves (docs/design.md 10.8).
- **The same tag is never applied twice.** For every op that carries a tag, ahead of its admission and permissions (4.2), the actor holds every receipt of the room younger than 24 hours in memory (loaded with the room, so a restart keeps them, at most 10,000 by the cap) beside the batch's staged ones. An op whose member, tag and part have one is a duplicate, whatever its `n`: a committed one is answered with its ack and no change, a refused one with the same refusal. It spends no budget and draws nothing. So `actor.outcome` is idempotent by plan id, and any retry with the same tag is safe within 24 hours. A surface offers a retry with the same tag only within 12 hours, the life of a pending op (docs/design.md 7.4), so it always falls inside that window.
- **The lookup**: `GET /api/rooms/:roomId/receipts/:tag` answers the caller's own receipts for that tag, `{ parts: ({ part, state: 'committed', seq, lines } | { part, state: 'refused', code, message })[] }`. A part the device sent and the answer lacks is `unknown`: never seen, past retention, or no receipt at all. `lines` are the entries the op wrote (ids `<seq>:<index>`), from memory or `room_log`, projected for the caller as the live log is, and may be empty when pruned or now hidden. Only the caller's own receipts are read, so another member's tag answers nothing. It reads by key, never by paging, so hidden stretches of the log leave no gap. Limited to `receiptLookupsPerHour` (60) per member and room.
- **On the device**: `useReceipt(tag)` (8.7) holds `sending`, then `committed` with its lines, `refused` with the reason, `checking` while it asks the lookup, or `unknown`. A pending op the snapshot settled without its own ack or refusal (`client/state/store.ts:533-563`), and a tag a surface kept across a reload, are looked up once. **Unknown never rolls or applies again on its own**: the surface says "This may have happened. Check the log.", and only the user's explicit action sends again, a roll with a new tag, an outcome with the same plan tag.

## 2. Today

- **"No dice roller"** is a constraint (docs/design.md:18). The one roll, auto initiative, runs on the DM's device with `randomIndex` (`client/features/encounter/autoRoll.ts:27-37`, `shared/passphrase.ts:15`) and sends totals, so "no randomness reaches the reducer" (docs/design.md:53).
- **Requests**: `roll.ask`, `roll.answer`, `roll.reopen`, `roll.close` (`shared/protocol.ts:1154-1168`, `shared/reducer/rolls.ts:19-132`). An answer is a typed total. `isFinal` (`rolls.ts:54-56`) locks a player's answer only under a hidden DC with results shown. The card sends `roll.answer` and waits (`client/features/rolls/PlayerRolls.tsx:577-595`). Each answer writes a `roll` line (`rolls.ts:105-115`, `shared/model.ts:1441-1462`) for the DM and the creature's players (`shared/project.ts:1278-1300`).
- **Server-built ops**: the actor parses with the client schema (`server/rooms/actor.ts:797`). An undo naming a log line is checked with `canApply` first, then built into a `sys.restore` and checked with `checkServerOp` (`:807-830`, `:1479`). A player's block saves spend a per-member budget, refused with `quota` when spent (`:878-886`, `:924-931`). `#reduce` stamps, reduces, checks limits and stores `{seq, at, actor, op}` (`:942-976`). `sys.*` ops go on no undo stack (`server/rooms/undo.ts:86-91`), and ops the server decides read `NEVER`, so they wait (`shared/reads.ts:47-54`).
- **The log**: the newest 200 entries stay in memory (`shared/reducer/tx.ts:32,196-205`). A DM gets every entry, a player each event through an allowlist (`project.ts:1302-1313`), and one about a token only when it is visible now and was marked `seen` or is owned (`holderOfEvent`, `project.ts:1150-1166`). Older pages project the same way (`server/http/log.ts:14-20`). A snapshot settles every pending op at or under the watermark without saying how it ended (`client/state/store.ts:533-563`).
- **A creature's numbers**: every actor has `initBonus` (`model.ts:712`). Room monsters and companion blocks hold abilities as `{ score, save }` and skills as text (`model.ts:810-811`). An actor links at most one block, `srdId`, `monsterId` or `blockId` (`model.ts:729-735`). An SRD block is Markdown only (`shared/srd/monsters.ts:16-44`). Characters have no saves or skills (doc 2 adds them).
- **Panels** come from one registry (`client/features/panels.ts:94-110`). The tabs fit what the row holds (docs/design-v1-panel-tabs.md 3.2), the split panel takes any two (docs/design-v1-split-panel.md 3.5), and every phone panel sheet swipes (docs/design-v1-sheet-swipe.md 3). A sticky header keeps to its scroller's top through `paneBodyPadding` (`client/components/Sheet.tsx:204-211`, docs/design-v1-combat-flow.md 3.1).

## 3. The formula

### 3.1 Grammar

```
roll text = formula { word }
formula   = [ sign ] term { sign term }
term      = dice | number
dice      = [ count ] "d" ( sides | "%" ) [ keep ]
keep      = ( "kh" | "kl" | "dh" | "dl" ) [ n ]
sign      = "+" | "-" | "−"
```

- `count`, `sides`, `n` and `number` are digits. Letters match in any case. `d%` is `d100`. U+2212, the SRD's minus, reads as `-`. Spaces and tabs may stand between terms and signs, never inside a term.
- `count` and `n` default to 1. `kh n` keeps the n highest, `kl n` the n lowest. `dh n` and `dl n` drop the highest or lowest and read as the matching keep: `4d6dl1` is `4d6kh3`.
- The formula ends at the first token that is not a sign or, after a sign, a term.

### 3.2 Bounds and errors

1 to 100 dice, a term's count included and advantage's second d20 counted, sides 2 to 1,000, numbers to 1,000, keep 1 to all of them and drop 1 to all but one, 20 terms, 100 characters. A total then lies within ±120,000. One table, `FORMULA_ERRORS`, words each refusal the same on the client and the server (Appendix A).

### 3.3 Words and advantage sources (the cancel rule)

- `adv` or `advantage`, and `dis` or `disadvantage`, as whole words in any case wherever they stand, are advantage sources ("typed"), taken out of the label. Typing both is two sources, not a resolved roll, so they combine with every other source by the rule below.
- The other words, joined by single spaces, are the label: at most 60 characters, under the single-line text rules (docs/design.md 6). "1d20+5 Stealth adv" is 1d20+5 for Stealth with one advantage source.

```ts
type AdvantageSource = { kind: 'adv' | 'dis', from: string }   // a key: "restrained", "magic-resistance", "pressed", "typed"
resolveAdvantage(sources): AdvantageMode | undefined           // shared/dice/formula.ts
```

- **One rule, at the end.** `resolveAdvantage` returns `'adv'` when the sources hold only advantage, `'dis'` when only disadvantage, and nothing when they hold none, or both, however many of each, by the SRD's rule that advantage and disadvantage on one roll cancel. Hasted and Restrained on a Dexterity save, with Advantage pressed, roll normally.
- **Who resolves.** Every surface gathers its sources: doc 3's presets (its `RollPreset.sources`, this one shape, W7-P-41), the panel's pressed choice, typed words, doc 4's chips, a group row's. Each surface words a source from its key. It calls `resolveAdvantage` once, as it builds the op, which carries the result as `mode`, and `cancelled: true` when both kinds were there, so a later Lucky (5.4) still knows the roll cancelled. No helper resolves early, so no cancellation is lost. A surface may let the roller drop a source it judges wrong, such as a preset's.

### 3.4 Advantage on the dice

A resolved mode applies to the formula's one d20, exactly one term that is `1d20`, positive, with no keep. It becomes `2d20kh1`, or `2d20kl1`, and the result keeps `mode`. A resolved mode on a roll without one d20 is refused ("Advantage and disadvantage need one d20 in the roll."). Sources on such a roll, such as the panel's on damage, are never added.

### 3.5 Functions

```ts
// shared/dice/formula.ts
type DiceTerm = { kind: 'dice', sign: 1 | -1, count, sides, keep?: { high: boolean, n } }
type NumberTerm = { kind: 'number', sign: 1 | -1, value }
type Formula = (DiceTerm | NumberTerm)[]        // 1 to 20 terms, at least one die
type AdvantageMode = 'adv' | 'dis'

parseFormula(text)   // { ok: true, formula } | { ok: false, error }: dice and numbers alone, words refused
parseRollText(text)  // { ok: true, formula, sources, label? } | { ok: false, error }: the Dice field's text
parseExtra(text)     // roll.dice's extra: dice and numbers to add, no die needed, a bare first term adding
applyMode(formula, mode)            // { ok: true, formula } | { ok: false, error }
formatFormula(formula, mode?)       // canonical "1d20+5": lowercase, no spaces, every count and n written
formulaRange(formula)               // { min, max }, and diceCount(formula)
doubleDice(formula)                 // a critical hit's damage: every dice term's count doubled (doc 3)
addDie(text, sides)                 // a quick die: "d6" becomes "2d6", "2d6" gains "+1d8", words after it kept
d20Formula(bonus, mode?)            // "1d20+5", "1d20-1", "1d20" for 0
```

`formatFormula` with a mode writes the d20 back as `1d20` and adds "with advantage", so the text says what was asked.

## 4. The server roller

### 4.1 Ops

```ts
// Client ops (shared/protocol.ts)
op('dice.roll', {
  tag: id, part?: number,     // the receipt's key (1.2): one tag for a whole group, part 0 to 19 for each batch
  to: 'all' | 'dm',
  dc?: rollDc, ac?: rollDc,   // one at most: each total is compared with it (5.6)
  rolls: DiceRollInput[],     // 1 to 20, 100 dice in all, every formula parsing and every mode applying
})                            // and the whole op at most 3 KiB serialized (LIMITS.diceOpBytes)
type DiceRollInput = { formula: string(100), mode?: AdvantageMode, label?: line(60), creature?: ActorTarget,
  cancelled?: true,           // its sources held both kinds, so it rolls normally (3.3)
  critOn?: 18 | 19 | 20 }     // an attack roll's critical range (5.6)
op('actor.deathRoll', { tag: id, target: ActorTarget, mode?: AdvantageMode, cancelled?: true, extra?: string(40) })   // doc 3 4.3
op('roll.dice', { tag: id, rollId: id, target: ActorTarget, choice?: 0 | 1, mode?: AdvantageMode, cancelled?: true,
  extra?: string(40),         // parseExtra: added after the d20 and bonus, as "+1d4" or "-4"
  bonus?: number,             // -20 to 30: the player's own, used only when the server knows none
  unanswered?: true,          // roll only a target still waiting (doc 4's live card)
  change?: id })              // the DM's Allow: the id of the pending ask it approves (5.4)

// Server op, stored in place of each
op('sys.dice', {
  asked: OpOf<'dice.roll' | 'actor.deathRoll' | 'roll.dice'>,   // the client op as it arrived
  batch: string,                                  // 16 characters (5.1)
  results: DiceResult[],                          // one per roll, in order: what the server drew (5.1)
})
```

No client may send `sys.dice` (`serverOnlyOps`, `protocol.ts:1191`). Its schema bounds `asked` and `results` by shape and length and parses no formula, so a later change of the grammar never stops a stored op's replay (`shared/migrate.ts:113-120`). The resolve that builds the results is what makes them right. A roll whose result an op applies in the same op adds its client op to `asked` and a branch to the reducer, never a second server op. `actor.deathRoll` is one (doc 3 4.3): permitted as `actor.deathSave`, it rolls `1d20` with the creature's `deathSave` bonus and `extra`, and its branch writes the line and counts the save from the state then (10 or more a success, a natural 1 two failures, a natural 20 1 HP), so no later write can overwrite newer counts. Any other later form follows the same pattern.

### 4.2 The pipeline

For `dice.roll`, `actor.deathRoll` and `roll.dice`, after docs/design.md 7.2's sequence, rate and payload steps:

1. **A tag already settled** is answered from its receipt (1.2), before anything else is looked at.
2. **Admission** (1.2), before any permission check: a read-only room refuses as for every op, the day's cap and a player's share reserve a receipt slot, and the member's budget (4.4) is charged `admissionCost(op)`, where block saves spend theirs (`actor.ts:883`). A refusal here takes no slot and leaves no receipt. The same step runs for every tagged op, `roll.answer` and `actor.outcome` included.
3. **`canApply` checks the client op** (4.3) before anything is drawn or a bonus read, as an undo from the log is checked (`actor.ts:807-812`). So no refusal depends on the roll: a player naming a hidden creature gets `gone`, never "no bonus".
4. **Resolve**: `resolveDice(op, state, { draw, srd })` in a new `server/rooms/dice.ts` parses each formula and applies its mode. For `roll.dice` it builds `1d20`, the bonus (the creature's from section 6, else `bonus`) and `extra`, with the mode on that first d20 alone, or with `change` the asked reroll or added die (5.4). For a save it also stores `fails`: the condition doc 3's preset (`shared/rules/rollReminders.ts`) finds among the creature's effects not hidden from its players, so no line reveals a hidden one. It refuses what 4.3 names, derives `batch` (the first 16 characters of the base64url SHA-256 of `by` and `tag`), draws every die with `draw`, and builds `sys.dice`, checked with `checkServerOp`.
5. **Reduce, limits and store**, as every op. `canApply` on `sys.dice` applies the rule of the op it carries. The batch's commit writes the admitted op's receipt (1.2), `committed`, or `refused` for a refusal after admission (steps 3 to 5).

`serverDraw = (sides) => randomIndex(sides) + 1`: the passphrase generator's rejection sampling over Web Crypto's `getRandomValues`, which Node 24 has globally, from the system's secure random source. Draws go term by term, die by die. Only the resolve calls it. Replay applies the stored results and never draws. A roll resent after a dropped socket is a duplicate `n` (7.2's sequence step), so it rolls once.

### 4.3 Permissions (`shared/permissions.ts`)

- **`dice.roll`**: anyone. A table display sends no ops. Each `creature` must exist, anywhere for the DM. A player's must be one they own now, as for a roll answer: one they cannot see is `gone`, one they see and do not own is `forbidden`, "You roll only for your own creatures."
- **`roll.dice`**: as `roll.answer` (docs/design.md 9.11): a player for a target they own now, else `gone`, and the DM for any target. A player's roll, and any roll with `unanswered`, is refused `invalid`, "It was answered meanwhile.", when the target has a total or a result: a player rolls only a waiting creature, typed or rolled answer alike, and a DM's Roll that crosses a player's answer never replaces it. `change` is the DM's alone (`forbidden` for a player), refused `invalid`, "It was settled meanwhile.", unless the target's pending ask has exactly that id, its `on` is the current answer's `tag`, and that answer has `dice` (W7-ASTRA-20, W7-DATA-12). So an ask replaced or withdrawn while the Allow travels, or a second device's Allow, draws nothing. All of these are checked before any draw.
- **The resolve refuses**, with `invalid`: a change it cannot apply to the stored result (5.4), a creature with no bonus known and none sent, "No bonus is known for that roll. Type your bonus or the total.", and a roll whose range leaves -50 to 100, the totals an answer holds, "That roll could total outside -50 to 100. Type the total instead."

### 4.4 Budget and limits

- **Every member's budget**: a bucket per member, 20 tokens refilled one every 2 s for a player, and 100 refilled two a second for a DM, whose group rolls and their damage come in bursts. Every tagged op spends its `admissionCost` (1.2): each roll of an op one, and an op with no rolls, such as a typed answer or an outcome, one. A person typing totals or marking answers stays far inside it. Spent: `quota`, "You are going too fast. Wait a few seconds.", an admission refusal with no receipt (1.2). Refused, never `busy`, so the device's later ops go on, as with block saves (`actor.ts:878-882`). In memory, like that budget.
- **A line stays near the size of the longest the log holds today**, a whisper of about 4.2 KB: the op's 3 KiB keeps a `dice` line under about 4.5 KB (Appendix B). So the in-memory log, every snapshot's share of it, `room_log` rows and the session export, which reads the whole stored log (`server/http/log.ts:54-61`), keep about their worst case. A group of 50 as one line would be about 12.5 KB, which is why larger groups go in batches (8.4), as `token.updateMany` does past 100 tokens (docs/design.md 10.5).
- **Storage**: every roll is an op row and a log row, counted by the room's quota (docs/design.md 10.1). A room at its quota refuses rolls with its usual words. The budget keeps a player under about 3 MB of rows an hour and a DM under about 12 MB.
- New `LIMITS`: `diceRollsPerOp` 20, `diceOpBytes` 3 KiB, `dicePerOp` 100, `diceTermsPerFormula` 20, `diceSidesMax` 1,000, `diceNumberMax` 1,000, `diceFormulaChars` 100, `diceLabelChars` 60, `diceExtraChars` 40, `playerRollBurst` 20, `playerRollRefillMs` 2,000, `dmRollBurst` 100, `dmRollRefillMs` 500, `receiptLookupsPerHour` 60, `receiptsPerDay` 10,000, `receiptsPerPlayerDay` 2,000, `receiptsKeptOlder` 10,000, `receiptDays` 7.

### 4.5 Undo, waiting and the connection

- No roll goes on an undo stack: the stored op is `sys.dice`, which `UndoStacks.records` leaves out. A roll stands. The DM reopens, marks or changes an answer instead.
- `reads` answers `NEVER` for these ops and `sys.dice`, so no client predicts a roll. It waits for the `ev` (8.7).
- **A roll needs a connection.** `sendRoll` sends only while the socket is open, and every Roll is disabled otherwise, "Rolling needs a connection." A roll sent before the socket dropped stays pending and is resent like any op. Its receipt settles it (1.2).

## 5. The roll record

### 5.1 Types (`shared/model.ts`)

```ts
type DiceResult = { formula: string,   // canonical, as rolled: "2d20kh1+5" for 1d20+5 with advantage
  faces: number[],                      // every die drawn, in the formula's order
  total: number, mode?: AdvantageMode,
  cancelled?: true,                     // its sources held both kinds (3.3), which a later Lucky must know (5.4)
  fails?: ConditionKey }                // a rolled save its creature fails whatever the total (4.2)

// LogEvent gains
type DiceEvent = { type: 'dice', tag?, part?, batch?, by: MemberId, to: 'all' | 'dm', dc?, ac?,
  rolls: DiceRoll[] }        // 1 to 20, and none in the bare line (5.2). `part` is the op's, so each part settles from its own line (8.7)
type DiceRoll = DiceResult & { label?, tokenId? | characterId?, seen?: true, critOn?: 18 | 19 | 20 }

// The request's `roll` line, RollTarget and RollAnswer (as `previous`) gain `dice?: DiceResult` and `typedBonus?: true`,
// the `roll` line also the op's `tag`, beside doc 4's `mark`, `change` and `changed` (doc 4 1.1)
```

- `seen` marks a roll for a token whose non-owners could see it when written (`seenByNonOwners`, as `tx.ts:218` uses it). A character needs none.
- `batch` is the same for every batch of one tag and says nothing of the tag: other players group a batch by it (8.3, 8.5) without learning the roller's id.
- The formula is text, so 20 rolls fit a line's bound. `rolledTerms(result)` reads it back with `parseFormula` and pairs each dice term with its faces. A formula a later grammar would refuse shows as its text and total. `keptFaces(term)` derives the kept dice: the n highest or lowest, and of equal faces the earlier. `naturalOf(result)` is 20 or 1 when the result has one d20 term keeping one face that shows it, else null.
- `typedBonus` marks an answer rolled with the player's own bonus (4.1), so the DM's card can say so.
- The `sys.dice` reducer (`shared/reducer/dice.ts`): for `dice.roll`, one `dice` line, each roll its result with the asked label, creature and `critOn`. For `roll.dice`, `rollAnswer` (`rolls.ts:75`) with the result's total and the choice, keeping `dice` on the target and on its line, and `result: 'fail'` with the total kept when the result holds `fails`. The reducer stores `result` as doc 4's `resultOf(answer, request.dc)` (doc 4 1.1): the DM's mark, then `fails`, then `noRoll`, then the DC. With `change` the new answer keeps the ask as `changed`, `change` clears, and `previous` keeps the old.

### 5.2 Who receives it

`projectEventCtx` gains a `dice` case. DMs get every line unchanged. A table display, which is no member of the room, gets no `dice` line, as it gets no `roll` line. For a player:

1. **Each roll is kept** when it names no creature, names a character, or names a token that passes `holderOfEvent`: visible now, and seen then or owned. So a token's roll follows that token's events, and none passes a blackout.
2. **No roll kept**: no line.
3. **Open**, when `to` is `all` or the viewer rolled it: the line with the rolls kept, `dc`, `ac` and `batch`, and `tag` and `part` only for the roller.
4. **Secret**, to any other player: the bare line `{ type: 'dice', by, to: 'dm', rolls: [] }`, "Mara rolled in secret."

So a secret roll for a goblin the party sees reads "Mara rolled in secret", as the project owner asked, while one for a goblin hidden or in the dark sends nothing. A DM's secret free roll names no creature and reaches every player as a bare line, as chat reaches them.

**The `roll` line** keeps its rule (docs/design.md 7.3): the DM and the creature's players now, with its `dice` and `typedBonus`. No other player gets it, rolled or typed (decided, 17.2). **A target's `dice`** goes to its owner with the target, `previous.dice` only to the DM, as `previous` does. Fan-out already re-projects log lines that name a touched token (`dependents`, `project.ts:1509`), and its index gains every token a `dice` line names.

### 5.3 Where it travels

- **Snapshots and reconnects** carry the in-memory log, so Recent rolls survive a reload. Older lines come through `GET /log` pages and the session export, projected as above.
- **A lost result** is settled by its receipt (1.2), never by searching the log.
- **Export and import** (docs/design.md 16.4): `dice` lines travel with the log, `roll` lines with their dice. The import schema (`server/rooms/stateSchema.ts:386-410`) takes both and the targets' `dice`. `server/rooms/remap.ts` remaps `by` and the creatures. Open requests are dropped, as today.

### 5.4 Finality, rerolls and added dice

- **A player rolls a waiting creature only** (4.3), so one answer path holds: once a total is typed and sent or rolled, the player's Roll is refused. `isFinal` is also true once an answer has `dice`, so a typed total or "Fail without rolling" after a roll is refused too, "Final. Ask the DM to change it." (decided, 17.3).
- **The DM's one-tap approval** (owner decision 1 of round 1). A player asks with doc 4's `roll.change`, which stores a `RollChange` (doc 4 1.1: its `id`, the answer it changes as `on`, the `reason`, and a reroll's `face` or Bardic Inspiration's `die`) on the target as `change`. The DM's Allow sends `roll.dice { tag, rollId, target, change: <that id> }`, refused before any draw unless that ask is still the pending one (4.3). The resolve applies the ask to the stored result (coordinator's decision 3 of round 2, W7-ASTRA-24, W7-DATA-14, W7-P-37):
  - **A reroll** (`heroic-inspiration`, `halfling-luck`) **redraws one face** of the stored `dice`, the one the ask names (`face`, an index into `faces`). Which faces an ask may name is one rule, `rerollable(result, reason, face)` (`shared/dice/roll.ts`), which doc 4's `roll.change` and this resolve both call, so the card, the ask and the roll never disagree (the coordinator's decision 2 of round 3, W7-ASTRA-30, W7-P-48): Heroic Inspiration any one die of the roll, kept or dropped, a d20 or another die such as Bless's d4, and Halfling Luck a d20 showing 1. The default the card offers is `rerollFace(result, reason)`: the kept d20 on a normal or disadvantage roll, the dropped d20 on an advantage roll, and for Halfling Luck the d20 showing 1. Every other face stays, the kept rule applies again and the total is summed again. A face `rerollable` refuses is refused before the draw, "That die cannot be rerolled this way."
  - **Lucky** (`lucky`) **adds an advantage source** to the roll, resolved by the cancel rule (3.3) with what the roll had. Decision 3's "draws one more d20" is the normal roll's case: it draws one more d20 and keeps the higher. On a disadvantage roll the two sources cancel to a normal roll, so it keeps its first d20 and draws nothing (confirmed by the coordinator). A roll already with advantage, or one whose sources cancelled (`cancelled`), changes nothing, so the resolve refuses it ("Lucky changes nothing on this roll.").
  - **An added die** (Bardic Inspiration) appends `+1dN`, N the ask's `die`, with its new face.
  - Each is judged against the DC again, recorded as a new answer with `previous` keeping the old and `changed` the ask, and is final again. Its `roll` line names the reason (5.5).
- The DM may also replace, mark or reopen any answer as today. A reopen clears the ask.

### 5.5 Wording (`shared/logText.ts`)

- `diceText(result)`: "2d6+3 (4, 6) = 13". A dropped die reads "7 dropped" in text and is struck through on screen: "1d20+5 with advantage (14, 7 dropped) = 19". Numbers carry thousands separators.
- A `dice` line: "Bree rolled Longsword: 2d6+3 (4, 6) = 13." For a creature: "Bree rolled for Thorn, Stealth: …". With `dc`: "… = 13 against DC 15: fail." With `ac`: "… = 17 against AC 15: hit", "critical hit" or "miss". Several rolls: one line per roll under "Mara rolled 6 times:". A secret line read in full ends "(secret)". The bare line: "Mara rolled in secret."
- A rolled `roll` line: `rollText` with the dice after the total, "Thorn rolled 17 (1d20+5: 12) on a Dexterity saving throw against DC 15: pass." It adds "your bonus" after the formula for `typedBonus`, "fails (Stunned)" for `fails`, and for a change "Thorn rerolled 17 (Heroic Inspiration, 1d20+3+1d4: …)" or "Thorn added Bardic Inspiration's 1d8: 3, now 15".
- Each viewer names a creature from its own projection, so a hidden name reads as players see it. A label never repeats a creature's name (docs 3 and 4 hold to this), since it reaches everyone the line reaches.

### 5.6 Attacks against an AC

A roll with `critOn` is an attack roll. `hitOf(roll, ac)`: its kept d20 at or above `critOn` is a critical hit, and a 1 a miss, whatever the total (SRD 5.2.1, attack rolls). Otherwise it hits when the total meets the AC. `critOn` is 20 unless the creature's range is wider, such as a Champion's 19 (doc 2 gives it, doc 3 sends it). `ac` on the op is the target's AC for a group attack, kept apart from `dc` so a line never reads a hit as a pass (W7-P-19).

## 6. Creature numbers and named rolls (`shared/dice/bonus.ts`)

### 6.1 Tests and numbers

```ts
type D20Test =
  | { kind: 'save', ability: AbilityKey, cause?: 'concentration' | 'saveEnds', spell?: true }   // spell: against a spell
  | { kind: 'deathSave' }
  | { kind: 'check', ability: AbilityKey, skill?: SkillKey }
  | { kind: 'initiative' }                                  // a Dexterity check in 2024
  | { kind: 'attack', range?: 'melee' | 'ranged', spell?: true }
isSave(test)   isCheck(test)   abilityOf(test)              // save and deathSave. check and initiative. 'dex' for initiative, none for a death save or an attack
type RollNumbers = {
  abilities: Record<AbilityKey, { mod, save, check? }>     // check: an ability check's bonus where it is not mod
  skills: Partial<Record<SkillKey, number>>                // a skill's whole bonus with its usual ability
  spellDc?: number, spellAttack?: number,                  // the whole spell save DC and spell attack bonus
  deathSave?: number }                                     // a death save's bonus, such as a Cloak of Protection's (doc 2)
type RollSources = { tokens, characters, companionBlocks, monsters?, srd?: SrdRolls | null }   // the state or a view

bonusFor(numbers, test)                        // number | null
creatureNumbers(sources, creature)             // RollNumbers | null
creatureBonus(sources, creature, test)         // number | null
testOf(request, choice)                        // a request's choice as a D20Test, with its spell and cause
blockRollNumbers(block: StatBlock)             // a room monster or a companion block: this doc
pcRollNumbers(character)                       // doc 2. Null while a character has no stat block
type SrdRolls = Record<SrdId, RollNumbers>     // doc 3: shared/srd/rolls.json, from scripts/srd-import.ts
```

- **Every d20 roll is one of these**, so doc 3's presets reach each path: an option, a card, a group row, a death save, initiative (single and auto) and an attack. A concentration save is a Constitution save with `cause: 'concentration'`, and a save-ends save the effect's ability with `cause: 'saveEnds'`: they are saves, so every rule about saves reaches them, and a rule about one cause can name it. A death save is a save tied to no ability: a rule about saving throws in general reaches it, a rule naming an ability does not.
- **`bonusFor`**: a save reads `save`, a death save `deathSave`, else 0. A check with no skill reads `check`, else `mod`. A listed skill with its usual ability (`SKILLS`, `shared/rules/skills.ts:23`) reads its bonus. With another ability it carries over what the skill adds, `mod(other) + skills[s] - mod(usual)`. An unlisted skill reads as a check of its ability. Initiative and attacks are null here: **`creatureBonus`** reads initiative as the actor's `initBonus`, or doc 2's `shapedInitiative(character, beast)` in Wild Shape with a stat block, and an attack's bonus is its `NamedRoll`'s.
- **`creatureNumbers`** follows what the creature has. A character, or a token of one, follows doc 2's rule (its 3.6): with an SRD shape on its actor (`srdId`), Wild Shape (`wildShape`) with a stat block gives doc 2's `shapedNumbers(character, beast)`, and Wild Shape without one, or another shape, the beast's own numbers from `srd`. With no shape it gives `pcRollNumbers`. A token's own actor goes to the block it links: `blockId` to `companionBlocks`, `monsterId` to `monsters`, `srdId` to `srd`. Anything else, or a source `sources` lacks, is null.
- **`blockRollNumbers`**: `mod` from each score, `floor((score - 10) / 2)`, `save` as printed, the skills line ("Perception +5, Stealth +4") read by name in any case, unknown names left out, and `spellDc` and `spellAttack` from the first entry named "Spellcasting…" among traits and actions. `pcRollNumbers` lists every skill with its whole bonus, so Jack of All Trades needs no rule here.
- **A request's context**: `testOf` reads doc 4's `RollRequest.spell` and `RollRequest.cause: 'saveEnds'`, which is public (the coordinator's decision 2 of round 2, doc 4 1.1), while the effect a save-ends request ends stays the DM's. No request asks a concentration save, so `cause: 'concentration'` comes only from doc 3's concentration card. So "against a spell" and the cause reach the player's card, the DM's Roll, a server row and the server's `fails` alike (W7-DATA-09).
- **One function on both sides.** The server calls `creatureBonus` over the room state when it resolves (4.2), and a client over its view to show the bonus. A player's view lacks `monsterId`, so where only that would give a bonus the card offers "Roll d20" and a typed bonus (section 7). The SRD table loads on the server at boot and on a client by `loadSrdRolls()` (doc 3).

### 6.2 Named rolls

```ts
type DamagePart = { formula: string,           // canonical, "1d6+2"
  type?: DamageType, optional?: true,          // optional: its clause goes on "if", "when" or "while"
  name?: string,                               // an optional part's own name: "Sneak Attack" (doc 2's riders)
  upcast?: string }                            // dice added per slot above `level` (doc 2)
type NamedRoll = { key: string, name: string,  // key: unique in its block, doc 3's section and name or doc 2's roll id
  section: 'traits' | 'actions' | 'bonusActions' | 'reactions' | 'legendaryActions' | 'spells',
  attack?: number,                             // the to-hit bonus, rolled as d20Formula(attack, mode)
  save?: { ability: AbilityKey, dc: number, onPass: 'half' | 'none' },
  damage: DamagePart[], heal?: { formula: string, upcast?: string },   // heal: applied as healing
  dice?: string,                               // a plain roll, neither damage nor healing: Bardic Inspiration's 1d8 (doc 2)
  recharge?: 2 | 3 | 4 | 5 | 6, uses?: string, // recharge: the lowest face that recharges. uses: "2/Day", as printed
  conditions?: ConditionKey[],                 // what a failed save gives, as the text names them
  critOn?: 18 | 19,                            // a weapon's wider critical range, sent as dice.roll's critOn (doc 2)
  saveEnds?: true,                        // "repeats the save at the end of each of its turns"
  lasts?: { at: 'start' | 'end', of: 'target' | 'self' },   // "until the end of its next turn" (target), "the dragon's next turn" (self)
  level?: number }                             // a spell's, 0 for a cantrip (doc 2)
// Made by doc 3's blockActions(view), doc 2's pcNamedRolls(character) and pcSlots(character, key)
```

- One shape for every creature, so one list renders monsters, companions and characters, and doc 3's fill table (its 5.6) reads conditions, save ends and duration from it (W7-P-22). Its formulas are canonical text that `parseFormula` accepts, or the part is left out. Each damage part keeps its type, so doc 3 rolls, halves and defends each part on its own.
- **The critical range**: an attack roll crits on a kept d20 at or above `critOn`, 20 unless its `NamedRoll` says 18 or 19, which doc 2 sets on a Champion's weapon rolls. Doc 3 sends it as `dice.roll`'s `critOn` (4.1), and `hitOf` reads it (5.6).
- `DAMAGE_TYPES` and `DamageType` move from `client/features/tokens/monsterFilters.ts:37-52` to `shared/rules/damage.ts`, which this file, doc 2's schema, doc 3's reader and the monster filters import.

## 7. The request card's Roll (contract for doc 4)

- **Always offered** on an answer that is not final (owner decision 2 of round 1): "Roll +5" when `creatureBonus(view, target, testOf(request, choice))` is a number, else "Roll d20" with a bonus the player types, sent as `bonus`. The server's own bonus wins wherever it knows one. The total and Send stay, as does "Fail without rolling". Doc 4 lays them out and keeps one answer path.
- **Advantage, disadvantage and extra** are the roller's for this roll: the card's sources (presets and chips) resolve by 3.3 into `mode`, and `extra` adds dice. The presets still decide nothing the roller cannot change.
- **Sends** `roll.dice { tag, rollId, target, choice, mode?, cancelled?, extra?, bonus? }` through `sendRoll` and shows its result in place (8.7), settled by its receipt (1.2). The target's `total`, `result`, `dice` and `fails` come in the `ev`. The card's own "Fail (Stunned)" is doc 4's, and a roll made anyway records Fail (4.2).
- **Refusals** read as the server words them (4.3, 4.4, 5.4). A closed request is `gone`, as today.
- **The DM** sends it for any target from the live card: with `unanswered` for a waiting one, and with `change` naming the ask's id to allow it (5.4). The card shows rolled and typed answers alike, `dice` telling them apart.

## 8. The Dice panel

### 8.1 Place

`panel({ id: "dice", title: "Dice", order: 15, group: "play", load: () => import("./dice/DicePanel.tsx") })`, for everyone, after Party and before Log (decided, 17.1). The tabs fit it as any panel: a row of three holds Token, Initiative and Dice, and Log moves into More with its badge. "Dice" is a few px wider than "Log", and DejaVu Sans left Log 8 px to spare (docs/design-v1-panel-tabs.md 3.2), so the build measures that font again. Where three do not fit, the row holds two. It takes either pane of a split and swipes as every phone panel sheet does.

### 8.2 The roller

Top to bottom, every row whole and none sideways but the dice:

- **The last result**, from the first roll on: one line that sticks to the scroller's top through `paneBodyPadding`, as Initiative's round header does. The newest panel roll: "Rolling…" under the shared delayed indicator while it waits, then its total, label, the dice as chips (dropped ones struck through, a natural 20 or 1 marked) and Again, which sends it once more as it was. A long line ends in an ellipsis and its tap opens the whole roll in Recent rolls. A refusal shows here with its reason, never as a toast (the dispatch option `quiet`, `client/state/types.ts:130`). A polite live region says "Rolled 13: Longsword."
- **The formula field and Roll.** A one-line input at 16 px, named "Dice formula", placeholder "1d20+5 or 2d6+3 fire", with no autocorrect, capitals or spell check, and a clear button while it holds text. Roll is disabled while the field is empty or the socket is not open, and busy while its roll waits.
- **The reading**, only while the field holds text: "2d6+3, fire: 5 to 15", or the error after a Roll that does not parse, as an alert, until the text changes. It is the field's description.
- **Quick dice**: d4, d6, d8, d10, d12, d20 and d100, 44 px buttons named "Add a d6", in one row that scrolls sideways where the panel is too narrow (the existing `ScrollStrip`). A tap adds that die to the field (`addDie`).
- **One-roll choices**, one row of three chips: Adv and Dis (named "Advantage" and "Disadvantage", at most one pressed), and Secret ("Hide from players" for a DM, "Only the DM sees it" for a player). It starts pressed only for a DM's roll for a monster, a creature no player plays (`startsSecret`, section 17): pressed while the DM's panel is opened for one, and not for a free formula with nothing such selected, a creature a player plays, or any player's roll. A tap that sends a panel roll takes them (8.4).

Opened for a creature (doc 3's bar Roll, or a new selection while it shows), the panel scrolls doc 3's options to just under the sticky line. Otherwise it opens at its top. Appendix C works the layout at 375 x 667 and 390 x 844, at 100% and 130%: the sticky line, the field and the start of the options are above the fold at each.

### 8.3 Recent rolls

Under doc 3's options, "Recent rolls" lists every `dice` line and every `roll` line with `dice` in the viewer's log, newest first (`recentRolls`). A row names the roller in their color, the creature and label, the total and the dice, with "Secret" on a secret line read in full, "Natural 20" or "Natural 1", "Hit", "Critical hit" or "Miss" against an AC, and what a request asked on a rolled answer. A line of several rolls lists each, folded after 5 behind "Show all 12". Lines with one roller and one `batch` are one row, for every viewer. One member's consecutive bare lines are one row too, "Mara rolled in secret 3 times." The viewer's own `dice` rows have Again ("Roll again: 2d6+3 Longsword"), an icon button at the end of the row's last roll line, and a row of one roll names its roller on that line, so it takes one or two lines. Its foot, "Older rolls are in the Log", opens the Log. With none: "No rolls yet. Type a formula or tap a die."

### 8.4 `useDicePanel` and doc 3's section

Between the roller and Recent rolls the panel renders `RollOptions` from `client/features/dice/RollOptions.tsx` (doc 3) with `PanelProps`. Any surface rolls through `useDicePanel()`: the one-roll choices live in a room-scoped store (`diceChoicesSlot`, read with `useScoped` as `barDockSlot` is, `client/state/scope.ts`), so a fight alert card or the tracker rolls whether the panel is mounted or not.

```ts
type PanelRoll = Omit<DiceRollInput, 'mode'> & { sources?: AdvantageSource[] }   // a roll's own sources, unresolved
type DicePanelApi = {
  adv: boolean, dis: boolean, secret: boolean,              // the one-roll choices as they stand
  take(): { sources: AdvantageSource[], secret: boolean }   // the choices as sources, reset at once
  roll(rolls: PanelRoll[], opts?: { dc?: number, ac?: number, to?: 'all' | 'dm' }): string | null }   // its tag, or null when not sent
```

- **A panel roll** (no `to`) calls `take()` the moment it is sent, so the choices belong to that roll alone: a second tap before the first answers gets the choices as they stand then, normally none, and a late answer never clears a choice pressed since. Each roll with one d20 resolves its own sources and the taken ones together (3.3). A roll with no d20 never gets them. The roll goes under the taken Secret. If nothing is sent or the roll is refused, the taken choices come back only while the choices still stand at their start, so a newer choice is never overwritten.
- **A roll with `to`** goes under that visibility with only its own sources, and neither takes nor shows the choices: a card or the tracker is not the panel. A flow that should honor them, such as doc 3's group save started from a tap, calls `take()` itself at that tap and passes them on.
- **`batchRolls`** (`shared/dice/batch.ts`, pure) checks every roll first, so one bad formula sends nothing. It then splits in order at the first of 20 rolls, 3 KiB serialized and 100 dice counted after each mode (advantage's d20 counts 2), every batch under one tag, each refused or rolled on its own. A single roll past a bound alone is refused before sending, in the bound's words. Doc 3 reads a group's results with `findRolls(view.log, tag)`, every line of the tag in order.

### 8.5 Others' rolls

A `dice` line from someone else that arrives with its numbers, after the page's first snapshot, shows a toast, one per `batch`: "Bree rolled 19 for Stealth.", or "Mara rolled 6 Dexterity saves." for several with one label, else "Mara rolled 6 times." A bare line shows none, nor does a `roll` line, which the DM's live card shows. None shows while the Dice panel is on screen. Room mounts `useRollToasts(diceShown)` beside `useLogUnread` (`client/pages/Room.tsx:385`). This device gains "Show others' rolls as they happen", on by default (`rvtt.rollToasts`).

### 8.6 History and keys

This device keeps the last 20 different texts rolled from the field, per room, newest first (`rvtt.diceHistory.<roomId>`, inside try and catch). Keys, the field's own, so the room's shortcuts stand aside as in every field:

| Key | Does | Who | Sheet section |
| --- | --- | --- | --- |
| Enter | Roll what the field holds | everyone, in the Dice panel's formula field | Dice, a new surface after Initiative |
| Up, Down | Go back through the formulas this device rolled, newest first, or forward again to what was being typed | everyone, in the formula field | Dice |

No other key is added or changed.

### 8.7 The result where the roller looks

One rule for every surface that rolls: the panel, doc 3's option rows, cards and any bar button that rolls, doc 4's card and the tracker:

1. The control that sent the roll is busy from the tap until the answer, and takes no second tap meanwhile. Other controls stay usable.
2. Its result, or the refusal, shows beside that control, at least the total and a natural 20 or 1, until a newer roll from it replaces it or the surface closes. In the Dice panel the newest panel roll is also the sticky line (8.2), so an option scrolled to the foot shows its result both on its row and at the top.
3. A roll whose surface closed before the answer shows its result as a toast.
4. `useReceipt(tag)` gives every surface the state of 1.2: `sending`, `committed` with its lines, `refused` with the reason, `checking` while it asks the lookup, or `unknown`. It is the one place that reads acks, refusals and the log for a tag.

## 9. Client names for docs 3 and 4

`client/features/dice/`: `DicePanel.tsx`, `Roller.tsx`, `RecentRolls.tsx`, `logic.ts` (`recentRolls`, `findRolls`, `collapseBare`, the history), `send.ts` (`sendRoll(actions, op)`, which sends nothing while the socket is not open), `useDicePanel.ts` (with `diceChoicesSlot`), `useReceipt.ts` and `useRollToasts.ts`. Shared: `shared/dice/formula.ts` (3.3 to 3.5), `shared/dice/batch.ts` (`batchRolls`), `shared/dice/roll.ts` (`rollFormula(formula, draw, mode?)`, `rolledTerms`, `keptFaces`, `naturalOf`, `hitOf`), `shared/dice/bonus.ts` (section 6), `diceText` and `rollToastText` (`shared/logText.ts`). Doc 4 sends `roll.dice` through `sendRoll`.

## 10. What this changes in other designs

- **docs/design.md**: 1's "No dice roller" becomes "Dice roll on the server (docs/design-v1-dice.md)". 2's determinism rule 2 names dice beside undo as resolved before the reducer, and auto initiative draws on the server too (doc 3 section 7). 6 gains 5.1's types. 7.2's step 5 resolves the dice ops after step 6 checks them (4.2). 7.3 gains 5.2. 7.4 lists them as waiting. 7.7: on no stack. 8.1 gains a Dice row. 9.11's "The app rolls nothing" gives way to 5.4 and 7. 10.3 gains the roll budget and the lookup's limit, 10.5 the dice rows. 10.8 gains `GET /api/rooms/:roomId/receipts/:tag`, and 16.1 the `roll_receipts` table (1.2). 14 gains the Dice panel. 16.4 gains 5.3. 17 records the project owner's answers.
- **docs/features.md:660**: "Dice roller" leaves Skipped, since rolls now happen in the app.
- **docs/design-v1-dm-tools.md 3.3**: rolled answers, changes and Roll (5.4, 7). Doc 4 owns the rest.
- **docs/design-v1-panel-tabs.md 3.2**: the row it measured becomes Token, Initiative and Dice, measured again with each font it names.
- **docs/design-v1-split-panel.md 3.5**: Dice joins "any two".
- **docs/design-v1-companion-stat-blocks.md**: a companion's block gives its bonuses through `blockRollNumbers`. Its model is unchanged.
- **client/features/encounter/autoRoll.ts** (doc 3's rewrite): its `Advantage` ("adv", "dis", "normal") gives way to `AdvantageMode` and none, and its `RollMode` (creature, each, all) keeps its name, as doc 3 says, since the dice mode is `AdvantageMode`, and no doc adds a `ShareMode` (W7-P-46, one naming in both docs).

## 11. Edge cases

| Case | Outcome |
| --- | --- |
| "10d4+1d8", "4d6dl1", "d%" | 11 dice, 11 to 72. 4d6kh3. 1d100 |
| "1d20+5 adv dis", or Hasted and Restrained on a Dex save, then Advantage pressed | normal, whatever order the sources came in |
| Offline, or "View as a player" | Roll disabled offline. The preview refuses every op (`client/features/dm/preview.ts:141-144`), so `sendRoll` reports it not sent |
| Socket drops after sending, or the roll commits and leaves the 200 entries before the device returns | resent once, rolled once. Its line is in the snapshot, or "Checking…" until the receipt answers. Never rolled again |
| The committed roll's line is pruned from the archive, or now hidden from the roller | the receipt still says committed, with no lines: "Rolled. Its result is no longer in the log." |
| A player's fresh-tag flood of `roll.answer`s naming no request, or of `actor.outcome`s (the DM's op) | each pays one token at admission, then permissions refuse it with a receipt. Out of budget, refused at admission with none. At 2,000 in a day the player is refused with no receipt, and the room keeps 8,000 for everyone else |
| A player's flood of new tags over budget, or new tags at the cap | each refused at admission: the watermark moves, no receipt, nothing drawn, and the receipt count stays as it was. One refusal lost on the way reads unknown |
| 10,000 receipts in a day, a restart, then the oldest outcome retried with its plan tag | the outcome is answered from its receipt, nothing applied twice. A new tagged op is refused until receipts pass 24 hours |
| A tag with no receipt (never reached the server, past 7 days, or another member's) | unknown: "This may have happened. Check the log." Nothing sends again until the user acts |
| An outcome retried with the same plan tag, or a roll's tag sent again by a new device | answered as its receipt: no second roll or change |
| Two option taps with Advantage pressed, before either answers. Advantage pressed again before the first lands | the first rolls with it, the second without. The new press stays when the first lands |
| A refused panel roll. A card's roll while Advantage is pressed | its choices come back only if untouched since. The card rolls as it gave it, and the choices stay |
| A player names a hidden token, or a visible one not theirs | `gone`, `forbidden`, both before any draw |
| A 21-roll op, one over 3 KiB, twenty 6d6 (120 dice), a group of 50 | `batchRolls` splits each, parts under one tag and one `batch`: one row and one toast for every viewer. A raw op past a bound is refused `invalid` |
| A secret roll for a goblin players see, or any roll for one hidden or unseen | "Mara rolled in secret.", or nothing |
| A group with some goblins unseen | players get the seen ones' rolls, or the bare line if secret |
| A player's secret free roll. A blackout | DMs (every co-DM too) and the roller read it, others the bare line. Free and character rolls reach players as chat does, token rolls neither then nor after |
| A token revealed later, or given to a player | its earlier unseen rolls stay out of others' logs. Its new owner gets them |
| A public `dc` or `ac`, a table display, a roller removed | players read it. No `dice` line. "Someone rolled …" |
| An attack with a kept 1 that meets the AC, a 19 with `critOn` 19 | miss, critical hit |
| `roll.dice` with no known bonus and none typed, or a range past -50 to 100 | `invalid`, with the words of 4.3 |
| A player's roll on any answer, by any of their devices | `invalid`, "It was answered meanwhile." A typed total after a roll: "Final. Ask the DM to change it." |
| The DM allows Bardic Inspiration on a rolled 12 against DC 15 | 1d8 rolled and added: 12 + 5 = 17, a pass, `previous` keeps 12, final again |
| Heroic Inspiration on a disadvantage roll of 1 and 18 with +1d4, on an advantage roll, or naming the Bless d4 | the 1 alone redrawn, the lower of it and 18 kept, the d4 kept. The dropped d20. The d4 alone |
| Halfling Luck naming a d20 that does not show 1. Lucky on a normal, a disadvantage, an advantage or a cancelled roll | refused, nothing drawn. One more d20, the higher kept. Normal on the first d20, nothing drawn. Refused. Refused |
| The player replaces or withdraws the ask while Allow travels, or two DM devices' Allow | "It was settled meanwhile.": the Allow names an id no longer pending, and nothing is drawn |
| A rolled Dexterity save for a Stunned creature, Stunned hidden from players or not | Fail with its total, "fails (Stunned)". Hidden: no `fails`, the DM marks Fail |
| The DM's `unanswered` Roll and the player's answer cross | whichever lands first stands |
| Stats edited between the card's "Roll +5" and the roll, or a typed bonus where the server knows one | the server's bonus, shown in the line |
| Two choices and no `choice`. The request closed while rolling. A stored formula a later grammar refuses | choice 0, as `roll.answer`. `gone`. It replays and shows its text and total |

## 12. Self-sweep

Swept as classes before reporting:

- **Secrecy**: every line shape (free, creature, group, mixed sight, secret, bare, request, attack) against every viewer (DM, co-DM, roller, owner, other player, display, behind a blackout). One rule decides a bare line. `batch` reaches others only on lines they read in full and hides the tag. The lookup returns only the caller's own lines, projected.
- **Determinism, ordering and replay**: randomness only in the resolve, stored in `sys.dice` with `batch`. The reducer reads no bonus, parses no text and draws nothing. `isFinal`'s new case and `change` read only `dice`, which no older op wrote. The wave's one version bump, `OP_VERSION` 7 and `SNAPSHOT_VERSION` 11, is doc 4's (doc 4 7.5, for answer provenance), and doc 1's rules gate on the same versions. Authorization comes before the resolve, so no refusal depends on dice or stats.
- **Advantage and choices**: W7-ASTRA-08 and W7-ASTRA-09 were early or late resolution of shared state. Sources now resolve once, at the op, and the panel's choices belong to the tap that took them.
- **Settlement** (rounds 2 to 4): every admitted op that rolls or applies has a tag and a receipt, kept for its whole 24 hours whatever the count. Admission charges every tagged op at least one token before its permissions and reserves the receipt's slot, its refusals (budget, cap, a player's share, read-only) leave none, and a player's share is 2,000, so neither refused traffic nor one player can spend the room's day, so whether it happened is never read from history, which pruning and projection can hide. Missing means unknown, never refused, and unknown never acts on its own. A duplicate tag is answered from its receipt. The change ask is named by id, so a stale Allow draws nothing, and a reroll names one face.
- **Bounds, feedback and connection**: the splitter checks all three op bounds, the dice after modes. Every rolling surface follows 8.7, and every pending state ends in committed, refused or unknown, through offline, a resend, an eviction, archive pruning, a hidden line and a reload.
- **Contracts**: section 1.1 lists every name docs 2 to 4 call that this round changed.

## 13. Tests

- **Unit** (`node:test`): `shared/dice/formula.test.ts`: every bound and row of section 11, canonical text, ranges, `applyMode`, `doubleDice`, `addDie`, U+2212, and `resolveAdvantage` over every mix of up to three sources in every order, typed words included. `batch.test.ts`: a split at exactly 20 rolls, 3 KiB and 100 dice, advantage counting 2, and one bad roll sending nothing. `roll.test.ts`: `rollFormula` with a scripted draw, `rerollFace`, `rerollable` (any face for Heroic Inspiration, a selected Bless d4 among them, only a d20 showing 1 for Halfling Luck), kept faces and ties, `naturalOf`, `hitOf` (a 1, a 19 under `critOn` 19), and `serverDraw` within 1 to sides. `bonus.test.ts`: `bonusFor` for each `D20Test` kind, `deathSave` read, a character in Wild Shape with and without a block and in another shape, a skill with another ability, `isSave`, `isCheck` and `abilityOf`, `blockRollNumbers` from a skills line and a Spellcasting entry, `testOf` reading `spell` and `cause`. `reducer/dice.test.ts`: lines, `seen` and `batch`, `roll.dice` with total, result, `dice`, `typedBonus` and `fails`, a reroll of one face (each default of `rerollFace`, a named Bless die, Halfling Luck's 1), Lucky on each kind of roll, an added die, a stale ask id, the player's waiting-target rule, finality, `actor.deathRoll`'s branch from the state then, and a stored `sys.dice` replaying to the same state. `permissions.test.ts`: 4.3 row by row. `project.test.ts`: 5.2 as a matrix of line shapes and viewers. `protocol.test.ts`: the op's bounds and the largest line under 4.5 KB. `logText.test.ts`: 5.5. Import and remap of `dice` lines. Client `dice/logic.test.ts`: `recentRolls`, `collapseBare`, rows and toasts grouped by `batch`, the history.
- **Integration** (`server/rooms/dice.itest.ts`): the pipeline order (a hidden creature answers `gone` without a draw), the budget, a resend rolling once, every stored op replaying with the protocol schema. Receipts: written in the batch's transaction for a commit and a refusal, a duplicate tag from a new client answered with no second draw (and `actor.outcome` applied once), a server restart keeping them, the lookup's three answers (own tags only, another member's unknown), a committed op whose log line was pruned from the archive (more than 10,000 lines since) still committed, a line now hidden from the roller still committed with no lines, the 7-day and 10,000 pruning never touching a receipt younger than 24 hours, the cap: fill it, restart the room, retry the oldest protected `actor.outcome` with its plan tag and see it answered from its receipt with nothing applied, and a new tagged op refused at the cap. Admission: floods of uniquely tagged ops from one player, of dice, of `roll.answer`s naming no request and of `actor.outcome`s, each charged `admissionCost` before its permissions, then refused with no receipt once the budget is out, at the player's 2,000 and at the room's cap, with the receipt counts checked per member and per room before and after a restart, and other members still admitted while one player is at their share, staged ops counted against the cap, a failed commit giving its slots back, a lost admission refusal reading unknown, and the lookup's limit.
- **Randomized**: `client/features/dice/flow.test.ts` runs many random sequences of panel rolls, `to` rolls, `take()`, choice taps, batches, refusals, acks, dropped sockets, resends, evictions, lookups and snapshots against a fake server with a scripted draw. Invariants: every batch of a tag is drawn once whatever is resent, a tag with no receipt is never sent again without a user action, no two sent rolls share a taken choice, a late answer never changes the choices, a refusal never overwrites a newer choice, the sticky line is always the newest panel roll, nothing rolls again while its result is unknown, and every pending roll ends in committed, refused or unknown.
- **e2e**: new `e2e/dice.e2e.ts`: a player rolls 2d6+3 and the DM's device shows the same dice, a DM's secret roll reads "rolled in secret" for the player, a roll survives a reconnect, Enter and Up in the field, two quick taps with Advantage, and at 375 x 667 at 100% and 130% the sticky line, the field and the options' start in view, then an option tapped at the sheet's foot with its result in view (doc 3 adds its rows). Touched: `e2e/paneltabs.e2e.ts`, whose measured row gains Dice. Run those two and `reach`.

## 14. Build plan

One builder, in this order, before docs 2 to 4 build on it:

1. `feat(dice): the formula grammar, advantage sources and the roll` (`shared/dice/formula.ts`, `roll.ts`, `batch.ts`, tests).
2. `feat(dice): rolls on the server` (protocol, model, `LIMITS`, `server/rooms/dice.ts` with `batch`, the actor's steps and budget, receipts with their table, duplicate rule and lookup route, the reducer, permissions, reads, projection and fan-out, the import schema, remap, `logText`).
3. `feat(rolls): roll a request's answer on the server` (`roll.dice` with the waiting-target rule, `bonus`, `unanswered`, `change` and `fails`, `shared/dice/bonus.ts` with the `D20Test` kinds, `testOf` over the request, `blockRollNumbers`, the spell numbers and `NamedRoll`, `DAMAGE_TYPES` moved to `shared/rules/damage.ts`, `isFinal`, `dice` on targets and lines). No button: doc 4 adds it.
4. `feat(ui): the dice panel` (registry, the sticky line, roller, Recent rolls, `diceChoicesSlot` and `useDicePanel` with `take` at the tap, `useReceipt`, the doc 3 slot as an empty section, history, keys and the sheet's Dice rows).
5. `feat(ui): others' rolls as toasts` (and the This device switch).
6. `test(e2e): dice`.
7. `docs: dice in the feature list and the design` (FEATURES.md, docs/design.md and docs/features.md per section 10).

## 15. FEATURES.md

- The opening paragraph: "There is no dice roller …" becomes "Dice roll on the server, so everyone sees the same result. Anyone can still roll real dice and type the total."
- A new "## Dice" section before "## Rolls", a bullet each for: the Dice panel and its formulas ("10d4+1d8", "4d6kh3", "1d20+5 Stealth adv") and quick dice. Adv, Dis and Secret, each for one roll, how advantage and disadvantage cancel, and what others see of a secret roll. The result at the top of the panel and beside whatever you tapped, Again and Recent rolls. Hits and critical hits against an AC. Others' rolls as toasts. The pause when rolling very fast, and that a roll needs a connection.
- "## Rolls": a player taps Roll for the server to roll, with their bonus or one they type, or types the total as before. A rolled answer is final, and the DM approves a reroll or an added die in one tap (doc 4 words the cards).
- "## This device": "Show others' rolls as they happen". "## Shortcuts": a "### Dice" table with 8.6's two rows.

## 16. Decided, for the project owner to overrule

- Secret and advantage are one-roll choices, taken by the tap that rolls.
- A secret roll shows other players a bare line only when the roll made public would have reached them. Table displays show no rolls. Others' rolls toast by default, with a switch in This device.
- The budget: 20 rolls then one every 2 s for a player, 100 then two a second for a DM.

## 17. Decided by the project owner (2026-10-17)

1. **Dice comes before Log among the tabs** (8.1).
2. **A request's rolled answer reaches only the DM and that creature's players**, as a typed answer does (5.2).
3. **A rolled answer is final for its player** (5.4). Round 1 added the DM's one-tap approval of a named reroll or an added die, and "Roll d20" with a typed bonus where no bonus is known (7).
4. **Only a DM's rolls for monsters start secret** (8.2). A free formula the DM types starts public, and one tap hides it. This overrules this doc's first default, "Every DM roll starts secret". A monster is a creature no player plays, and a roll for several creatures starts secret when any is one. The DM's death roll, concentration and save-ends rolls follow the same rule. The group save's switch still starts on, since it hides the monsters' rolls.

## Appendix A. Formula errors

| Bound | Error |
| --- | --- |
| 1 to 100 dice: a term's count at least 1, and 100 in the whole op, advantage's second d20 included | "A roll needs 1 to 100 dice, as 1d20+5." |
| 2 to 1,000 sides | "Dice have 2 to 1,000 sides." |
| numbers 0 to 1,000 | "Numbers go up to 1,000." |
| keep 1 to all of them, drop 1 to all but one | "Keep at least one die, and no more than you roll." |
| 20 terms | "At most 20 parts in one roll." |
| a sign at the end | "Add dice or a number after the last sign." |
| 100 characters of formula | "That roll is too long." |
| 20 rolls or 3 KiB in one op | "That is too much to roll at once. Roll fewer at a time." |
| anything else, a label first included | "Try 1d20+5 or 2d6+3 fire." |

## Appendix B. Sizes

Measured with `JSON.stringify` on entries of the 5.1 shape, UUID ids, `at` and `id` included: a typical line ("2d6+3 Longsword") 262 bytes, one roll of 100d1000 with a 60-character label 816, a line of 20 Dexterity saves with advantage for tokens 3,184, its `dice.roll` 2,510 and its `sys.dice` 3,807, a `dice.roll` of 20 rolls at the per-roll bounds 5,310 (past 3 KiB, so refused), and the longest whisper today (1,000 three-byte characters to 16 members of 64-character ids) 4,229. A group of 50 as one line would be about 12,500. `batch` adds 30 bytes to a line. A line adds to its op the faces (at most about 700 bytes), each roll's total and `seen` (about 30 bytes each), the envelope and at most 300 bytes of canonical text, and drops the `creature` wrappers, so a 3 KiB op makes a line of at most about 4.5 KB. A player's worst hour is about 1,800 rolls of 1.6 KB of rows each, about 3 MB, and a DM's 7,200, about 12 MB.

## Appendix C. The panel on a phone

Worked from the sheet's cap and the rows' sizes, not yet measured in a browser: the build's e2e shots at these sizes check them. The panel sheet's body is its drawn height less the 56 px header (docs/design-v1-sheet-swipe.md, appendix), with 4 px of padding on top and 16 px at the sides. Rows: the sticky line 40, the field 44, quick dice 44, the chips 44, each with an 8 px gap after it, so 176 before the options, and 24 more for the reading while the field holds text.

| Screen, size | Body (layout px) | Content width | Quick dice | Options in view at rest |
| --- | --- | --- | --- | --- |
| 375 x 667, 100% | 344 | 343 | d20 to d12, then d100 sideways | 164 px, their heading and two rows of buttons |
| 375 x 667, 130% | 252 | 256 | d20 to d10, then sideways | 72 px, their heading and one row |
| 390 x 844, 100% | 450 | 358 | one row | 270 px |
| 390 x 844, 130% | 334 | 268 | scrolls sideways | 154 px |

The quick dice lead with the d20, the die rolled most, so it is in view at every size (build round 1 measured d20 and d100 behind the strip's scroll at 375 x 667 at 130%, in the old order). The chips row (Adv, Dis, Secret) is about 190 px, one row at every size here. Opened for a creature, the options move up under the sticky line, so all of the body below it, 208 px at 375 x 667 at 130%, shows them.

## Appendix D. Worked examples

- "1d20+5 Stealth adv" parses to 1d20+5, label Stealth, one advantage source. Rolled with Dis pressed: two sources, a normal roll. Rolled alone: `2d20kh1+5`, drawn 14 and 7: "Bree rolled Stealth: 1d20+5 with advantage (14, 7 dropped) = 19."
- The DM rolls Dexterity saves, secret, DC 15, for Goblin 1, which the party sees, and Goblin 3, hidden. The DMs read both rolls. Every player reads "Mara rolled in secret.", since made public the line would have kept Goblin 1. Rolled for Goblin 3 alone, players get nothing.
- Bree's owl companion has a block with Dexterity save +3 and a request asks a Dexterity save, DC 13. The card shows "Roll +3". `roll.dice` resolves to 1d20+3, draws 9, total 12: the target gets `total: 12`, `result: 'fail'`, `dice`, and the DM and Bree read "Owl rolled 12 (1d20+3: 9) on a Dexterity saving throw against DC 13: fail." It is final for Bree. Bree asks for Bardic Inspiration's d8 (doc 4's `roll.change`), the DM's Allow sends `change` with the ask's id, the server draws 3: 15, a pass, `previous` keeps 12.
