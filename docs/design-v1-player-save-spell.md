# raccoon-vtt v1: a player's save spell

Status: draft 4, after design review rounds 1 to 3, whose decisions it takes (section 10). Code is cited from `main` at `06706b7c`, with known forms. It builds on docs/design-v1-roll-options.md ("doc 3": the group save, 5.1 to 5.10), docs/design-v1-roll-request.md ("doc 4": requests and `resultOf`), docs/design-v1-dice.md ("doc 1": tags, receipts and budgets), docs/design-v1-area-from-character.md (the From control) and docs/design-v1-dice-ui.md (4.4, a named row's line of controls). It redesigns none of them.

The project owner asked on 2026-10-18: "just to confirm spell save rolls are currently in the pipeline right?" A save spell's row already shows its DC ("Sacred Flame DC 14 DEX, 1d8 Radiant"), and the DM's group save fills from a placed area and its caster. The player's half is missing: a player who casts Fireball, Hold Person or Sacred Flame has no way to ask for the saves.

## 1. Summary

- **Ask for saves.** A player's save spell or save action gets **Ask for saves** where the DM's Group save stands on its row in the Dice panel. The player's own placed area gets it where the DM's Save and damage stands. Both open one short block under the spell's row: who it targets, its casting level, and **Roll 9d6 Fire and ask**.
- **Targets as the group save reads them**: the creatures a placed area catches, or the player's selection less the caster, live until the ask goes (doc 3 5.1).
- **The caster rolls the damage** on their own device, with their dice and the roll animation, in the tap that asks. The server copies that roll into the ask, and the DM's page takes it.
- **The DM** gets a card in the alerts column, "Thorn asks for saves: Fireball". Open starts the group save filled from the spell, the caster's DC, the casting level and the caster's roll. Everything there stays the DM's to change, and one Apply resolves it.
- **One stored ask.** A new room collection `casts`, two ops (`cast.ask`, `cast.close`), and an optional `cast` on `actor.outcome` that closes the ask in the same op. OP_VERSION and SNAPSHOT_VERSION move to 12 and 16 (5.7).
- **Nothing hidden leaks.** The ask names only an area of the player's or tokens the player sees, its end reads the same whatever the saves did, and only the DM and the caster's players receive it.

## 2. Today

- **The row.** `NamedRow` (`client/features/dice/RollOptions.tsx:580`) draws Group save for the DM alone (`:654`, `GroupSaveButton` at `:731-756`). A player's Sacred Flame row has Damage and nothing that reaches the DM.
- **The area.** Save and damage is the DM's alone, in the Areas panel (`areas/AreasPanel.tsx:115-119`) and in a picked area's row (`areas/AreaOptions.tsx:583-591`), through `openDamage` and `AreaSaveStart`. Place leaves the new area picked (`placeDraft`, `areas/store.ts:229-244`).
- **The group save** lives on one DM device (`groupSave/store.ts`, its draft in session storage, doc 3 5.10). `useStartGroupSave` (`groupSave/start.ts`) takes a source, a selection or an area, and a fill from `actionFill` or `areaFill` (`groupSave/fills.ts:74` and `:119`). Its Slot level refills through `areaFill` with the area's own caster (`GroupSave.tsx:372-378`). `othersDamage` (`GroupSave.tsx:960`) offers "Use Bree's 28 (Fireball damage)", the newest line labelled with the fill's name.
- **No player op asks the DM for anything but a changed roll.** `roll.ask`, `roll.close` and `actor.outcome` are the DM's (`shared/permissions.ts:411-417`). A player's `roll.change` rides on the DM's own request, and the DM's undo leaves it out (`server/rooms/undo.ts:84-90`). Ephemeral events are forwarded per scene and never stored (`shared/protocol.ts:1833`).

## 3. The flow

### 3.1 The player starts it

Two places open one block:

- **The spell's row** in the Dice panel, for the creature the player picked there (doc 3 4.1): **Ask for saves** on every row with a `save`, in the controls line where the DM's Group save stands (dice UI 4.4). A tap opens the block on the lines under it, as ReplaceConfirm takes a line today. Its targets are the selection, less the caster.
- **A placed area of the player's own** (its `ownerId`): **Ask for saves** in the picked area's row, in the DM's `damage` slot at its priority, and in the Areas panel's row. A tap opens the Dice panel on the area's caster when the caster is theirs, else on the creature the panel has picked. The block opens under that creature's row of the area's spell, found by name as `ownSpell` finds it (`fills.ts`), or alone at the top of its options when there is no such row (an SRD preset cast by a creature with no stat block). Its targets are the area. A preset with no save (`noSave`) reads **Ask the DM to apply**.

One block at a time, kept in the option store (`dice/optionState.ts`), so closing the sheet to select on the map keeps it. Opening it pins the panel's `picked` to its creature, so selecting targets never moves the panel off it.

```
Fireball  DC 15 DEX, half on a pass, 9d6 Fire
[Ask for saves] [Damage] [- Level 4 +]
  Dexterity save, DC 15, against Fireball at level 4
  In area (3): Goblin 1, Goblin 2, Thorn (ally)
  [Roll 9d6 Fire and ask] [Cancel]
  [Ask, the DM rolls]
```

- **The first line** is the player's own fill: `actionFill` or `areaFill` run on their own view, the functions the DM's page runs. So it gives their DC as their block gives it, or "The DM sets the DC" without one.
- **The caster** is the picked creature's token on this scene, resolved when the block opens and again at the tap, before anything is sent. Without one: "Thorn is not on this scene." So a token removed while the block is open disables Send.
- **Targets.** An area's list is its In area line (`inAreaEntries`), live as tokens and the area move. A selection's reads "Targets (2): Goblin 1, Goblin 2" and follows the selection: a tap on a token selects it, and Multi-select adds more (FEATURES.md, Several tokens at once). With none it reads "Select the creatures it targets on the map." and, for a spell with an area preset, offers **Place its area**: the Area tool with that spell picked, its draft starting from the saved choice (area from character 3.3). The placed area then asks as above.
- **The casting level.** Every leveled spell gets a level stepper, from its own level to 9, which sets the ask's `slot` and the card's words. The row's stepper is that stepper where the row has one (`pcSlots` scales its damage), and the block shows its own where the row has none, as for Hold Person. A cantrip or a save action has none.
- **Send.** With damage, **Roll 9d6 Fire and ask** rolls the damage as the row's Damage does (`damageRolls` with the row's riders, never critical, so the dice throw in the tray from the tapped button's place), then sends the ask naming that roll's tag and how many parts it went in, on the same socket and in that order. **Ask, the DM rolls** sends the ask alone. With no damage (Hold Person) there is one **Ask the DM**. Cancel closes the block. A recharge action is marked Used once its ask goes, as its Damage tap marks it.
- **A refused ask never rolls again.** When the ask is refused and its roll committed, the block keeps that roll's tag and total ("Rolled 31 Fire") and offers **Ask again**, a new ask naming the same roll.
- **Disabled, with the reason**: no target ("Select the creatures it targets"), no caster token (above), offline or a preview (doc 1's words, `ctx.blocked`), and three asks already waiting ("You have 3 asks waiting. Withdraw one first."), counted as the server counts them (5.4). An area's button with none of the player's creatures on the scene says "None of your creatures is on this scene.", the From control's words.

### 3.2 While it waits

- The block becomes one line under the row: "Asked the DM for saves. Waiting." with **Withdraw**. Every waiting ask of the player's also leads the Dice panel's options, named for its caster when that is not the picked creature, so it shows with the panel scrolled away from the row, and one whose caster has no chip (a lent token off the players' scene) can still be withdrawn. The picked area's line ends "Saves asked".
- A toast as it goes: "Asked the DM for saves against Fireball."
- Sending shows the button busy and refuses a second tap. The ask's id is its tag (5.3), so a resend after a dropped connection asks once. A lost answer is settled by its receipt (`useReceipt`). Unknown reads doc 1's "This may have happened. Check the log." and never sends again on its own. Session storage keeps an unsettled ask's id and its roll's tag (`rvtt.castAsk.<roomId>`, inside try and catch), as the group save keeps its draft, so a reload settles them by receipt.
- Once the DM rolls, every player whose creature it caught gets doc 4's card as from any group save, the caster's own player too when a Sphere catches the caster.
- When the closing `cast` line arrives, a toast: "The DM resolved Fireball." for an Apply and for a close with nothing to apply alike, or "The DM set Fireball aside." for a dismissal. The waiting line goes.

### 3.3 The DM

- **The card.** Each waiting ask is a card in the alerts column, above the live cards and in their look (`cardStyle`): "Thorn asks for saves: Fireball, level 4", then "Thorn rolled 31 Fire" or "No damage rolled", then "In the area: 4" (the DM's count, hidden creatures included) or "Targets: Goblin 1, Goblin 2", then **Open** and **Dismiss**. It names the caster by its token in view, else its character, else the asker. It opens on a computer and starts folded to its first line on a phone, as a live card with an ask does. The newest two asks show and the rest fold into the "Rolls" button and the summary, as DmDesk does for requests. An ask leads the dock's alerts summary over a sheet ("Thorn asks for saves"), as a player's ask to change a roll does (doc 4 6).
- **Open** starts the group save through `useStartGroupSave` with the ask as its source and fill (`castStart`). The source is the area (`{ kind: "area" }`, opened in the Areas panel as AreaSaveStart opens it, since that panel reads the caught creatures, and followed until the roll, doc 3 5.1) or the ask's tokens (`{ kind: "selection", tokenIds }`, not live, so the DM's own selection never moves them). The fill is `castFill(dice, cast, slot)`: `areaFill` with the ask's caster in place of the area's, or `actionFill` with the caster's roll at the slot (`pcSlots`), read from the DM's view and never from the ask. The page keeps the ask as `Page.cast`, so its Slot level stepper shows for every leveled spell, for an area and a targets ask alike, and refills through `castFill`. While the caster's block loads, Open reads "Reading Thorn's stat block…", as AreaSaveStart reads the area. A page that holds rolls asks "Discard the Dexterity save for 6?" first (ReplaceConfirm). An ask on another scene reads **Go to Crypt and open**, since the page needs its scene's tokens (doc 3 5.10).
- **The caster's roll** comes from the ask's server-written `rolled` (5.3), never from the log. Whenever it is there, `castFill` sets the damage field from its own formulas and types ("9d6 fire", or "9d6 fire + 2d8 radiant" with a rider of another type on), and `page.damage` starts committed under the roll's tag with its amounts. The parts then always match, so the page's "Rolled: 31 Fire" note, Roll again and a typed amount work as for the page's own roll, and the draft keeps the amounts through a reload. The fill's own formula is used only when `rolled` is absent, or when the field written from it would not read back part for part: `castFill` parses it with `parseParts` (`groupSave/outcome.ts:29`), and where the count differs from `rolled`'s it imports nothing and reads "Thorn's roll could not be read part by part. Roll it here or type it." A part's type comes only from its label, which `cutLabel` (`options.ts:315`) may cut on a long name, and an untyped part joins the part after it ("2d6 + 2d8" reads as one), so without this check totals of [7, 9] would keep only 7. The check is the simpler sound fix: it needs no new field and no type the server cannot check against a cut label, and it costs only a long-named roll with several types, which the DM then rolls. A lone untyped part takes the fill's type, as a typed "28" does. The seeded roll is marked `imported`, and `holdsRolls` (`groupSave/start.ts:11-13`) and `rolledAny` (`GroupSave.tsx:321`) leave it out until the DM rolls or the page sends anything, so opening an ask never asks to discard nothing. A slot change refills the formula from the fill and drops the imported roll, as a new formula would. The fill line reads "From Thorn's Fireball at level 4: Dexterity save, DC 15 (Thorn's spell save DC), 9d6 Fire, rolled 31 (Thorn's roll), half on a pass."
- **What the DM can change** is everything the page offers today: the rows (Skip, Fail, Pass, a typed total, Legendary Resistance), the area itself, which the rows follow until the roll, the DC, which re-judges at once, the damage, half or none on a pass, conditions with their end and the save that ends them, the casting level, and What players see. Nothing in the ask binds the DM.
- **Apply** sends today's `actor.outcome` with `cast`, which closes the ask in the same op. Where nothing would change (Hold Person, and every creature passed), the foot's "Nothing to apply" becomes **Close the ask**: `roll.close` of the page's open requests, then `cast.close { end: "done" }`, and the page settles as Applied does. **Discard** leaves the ask waiting and its card back. **Dismiss** sends `cast.close { end: "dismissed" }` in one tap. It is final, as Keep is (5.6).
- **An ask that closes under the page.** The page keeps `cast` until it reads the end from the closing line in the view. "Thorn withdrew the ask." or "Another DM set it aside." drops `cast`, and Apply works as a plain group save. "Resolved on another device." disables Apply with that reason. An end the page cannot read, its line pruned from the log (`MAX_LOG`, `shared/reducer/tx.ts:200`) while the device was away, disables Apply with "This ask was closed. Check the log." Discard is the way out of both. So a page never applies an ask twice. The end stays in the log, not in the room's state: keeping closed asks would need a pruning rule of its own, and an end the page cannot read only costs a Discard.

### 3.4 What players see after Apply

As doc 3 5.9: their own creatures' cards, which Apply closes, the monsters' rolls as the secret switch says ("Mara rolled in secret." by default), the caster's damage roll as its own Secret setting says, and the HP and condition lines of creatures they can see, under each creature's HP visibility. The caster's players also get the closing toast. Nobody gets the results list, the overrides or who resisted.

### 3.5 Hidden creatures and the DC

- **Targets the player cannot see never enter the ask.** The block lists what the player's view holds. The server refuses a named token the player cannot see as `gone`, in a missing one's words (as `diceRollCheck` does), so a refusal never says a hidden creature is there.
- **An area catches what it catches.** The ask names the area, not a list, and the DM's page catches every creature in it, hidden ones included, as Fireball does. The DM's card counts them. The caster's view never does.
- **The end reads the same** for an Apply and for a close with nothing to change (`end: "done"`), and the `cast` line goes first in its op, so its `<seq>:<index>` id never counts HP lines the caster cannot see. The caster never learns from the close that a hidden creature failed.
- **The caster knows their own DC** from their own stat block, as the row already shows. Others learn it only as today: on their own creature's card while "Players see the DC" is on, and on the monsters' lines in the open under the same switch. A save-ends or Concentration roll in the open never shows it (FEATURES.md, The group save).
- The ask and its log lines reach the DM and the caster's players alone (5.5).

## 4. Who rolls

- **Monsters**: the DM's page, on the server, hidden from players by default (doc 3 5.2, Server rows).
- **Other players' creatures**, and the caster's own when caught: asked, as the group save asks them now (Ask rows, doc 4's card, the DM's waiting Roll one tap away).
- **The damage, on the caster's device.** The caster rolls it in the Dice panel in the tap that asks, with their own dice set and the 1 s throw, and the DM's page takes the total. The rules roll a save spell's damage once for every target, as the page already does (doc 3 5.4), and the roll is the server's either way, so who taps changes nothing the rules or fairness care about. Players expect to roll their own spell's dice, and the roll animation throws only a roll tapped in the Dice panel (docs/design-v1-roll-animation.md 3.1), never one in the DM's page. The DM keeps the last word: Roll again on the page replaces it, and a typed amount wins.
- **The other way, in the DM's group save**, keeps the damage unseen until Apply, but the caster watches someone else roll their Fireball and sees no throw. The block keeps it as **Ask, the DM rolls**, for a table that prefers it.

## 5. Data and protocol

### 5.1 Why a stored ask

- **An ephemeral message** reaches only the DM sockets online then, on that scene, and is gone after a reload. A DM who reconnects never sees it, and two DM devices cannot agree it was handled.
- **A log line alone** has no open or closed state, so the cards would need bookkeeping on each device, which two DM devices would not share.
- **A field on the area** covers area spells only, and `template.update` reaches every player who sees the area.
- **A stored ask** survives reloads and an offline DM, closes once for every device, carries a receipt, and projects per viewer as a roll request does. It costs one collection, two ops and a version bump.

### 5.2 Model (`shared/model.ts`)

```ts
type CastId = string
/** A player's ask for saves against their creature's spell or save action. Open until the DM resolves or dismisses it, or a player of its caster withdraws it. */
type CastAsk = {
  id: CastId; rev: number  // the id is also the ask's receipt tag (5.3)
  by: MemberId              // the asker
  caster: TokenId           // a creature the asker owns
  sceneId: SceneId          // the players' scene when asked, the caster's and the area's
  spell: string             // 1 to 60 characters, the name the row or the area shows
  roll?: string             // with targets: the NamedRoll key on the caster's block, read on the DM's device
  slot?: number             // 1 to 9, the casting level
  area?: TemplateId         // exactly one of area and targets
  targets?: TokenId[]       // 1 to 50, tokens the asker saw
  damage?: { tag: string; parts: number }  // the caster's damage roll: its tag, and the batches it went in (1 to diceBatchesPerTag)
  rolled?: { formula: string; total: number; type?: DamageType }[]  // written by the reducer from that roll's line
  at: string                // the envelope time
}
RoomState.casts: Record<CastId, CastAsk>   // open asks only, as `rolls` holds open requests
LogEvent | { type: "cast"; castId: CastId; tokenId: TokenId; spell: string; slot?: number; end?: "done" | "dismissed" | "withdrawn" }
```

The ask holds references, never numbers the DM trusts, except `rolled`, which only the reducer writes from a line the server rolled: the DC, the dice and the conditions come from the DM's view of the caster's block. `spell` is display text, bounded as a stat block roll's name.

### 5.3 Ops (`shared/protocol.ts`)

```ts
op("cast.ask", { cast: castInput })                 // castInput: CastAsk less rev, by, at and rolled. One of area and targets, refined
op("cast.close", { castId: id, end: z.enum(["done", "dismissed", "withdrawn"]) })
op("actor.outcome", { ...today, cast: id.optional() })   // closes the ask with end "done"
```

- **The id is the tag.** `tagOf` (`server/rooms/receipts.ts:46`) returns `cast.id` for `cast.ask`, as it returns `plan` for an outcome, so the ask is admitted under the member's roll budget and the day's receipt caps, and the same ask sent again returns its receipt instead of asking twice. One id per tap needs no second field.
- **The reducer** (`shared/reducer/casts.ts`, new) adds the ask with `by` and `at` from the envelope and writes its `cast` line, first in the op. It fills `rolled` from every `dice` line in the log with `damage.tag`, in `part` order, a line with no `part` read as part 0 (`batch.ts:59-60`, as `receipts.ts:49` reads it), only when the lines hold parts 0 to `damage.parts` less one, each once, and none at or past `damage.parts`, since `batchRolls` (`shared/dice/batch.ts:23`) splits a roll past 100 dice into parts under one tag (`60d6 Fire + 60d6 Cold` is two). Every line's roller is the asker, every roll names the caster (by its token or its character), and none is critical (`crit`) or a d20 test: a roll with `critOn`, `save`, `initiative` or `mode` set, or whose formula holds a d20 term, since a plain check carries none of the four (`critOn` is optional, `options.ts:85`, and a normal roll has no mode, `formula.ts:321`). Each part's type is its label's last clause where that names a damage type, as `othersDamage` reads it. The roll goes first on the same socket, so its lines are in the log when the ask applies, and replay reads the same log. An incomplete batch, or any line failing a check, leaves `rolled` absent, as a pruned roll does, and the DM rolls. `cast.close`, and `actor.outcome` with `cast`, remove the ask and write the line with its end, first in the op.
- **One outcome, one settlement.** An `actor.outcome` carries `cast` or traps' `trap` (docs/design-v1-traps.md 6.2), never both, refined in the schema, so the traps build takes this shape.

### 5.4 Permissions (`canApply`)

- **`cast.ask`**, players only. The DM's is refused: "The DM runs a group save directly." The caster exists and is a token the asker sees and owns (`ownsToken`), on the players' scene, which `sceneId` names, so nothing goes during a pause, as `template.create` refuses then. An `area` is a template the asker sees and owns, on that scene. Each of `targets` is a token the asker sees on that scene, else `gone`, and none repeats. A `cast.id` that `casts` already holds is `gone`, as `template.create` refuses a taken id (`permissions.ts:585`). A `damage.tag` that another open ask names is refused: "That roll already went with another ask." The cap of 3 counts the member's open asks whose caster exists and they own now, on the server and in the block alike ("You have 3 asks waiting. Withdraw one first."), and the room holds 20 (`checkLimits`, beside `openRollsPerRoom`).
- **`cast.close`**: the DM's with `done` or `dismissed`. A player's with `withdrawn` only, on an ask whose caster they own now. It joins the ops a room at its storage quota still takes (`DELETIONS`, `server/rooms/actor.ts:193`), so Withdraw and Dismiss work there too.
- **`actor.outcome` with `cast`**: the ask must be there, else `gone` with "Thorn's ask was closed meanwhile." So two DM devices that both opened one ask apply it once.
- **An asked area is locked for its player.** While a waiting ask names it, `canEdit` (`areas/store.ts:132`) is false for its owner, with "Saves asked. Withdraw to change it.": no drag, size, aim or Delete. The server refuses its owner's `template.update` and `template.delete` the same way, as the backstop. So the player cannot change what the DM is resolving. The page's rows still follow the area until its roll: the DM may move it, and an area attached to its caster follows the token. Both halves are permission rules, so replay is untouched.

### 5.5 Projection (`shared/project.ts`)

- The DM: every ask and every `cast` line.
- A player: an ask whose caster they own now, with `targets` cut to the tokens they see now, `area` cut when they cannot see it, and `damage` and `rolled` only for its asker, since a Secret roll's totals reach only its roller and the DM (the Secret chip, `client/features/dice/Roller.tsx:386`). None during a pause. A `cast` line under the same rule. No one else receives either, a table display included.
- `dependents` re-projects an ask when its caster or a target is touched, as it does for a roll request's creatures (`project.ts:1722`), and when its `area` is among the touched templates, as an area's reminder line follows its area (`project.ts:1744`).

### 5.6 Undo, replay and limits

- **No `cast.close` goes on an undo stack** (`UndoStacks.records`, `server/rooms/undo.ts:89`, beside `roll.change` at `:91`). A Dismiss answers the player, so its undo would bring back an ask the player was told was set aside, the reason Keep stands (`undo.ts:84-90`). A withdraw is the player's own. `cast.ask` goes on no stack either (`onPlayerUndoStack`). `describeOp` (`server/rooms/undoLabels.ts:21`) has no default, so both ops get cases there all the same.
- **Undo of the Apply** takes the outcome back whole, the ask with its `rolled` included, so the card shows again and the caster's waiting line comes back, with no toast.
- **Replay**: no op stored before this build names a cast, and an `actor.outcome` without `cast` applies as before, so the reducer needs no `opVersion` gate. `rolled` reads the log the op met, which replay rebuilds the same. `shared/reads.ts` makes `cast.ask` wait for the server, as a roll does, since it reads the log.
- **Rates**: the tag charges the player's roll budget one token per ask ("You are going too fast. Wait a few seconds."), the caps of 3 and 20 bound what waits, and every ask a withdraw frees was charged.
- **Size**: an ask is under 1 KiB, and at most 20 wait. `sizeGuard.ts` counts `casts` at `ROOM_LEVEL`.

### 5.7 Versions, export and import

By design 16.2's rule and `shared/migrate.ts` practice, a new room collection and new op fields, which an older build's strict schemas refuse, move both numbers. Known forms took 11 and 15, now on main. This takes **12 and 16**: SNAPSHOT_VERSION's step adds `casts: {}` to a room without it, as step 7 to 8 added `rolls`, and OP_VERSION's step is an identity step. It builds before movement, since it touches none of the movement contract the Later three share and the project owner asked after it. Movement, attach and traps each take "the next free pair at build time" (docs/design-v1-movement.md 248, docs/design-v1-attach.md 8.6, docs/design-v1-traps.md 6.6), so they become 13 and 17, 14 and 18, then 15 and 19, with no edit to their notes. Nothing here depends on the number: if movement builds first, this takes the pair after it. Deploy: back up the database just before. Going back is the backup's restore (README, Updating).

The import schema (`server/rooms/stateSchema.ts`) takes `casts` and the `cast` line. An import drops open asks, as it drops open requests (`server/rooms/remap.ts:204`, doc 4 7.5), since they belong to a moment of play, and keeps their lines, whose `tokenId` remap's event switch maps.

## 6. UI

- **Phones first, 390 x 844.** The Dice panel is the bottom sheet. The block is three lines and its 44 px buttons under the spell's row, with the dice UI's spacing (3.1) and no fold of its own. Its buttons wrap as units where a line is full (3.3), as the sketch in 3.1 shows at 390 px. The picked area's Ask for saves takes the DM's `damage` slot and priority, so a player's picked row never holds more than the DM's, whose fit the tool options tests already cover.
- **The DM's card** at 390 px folds to "Thorn asks for saves: Fireball" with its chevron, and opens to its lines, with Open and Dismiss on one line.
- **Words** follow the SRD's capitals (FEATURES.md, Look and accessibility): "DC 15 DEX", "Dexterity save", "9d6 Fire", "half on a pass". Sentence case everywhere else.
- **Loading**: the busy Send and Withdraw, the receipt's "Checking…", and "Reading Thorn's stat block…" on Open, each behind the shared indicator's 200 ms delay. Every slow path ends in a result or a plain error.
- **Accessibility**: the block is a group named "Ask for saves: Fireball", its targets line is `aria-live="polite"`, focus goes to its first button when it opens and back to Ask for saves when it closes. The card's buttons name the ask: "Open the group save for Thorn's Fireball", "Dismiss Thorn's Fireball".
- **The token panel** is unchanged: Roll in a token's action bar already opens the Dice panel on the creature's options (doc 3 4.5), where the block lives.
- **Keys**: none new and no gesture changes, so the shortcut sheet stays as it is.

## 7. Edge cases

| Case | What happens |
|---|---|
| The caster is caught (a Sphere on itself) | Its row is Ask, so its player gets a card like anyone's |
| A target is hidden after the ask | The caster's projection drops it. The DM's page still has it |
| The ask closes while a DM's page holds it | As 3.3: a withdrawal or a dismissal frees Apply, a resolve elsewhere or an end the page cannot read disables it |
| Two DM devices tap Apply on one ask at once | The server applies the first. The second is refused and reads as the row above |
| The area or the caster is deleted | The card reads "Its area is gone" with Dismiss. An ask whose caster is gone leaves its players' view |
| The ask's scene is deleted | The card reads "Its scene is gone" with Dismiss |
| The DM moves the players to another scene | The ask waits. Open goes to its scene, where players' rows read Type, since a request needs the players' scene (doc 3 5.2) |
| The asker leaves the room | The ask stays the DM's, and reaches whoever owns the caster now |
| The caster's block has no roll of that key | The page fills from the area's preset, else opens on Dexterity with no DC, as an area without a preset does |
| The roll was someone else's, refused, critical, pruned or missing a part | `rolled` stays absent, and the page offers Roll and today's "Use Bree's 28" |
| The DM is offline | The ask waits, and the card shows on the next connect |
| Paused | No ask goes, and the caster's players hold none |
| A lent monster's save action | It asks as a spell does, under the action's name, with no level stepper |

## 8. Tests

- **Unit, shared**: `protocol.test.ts` (one of area and targets, the bounds, the three ends, `cast` and `trap` never both). `permissions.cast.test.ts` (owner and co-owner, another player, the DM refused, a hidden caster and a hidden target `gone` in a missing one's words, an area not theirs, another scene, paused, a roll another ask holds, a taken `cast.id`, the cap of 3 counting only asks whose caster the member owns now, the cap of 20, a withdraw by an owner only, a dismissal by the DM, the outcome on a closed ask, the asked area locked for its owner and not for the DM). `reducer/casts.test.ts` (ask, close, an outcome closing it, the inverses, the line first in each op, `rolled` copied for the asker's roll of the caster, an ordinary single-batch roll with no `part`, a two-part batch (`60d6 Fire + 60d6 Cold`) copied whole, a line past `damage.parts` refused, and `rolled` left absent for another roller, another creature, a critical, a d20 test, a missing part and a pruned line). `project.cast.test.ts` (a matrix of the DM, the asker, a co-owner, another player, a display, paused, a target hidden after, an area the viewer cannot see, `damage` and `rolled` for the asker only, a Secret roll's `rolled` absent for a co-owner, `dependents` with the area hidden, revealed and deleted checked against a fresh projection, and the caster's closing line and its id identical across outcomes that differ only in hidden creatures). `project.test.ts`: `randomState` and `randomOp` (`shared/testutil.ts`) carry asks and the cast ops, with Secret damage lines among them, and `assertNoLeaks` checks an ask and its lines reach only the DM and the caster's owners, with only targets the viewer sees and `rolled` for its asker alone. `migrate.test.ts` (both steps). `stateSchema.test.ts` (an import with asks). `undoLabels.test.ts` (both cases).
- **Unit, server**: `actor.test.ts` (Withdraw and Dismiss in a room at its quota), `undo.test.ts` (`cast.close` on no stack, the Apply's undo bringing the ask back), `remap.test.ts` (asks dropped, lines kept and mapped), `sizeGuard.test.ts`.
- **Unit, client**: `dice/cast/cast.test.ts` (targets from an area and from the selection less the caster, the caster token resolved and a token removed while open, `picked` pinned, the level stepper for Hold Person, the button words, the disabled reasons and the cap, the ops built in order). `dice/cast/castStart.test.ts` (an area ask and a targets ask to their source and fill with the ask's caster, Hold Person at level 3, `rolled` setting the field and seeded as committed, with Roll again and a typed override, a rider of another damage type on, a 60-character action name whose types the label lost and several untyped parts importing nothing, the seeded roll left out of `holdsRolls` and `rolledAny`, a slot change dropping the roll, the draft keeping the amounts). `groupSave/plan.test.ts` (the plan carries `cast`). `dice/cast/cast.random.test.ts`, by the state machine rule, over random taps, sends, receipts (committed, refused, unknown, late), withdraws, closes from the DM, reloads and reconnects. Its invariants: one tap asks at most once, a refused ask never rolls again, nothing is sent after Cancel or Withdraw, the waiting line shows exactly while an ask is in view or a send is unsettled, and an unknown never resends on its own. `groupSave/chain.random.test.ts` gains Open, Discard, Dismiss, Close the ask, a close under the page with its line kept or pruned, a reconnect and a refused outcome. Its invariants: an ask closes only through Apply, Close the ask, Dismiss or Withdraw, after Close the ask neither the ask nor the page's requests remain, and a page never applies an ask that was resolved or whose end it cannot read.
- **Integration**: `server/rooms/projection.itest.ts` (a player's ask over the socket reaches the DM and the asker and not another player, and the same ask sent twice asks once), and `server/http/export.itest.ts` (an import drops the asks and keeps their lines).
- **e2e**, a new `e2e/savespell.e2e.ts`, a DM and a player on phones at 390 x 844, Thorn with Fireball and Hold Person on its block, two goblins (one hidden) and Bree. `ss-1`: Thorn's player places Fireball and taps the area's Ask for saves, and the block lists the visible goblin and Bree (shot). `ss-2`: Roll 9d6 Fire and ask throws the dice, and the waiting line shows. `ss-3`: the DM's card and Open, the page filled with Thorn's DC and roll and a row for the hidden goblin (shot). `ss-4`: Roll, Bree's player answers, Apply, then the HP lines, the toast, and the waiting line gone. `ss-5`: Hold Person at level 3 from the row with two goblins selected, then Dismiss and its toast. `ss-6`: the asked area offers its player no move, size or Delete. Then nothing went wrong in the browsers. The build runs it, `groupsave.e2e.ts`, `areas.e2e.ts`, `rolls.e2e.ts` and `dmphone.e2e.ts` (pages and alerts it touches), `options-player.e2e.ts` (the picked row) and `reach`.

## 9. Build plan

Start from `main`, which holds known forms and its changes to `shared/model.ts`, `protocol.ts`, `migrate.ts`, `permissions.ts`, `server/rooms/stateSchema.ts` and `undoLabels.ts`.

1. `feat(casts): a player's ask for saves in the room's state`: `shared/model.ts`, `initial.ts`, `protocol.ts`, `limits.ts`, `keys.ts`, `reads.ts`, `reducer.ts`, `reducer/casts.ts` (new), `reducer/outcome.ts`, `permissions.ts` (with the asked area's lock), `project.ts`, `logText.ts`, `migrate.ts` (12 and 16), `testutil.ts`, `server/rooms/receipts.ts` (`tagOf`), `actor.ts` (`DELETIONS`), `undo.ts` (`records`), `undoLabels.ts` (`describeOp`), `remap.ts`, `sizeGuard.ts`, `stateSchema.ts`, and their tests.
2. `feat(dice): a player asks the DM for saves from a spell's row or their area`: `client/features/dice/cast/` (new: `CastBlock.tsx`, `cast.ts`, the waiting line, the session draft and the closing toasts) and its tests, `dice/RollOptions.tsx` (the button, the block, the waiting line), `dice/optionState.ts` (the block and `picked`), `areas/AreaOptions.tsx`, `areas/AreasPanel.tsx` and `areas/store.ts` (the area's button and `canEdit`).
3. `feat(dice): the DM's card for an ask and the group save it opens`: `dice/cast/CastCard.tsx`, `dice/cast/castStart.ts` (`castFill`), `rolls/DmDesk.tsx` (the cards, the newest two and the summary), `groupSave/chain.ts` (`Page.cast`, the imported roll), `plan.ts`, `start.ts` (`holdsRolls`), `fills.ts` (`actionFill` at a slot), `GroupSave.tsx` (the stepper through `castFill`, the seeded roll and `rolledAny`, Close the ask, the close and refusal words), and their tests.
4. `test(e2e): a player's save spell from an area and a row`: `e2e/savespell.e2e.ts`.
5. `docs: a player's save spell in the feature list, the dm guide and the design`: FEATURES.md (Areas' Save and damage, Dice's Roll options and The group save), docs/dm-guide.md (the group save and the areas parts), docs/features.md, and docs/design.md (section 6's state, 16.2's Versioning paragraph).

**Shared with other lanes.** Traps (docs/design-v1-traps.md) meets this on `actor.outcome`, whose `trap` it adds beside `cast` under the one-settlement refine (5.3), and on DmDesk, where both add cards: whichever builds second rebases its cards onto the other's. The look pass (docs/design-v1-look-pass.md 4) changes no op and no stored data, and none of its lanes owns a file this changes: lane 7 edits `encounter/InitiativeStrip.tsx`, which this leaves alone since the cards live inside DmDesk, lane 5 owns `rolls/RequestSheet.tsx`, and lane 8 `measure/controls.tsx`, which this only uses. The one meeting point is FEATURES.md and docs/dm-guide.md, whose Dice parts both edit: this lane's step 5 lands after the look pass's docs commit, or rebases on it.

## 10. Decided by the coordinator (2026-10-18)

Asking is off, so the coordinator took the recommendations and round 1's dispositions:

1. The caster rolls the damage on their own device, with **Ask, the DM rolls** beside it (section 4).
2. Other players do not learn of an ask (5.5).
3. The DM's card opens the setup and never rolls at once (3.3).
4. An asked area is locked for its player until the DM resolves it, with a client half and a server backstop (5.4).
5. Single-target conditions (Hold Person's Paralyzed) from an SRD table come later, as their own item.
6. Dismiss is final, as Keep is, and an import drops open asks (5.6, 5.7).
7. Versions 12 and 16, before movement, attach and traps (5.7).
