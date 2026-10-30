# raccoon-vtt v1: Undo during play and reopening a save

Status: proposed, 2026-10-29. Design only. Code checked at `cdecf8b8cc69eded887480c38aa71fbf8ef6215c`. Batch 39 owns op version 33. This change takes op version 34 and snapshot version 30, subject to the coordinator's landing order. Nothing described below has been built or tested yet.

This extends [the core design](design.md), section 7.7, [group saves](design-v1-roll-options.md), section 5, [player save spells](design-v1-player-save-spell.md), [combat controls](design-v1-combat-controls.md), and [re-sync](design-v1-resync.md). Those notes' Undo rules change only where this one says so.

## 1. The owner's words and the boundary

The project owner's notes of 2026-10-29:

- "undoing damage applied from save in the dice panel should revert the dice panel state back to the state prior to the damage being applied and allow DM to re-roll the save/modify DC. just once the damage/effects are applied that panel is unchangable"
- "review of what undo should and should not do. for example, undoing a stat block modification is a bit weird. just general pass to ensure this doesn't result in accidentally undoing stat changes without players noticing. obviously damage and movement should be part of this but the line is blurry so I want you to figure out where that line should be"

**Ordinary Undo takes back a table action or a direct board edit. Setup Undo takes back a saved definition or configuration.** Damage, movement, conditions, turns, shapes, doors, fog and building on the board stay in ordinary Undo. Stat blocks, character sheets, saved encounters, scene configuration and room settings leave it. The same operation has the same scope during a fight and during preparation. Starting a fight does not change the meaning of Undo.

Direct board editing is the deliberate exception to "play versus setup": painting a floor or erasing a wall needs the same immediate correction as drawing or moving a token. Saving a creature's abilities changes what future actions mean. It belongs in a history the DM deliberately opens. Labels and advance feedback make the distinction visible.

Setup keeps a separate, guarded Undo and Redo for the DM. It is not a backup or a revision browser. Players retain today's move, resize and drawing stack, plus specific correction controls such as Restore and the re-sync dialog's Undo. No new player permission to restore a character or a monster is introduced.

## 2. Today's implementation, and the complete inventory

`server/rooms/actor.ts` records an op only when `UndoStacks.records` accepts it **and** the reducer returned an inverse. `server/rooms/undo.ts` accepts every DM op except `sys.*`, `roll.change`, `cast.close` and thumbnail-only `scene.update`. `shared/reducer/tx.ts` excludes log entries and bookkeeping from inverses. Consequently a phrase in `undoLabels.ts` does not prove that an op enters a stack.

Stacks belong to a member, shared by that member's devices, with 50 entries per direction in server memory. Restarting or unloading the room loses them. Only the resolved `sys.restore` is durable. Guards prevent replacing values changed since, dependencies prevent stranded references, and an oversized inverse clears the affected history rather than reaching past the action. Gesture merging is consecutive and guarded.

The tables list every client op family in `shared/protocol.ts` at the checked commit. **D** means today's DM stack when there is an inverse. **P** means today's player stack, subject to permissions. **Play**, **Setup** and **None** are the proposed DM destinations. A wildcard below expands only to the suffixes explicitly listed.

| Family and ops | Today | Proposed and reason |
| --- | --- | --- |
| `token.move`, `token.moveMany`, `token.countLeg`, `token.attach`, `token.detach` | D, P | Play. Position, counted distance and carrying are table actions. Keep pose guards, route checks and silent passengers for players |
| `token.update`, `token.updateMany` | D. P only `token.update` satisfying `isPoseOp` or `isResizeOp` | Split by fields, section 3. A resize or reveal is play. Renaming a token or changing ownership is setup |
| `token.create`, `token.delete`, `token.deleteMany` | D | Play. Placing, duplicating or removing a piece on the board should be immediately reversible, including placing a saved encounter |
| `actor.hp` | D | Play for damage, healing, current HP and temporary HP. Setup when a Set includes maximum HP. Maximum HP defines the creature, even when changing it clamps current HP |
| `actor.damageMany`, `actor.deathSave`, `actor.life`, `actor.rest` | D | Play. Hits, death marks, reviving and rests are events. Preserve their whole atomic result |
| `actor.effect.add`, `actor.effect.update`, `actor.effect.remove`, `actor.effects`, `actor.saveDue` | D | Play. Conditions, counters, concentration, durations and settling a save belong to the current situation |
| `actor.use`, `actor.prompt` | D | Play. Spending, restoring, skipping and reopening uses or prompts correct a table action. Players use Restore or Reopen, not an expanded Undo |
| `actor.outcome` | D | Play. All targets, damage, effects, Resistance and the ask or trap it settles are one outcome. Its exact Undo reopens its retained page |
| `encounter.start`, `encounter.end`, `encounter.add`, `encounter.remove`, `encounter.setValue`, `encounter.setValues`, `encounter.reorder`, `encounter.next`, `encounter.prev`, `encounter.update` | D | Play. Turn order, active turns, reactions, readiness and In lair describe the fight. Previous remains its own action, not an alias for Undo |
| `roll.ask`, `roll.answer`, `roll.reopen`, `roll.close` | D | Play. Correcting a DM's request or typed answer belongs to the table. Answers generated by dice are different, below |
| `roll.change` | None, explicitly excluded | None. Allow/Keep settlement does not silently reopen a player's settled request. Preserve existing rules |
| `cast.ask`, `cast.close` | None in practice. DM cannot `cast.ask`, players do not stack it, and `cast.close` is explicitly excluded | None. Withdraw and Dismiss stay final. An outcome's atomic restoration of its own ask is the existing exception |
| `dice.roll`, `roll.dice`, `actor.deathRoll`, `actor.rechargeRoll` | None. Server resolves them to `sys.dice` | None. Dice are facts in the log. Correct their consequences with the existing controls, never erase or reroll a die through Undo |
| `template.create`, `template.update`, `template.delete` | D | Play. A placed spell area and its adjustments belong to the board |
| `drawing.create`, `drawing.delete`, `drawing.clear` | D, P | Play. Immediate correction of a mark. Player ownership restrictions stay |
| `fog.draft`, `fog.publish`, `fog.discard`, `fog.live`, `fog.reset` | D | Play. Correct a reveal or a fog gesture where it happened. Keep draft grouping and irreversible explored-map losses |
| `build.paint`, `build.erase`, `build.rect`, `build.poly`, `build.edge`, `build.label`, `build.clear`, `build.walls`, `build.stamps`, `build.lights`, `build.height`, `build.stairs`, `build.rough` | D | Play. Direct board edits stay with the builder's Undo, including text labels and placed lights. Remembered-map questions still apply |
| `build.ask` | None. Admission question, no applied edit | None. Cancel the held gesture locally as today. Its accepted build ops make the entry |
| `door.set` | D, no P | Play. Opening, closing, locking and finding a door are events, including a tap from Builder |
| `trap.create`, `trap.delete` | D | Setup. Define or remove the mechanism. Accidental deletion remains recoverable through Setup Undo |
| `trap.update` | D | Play for only `state` and/or `found`. Setup for `name`, `zone` or `rig`. Disarming is play, rewriting the trap's damage is setup |
| `trap.spring`, `trap.act`, `trap.settle` | D | Play. Preserve occurrence identities and all side effects. A trapped move remains one move entry, with today's player refusal rules |
| `character.create`, `character.delete` | D, no P | Setup. Define or remove the persistent character, including cascades. Keep the player's deletion confirmation and lack of Undo |
| `character.update` | D, no P | Setup except the precise HP and shape cases in section 3. A sheet, known forms, resources, level or re-sync must not hide in ordinary Undo |
| `monster.create`, `monster.update`, `monster.delete`, `monster.setSrdImage` | D | Setup. Library definitions and default art describe later placements |
| `companionBlock.create`, `companionBlock.update`, `companionBlock.delete` | D, no P | Setup. A companion's reusable block is a sheet, not spending that companion's action |
| `savedEncounter.create`, `savedEncounter.update`, `savedEncounter.delete` | D | Setup. Editing a saved fight differs from placing its tokens or running it |
| `scene.create`, `scene.delete`, `scene.duplicate`, `scene.reorder`, `scene.setMap`, `scene.setGrid` | D | Setup. Scene structure, assets and grid calibration define the board. Keep a detected grid and shape in one setup gesture |
| `scene.update` | D except thumbnail-only | Setup except the narrow live presentation cases in section 3. Names, folders, bounds, phase definitions, grid shape and movement rules are configuration |
| `scene.setPhase` | D | Play. Switching an already prepared map phase is a table event |
| `vision.holders` | D | Setup. Who owns individual sight is scene configuration. Undo still cannot restore forgotten exploration or remembered maps |
| `room.update` | D | Setup. Room name, permissions, combat defaults and all other room settings affect future actions |
| `room.setPlayerScene`, `view.follow`, `view.blackout` | D | Play. Moving the table, Follow me and blackout are live presentation controls |
| `member.update` | D, no P | None. Correct a personal name or color directly in Members. It should occupy neither game history nor campaign setup history |
| `journal.create`, `journal.update`, `journal.delete`, `pin.put`, `pin.remove` | D | Setup. Stored text, access and linked navigation are campaign content. Pin dragging stays with its other edits in this scope |
| `journal.reveal` | D | Play. Revealing or hiding an existing secret is a table event. Undo cannot make a player forget text already read |
| `handout.show`, `handout.close` | D | Play. Showing a prepared handout is a table event |
| `handoutDoc.create`, `handoutDoc.delete` | D | Setup. Keeping or removing a reusable document belongs to the library |
| `log.chat`, `log.whisper` | None. Log-only writes have no inverse | None. Messages and event history are not erased by Undo |
| `undo`, `redo` | Resolve a stack entry, or HP log correction, into `sys.restore` | Explicit scope chooses one stack pair. HP log correction remains separate and does not create a Redo |

Server-only `sys.memberJoin`, `sys.memberSetKind`, `sys.memberRemove`, `sys.explore`, `sys.remember`, `sys.dice` and `sys.restore` are never newly recorded as user actions. A successful stack restore puts its inverse on the opposite stack only. Asset upload/deletion, password and membership administration, exports/imports, local tool drafts, selection, camera, View as and device preferences are outside these stacks today and stay outside them.

### 2.1 Client paths that must agree

`RoomChrome.tsx`'s top buttons, `client/state/shortcuts.ts`, `createRoomActions`, Draw and Builder currently reach the same `undo`/`redo` dispatch. They keep Play as their default. The fog draft's own gesture removal, a polygon's Undo point, the builder's held-gesture cancellation, and native text-field Undo remain local or specific operations. None falls through to either room history when it has nothing to undo.

The token bar's `undoMove.ts` keeps `undo.of` tied to the newest op from that client. The Log's HP action keeps `undo.log`, whoever made the hit. Re-sync's dialog Undo still sends its guarded `character.update`. These are three different correction paths, not three ways to blindly pop the default stack.

## 3. Exact classification and protection from hidden setup changes

One exhaustive shared `undoScope(op, before)` returns `play`, `setup` or `none`. The server uses it after validation, with the actually accepted op. The client uses the same rule for wording. A compile-time exhaustive switch and a schema-derived inventory test require every new op to choose a scope. A new patch field defaults to Setup until explicitly classified. The client cannot label an arbitrary stat edit as Play.

- `token.update`: Play only when every top-level field is in `sceneId`, `x`, `y`, `elevation`, `rotation`, `size`, `w`, `h`, `visibility`, `light`, `companionReaction`, or a permitted play `actor` patch below. Moving a token between scenes is play. A token's name, art, ownership, kind, disposition, layer, locking, public-name rules, HP disclosure, sight sharing, fog exemption, companion link, notes, range rings and physical height are Setup. `token.updateMany` follows the same field rule on its smaller schema.
- Actor patches: current/temporary HP alone are Play. Maximum HP, AC, speeds, initiative modifiers, senses, sheet links, notes, stat-block links and legendary capacities are Setup. Legacy hand edits of spent legendary counts are Play only if every maximum equals the existing value and nothing else changes. Current UI uses `actor.use` instead.
- Taking or ending a character's shape is Play: an actor-only patch of the exact `shapePatch`/`END_SHAPE` structure in `client/features/pcstats/shape.ts`, on a character actor or its reference token. It changes `srdId`, optionally `wildShape`, the form's AC/speeds and temporary HP. It must not carry sheet fields or HP maximum. Attaching a block to an inline monster is Setup. This structural exception does not make a plain AC edit Play.
- `character.update`: Play only for those actor-only HP or shape patches. All other fields are Setup, including default size. Resizing a placed token is Play instead. A re-sync stays wholly Setup, including its HP clamp and resource counts.
- `scene.update`: thumbnail-only is None. `suggestedView` alone is Play. A `vision`-only patch is Play when only light changes: its required `on` must equal the current effective value, and `perPlayer`, if sent, must equal the current effective value. The current schema requires both `on` and `light`, so classification compares those values rather than demanding an impossible light-only payload. Everything else is Setup, including vision on/off, fog mode, per-player sight and phase definitions. A patch combining live and configuration fields is wholly Setup.
- An empty or no-effect op creates no entry. The reducer's real inverse, including cascades, follows the operation's one scope. Never divide an already applied inverse between histories or guess scope from the screen open at Undo time.

Mixed patches and a deliberate mixed gesture go wholly to Setup. A DM producer knows its gesture before sending its first part and declares `groupScope: setup` alongside its group id when any part is Setup. This may promote Play parts into Setup, never demote a Setup part into Play. The server fixes the group's scope at its first accepted part and refuses a later contradictory part before applying it. It never relocates an already offered or undone entry. Preserve consecutive, guarded merging and existing size/interruption splits. Each retained step restores atomically. Current producers keep ordinary HP controls separate from sheet saves and declare a grid detection's shape and grid as Setup from the first part.

Keep current whole-entity guards for DM restores. A newer stat edit after damage makes the older damage restore refuse rather than put the old stats back. Players' pose-only restores continue preserving later HP edits. The narrower HP Log correction remains available where its existing checks permit it. Do not add broad field merging or weaken a guard to make cross-scope Undo succeed.

## 4. Controls, histories and visible feedback

### 4.1 Ordinary and setup history

- Top-bar buttons keep the visible words **Undo** and **Redo**. Their descriptions become "Undo your last play or board change" and "Redo your last play or board change". Existing shortcuts, Draw and Builder use this scope. Empty Play never falls back to Setup.
- Menu gains **Setup history**, DM only. Its sheet shows the latest setup step's phrase and **Undo setup**, then the latest redo phrase and **Redo setup**. It is deliberately not a second pair of unlabeled arrows in the top bar. No new global shortcut. While this sheet has focus, Ctrl/Cmd+Z and Shift+Z invoke its named setup actions, except in text fields.
- Setup editors say after a successful DM save: "Saved. Undo in Setup history." Re-sync keeps its own immediate Undo in the done state for players and DMs. Its forward save and explicit inverse are Setup for the DM, never Play. Later toolbar Undo cannot undo the dialog's Undo.
- The server sends each member a private summary of their two heads and depths. A head has an opaque, session-bound step id and its existing safe label. Setup actions send that id. If another device changed the head, refuse and refresh with "Setup history changed. Check the next change." Never take a different setup entry instead.
- Show the next Play phrase in the top buttons' tooltip and accessible description when known. A received correction says "Undid moving Goblin 2." or "Undid setup: changing Bree's stat block." Redo is equally explicit. Before the first authoritative summary, the setup actions wait with "Loading setup history…".

Each member has Play and Setup stack pairs, each 50 entries per direction. They remain memory-only and share across that member's devices. Scope never changes on restore. A newly accepted member action that changes undoable state clears both of that member's redo stacks, even if the action itself is excluded from stacks, such as a server death roll. Log-only messages, free dice and bookkeeping do not. Undo/Redo move only their own entry. Other members' changes retain histories and rely on current guards. An oversized entry clears its scope's Undo, never causes the next press to jump over it, and says that the change cannot be undone.

### 4.2 Tell players what affected them

A DM undo or redo that changes a player's visible game state produces one short notice for that player, also retained in their Log. Examples: "The DM undid a play change." and, for an owner whose sheet changed, "The DM undid a setup change to Bree." All DM devices get the exact existing label in a DM-only event. Ordinary saves of a sheet remain outside this notice change.

Compute recipients on the server from each viewer's semantic projected before/after state, on the scene they receive, with revisions, timestamps, logs and private bookkeeping removed from the comparison. A private stat change reaches only owners who actually receive those stats. A hidden creature's movement sends no public notice. Losing something visible counts as a change. A DM view preview obeys the selected player's audience, not the DM's.

Freeze recipients and any allowed name when writing the event, then intersect with permission to read it now, using the existing audience rings and private parts. Do not broadcast the DM's label, ids, DC, hidden targets, damage totals, counts of affected creatures or the reason a guard failed. Generic words suffice where no safe name exists. No change visible to a player means no notice, including no otherwise empty event or event-derived counter. Announce once through the existing polite status/toast path, without opening a dialog or stealing focus.

An individual HP Log undo keeps its existing projected take-back line rather than adding a duplicate generic notice. A full outcome Undo writes the new notice. Its old rolls, HP and effect lines remain historical facts. Redo writes a new correction notice, never duplicates the original roll.

## 5. Reopening the group save

### 5.1 Identity, not a guess from HP or the log

Today `chain.apply` sends request closes, then one `actor.outcome` with a receipt tag in `plan`. `applySettled` locks the local page permanently. `castSeen` returns immediately for an applied page, even if Undo restored its ask. Its draft is in this tab's `sessionStorage`, not shared room data. A recharge action's automatic Use is currently a separate op after Apply.

**Reopen only after a successful whole restore of that page's current outcome entry.** The scope can be Play Undo from the top bar, a shortcut or the same member's other device. It need not be the device that applied. Track the outcome explicitly through its UndoEntry and RedoEntry. A failed restore, undoing a request close, Previous, a manually equal HP value, an effect removed by hand, or a row's HP Log undo never proves the outcome was undone.

This deliberately excludes partial corrections. One target's HP back while three conditions or another target's damage remain is not a page ready to Apply again. Even undoing every HP line separately does not count. The page stays locked, and the DM corrects the remaining values explicitly or starts a new group save. Do not offer Apply that could silently double the effects.

### 5.2 What returns on this device

Just before Apply sends anything, retain a versioned `beforeApply` checkpoint in the local draft. It contains the frozen rows, source and scene, test, DC, typed totals and marks, overrides, save visibility switches, outcome form, chosen damage result and references to completed rolls. It holds no pending command queue. A No save page returns to its previous editable phase. Other pages return to **rolled**, with the same selected creatures and their previous results, not a live selection that may now be elsewhere.

When an authoritative outcome status changes to undone, restore that checkpoint, clear the old plan and apply flags, and show: **"Outcome undone. Change the DC, roll again, or apply again."** A DC edit rejudges numeric totals and preserves explicit pass/fail/resist marks, matching today's rule. The damage total stays until the DM explicitly rolls it again. Reopening itself sends no rolls, requests, damage, effects or resource spending.

Add **Roll saves again** on the reopened page, with per-row Roll again and Ask again for the corresponding server and player rows. Successful rows are eligible here, unlike today's failure-only `rollAgain`. Rerolling the same test keeps frozen targets and bonuses selected for that new roll. Changing test, targets or source uses **Start over**, with confirmation when results would be replaced. It does not apply anything.

Roll/Ask again clears only the selected row's old result and manual pass/fail/resist mark before requesting a fresh result. Typed rows stay typed unless explicitly changed. Every reroll uses a new dice tag, and every new request uses a fresh id. Its note says "Fireball: save again" using the public name, never a hidden trap name. The original result and its original DC remain in the log. A new DC on the page does not rewrite those historical rolls or a closed request. Fresh asks carry the revised DC and current disclosure switches.

The reopened page rebuilds its next plan from current creature state. It does not reuse old effect ids, frozen damage reductions, a spent Resistance, missing creatures or a stale target's ownership. Gone rows stay marked and excluded as today. Off-scene or missing-scene pages cannot apply until their scene is available. The checkpoint restores choices, not the world's previous state a second time.

### 5.3 Repeated outcomes, Redo and requests

One page has at most one applied outcome at a time: Apply A, Undo A, edit or reroll, Apply B. B has a new plan id and its own pre-Apply checkpoint. Undo B restores B's checkpoint, not the first version of the page. Only the latest attempt is editable. Starting a separate group save creates a different page identity. One group's outcome is never split into several partially applied ops to fit a limit.

Redo A while its page is reopened locks it again and says "Outcome restored. Undo it before changing this save." It sends no dice or Apply. Keep any newer local draft edits separately rather than silently deleting typed work. After Undo A again, restore the pre-Apply checkpoint and offer **Resume your edits** for that separately kept draft. Applying B clears Redo A and advances the page identity's revision. A delayed Undo/Redo or receipt for A cannot change B's phase or apply A again. Merely editing the local DC does not clear server Redo.

The ordinary `roll.close` ops sent before Apply remain closed when the outcome alone is undone. Old answers remain available in the checkpoint, and new asks use new ids. Undoing one of those closes separately may restore its live card but never unlocks an applied outcome page. The page does not adopt late answers from superseded requests.

A tracked Apply folds the automatic recharge `actor.use` into an optional, validated recharge-use part of `actor.outcome`. Use the same `ifReady` rule and quiet audience as today. Its mark and effects commit or refuse together, and Undo returns only a use this Apply actually spent. This is required for "one Apply, one Undo": an extra automatic Use must not sit above the outcome or make reopening spend again. Explicit Use outside the page remains separate. Roll requests still close before the outcome, as today.

### 5.4 A save ask or trap that closed

- If Apply closed its player's save ask, the full inverse restores that same ask atomically with damage/effects and the status. Its caster sees the ask waiting again, plus the visible correction notice. The DM page can resolve that ask again once. This retains the existing outcome exception to final Dismiss.
- If the player withdrew or a DM dismissed the ask before Apply, the page had already become a plain group save. Undo restores that plain checkpoint and never recreates the closed ask. **Close the ask** with nothing to apply remains final and has no outcome to reopen.
- If another device resolved the ask, this device's stale Apply remains blocked. If that resolution is undone, its existing unapplied page can return to the waiting ask under today's `castSeen` rule. It never claims to hold the other device's damage choices.
- A trap outcome restores its exact `trapId` and occurrence `due`, not a new springing. The trap card can return only if the whole guarded restore succeeds. A newer occurrence, a changed rig or a deleted trap must not be overwritten or silently replaced with a plain save. A refusal leaves the page locked. The page's reroll does not run the trap's doors, pit, reveal or other actions again.

### 5.5 Other devices, closed pages and missing history

All DM devices receive the authoritative status. Only a device retaining the matching page and checkpoint restores those exact choices. Another DM device with its own page for the same ask sees the ask restored and can continue or open it normally. A device with no draft gets the correction in the Log and the restored ask/trap card where applicable. It does not manufacture another device's draft. Done, Discard, replacing the page or clearing this tab's storage still discards the local draft. Undo does not pop an old panel open.

Players never receive the DM checkpoint, page identity, status ledger or plan. Their HP/effects update through normal projection. A restored save ask is shown to its authorized caster as today. Old roll-request cards stay closed until explicitly reopened or freshly asked. An applied page that loses contact stays locked. On reconnect or reload, read authoritative status before enabling Apply, even if a cached receipt says committed. A receipt proves the original commit, not whether it was later undone.

If status or checkpoint is missing, say **"This save's outcome cannot be checked. Start a new group save to continue."** Keep the page locked. A missing record is never interpreted as undone. Server restart loses Undo history but retains the status of already applied or undone pages. A retained undone draft can still be edited and reapplied while its status is retained.

## 6. Stored contract, limits and replay

Store only outcome lifecycle metadata on the server, not a second copy of the DM's draft. Introduce optional `RoomState.saveOutcomes`, absent meaning empty, keyed by a tracking id assigned on the page's first Apply. That id is the first plan's UUIDv7, separate from the local draft's existing id. One record has `memberId`, latest `plan`, monotonic `revision`, `state: applied | undone`, first-Apply time and last-change sequence. It is DM-only and at most 512 UTF-8 bytes per record.

- `actor.outcome` gains optional `page: { id, expectRevision }`. The first Apply uses its own plan id and revision 0, and must create a missing record. Further Applies require that exact record, author member, revision and `undone` state. A successful Apply advances revision and stores its plan. Check this before changing any target. Refusal changes neither the record nor game state.
- First creation requires the tracking UUID's time to be no older than the existing maximum pending-op age of 12 hours (`MAX_OP_AGE_MS`), with at most five minutes of clock lead accepted. This is a new server check for tracked outcomes. The receipt deduplication window is 24 hours, not the pending-op age. Retries use the same plan and receipt. They never become a new attempt because the original record was pruned. A correction is a new plan with the old tracking id and an exact revision. Missing records with nonzero expected revisions are refused.
- Keep at most 200 records per room and at most 100 KiB serialized. Records live for 24 hours from first Apply. Pruning uses the stored op envelope time, with a deterministic order, never the replay machine's clock. A full ledger with no expired record refuses a new tracked Apply before it changes anything: "Too many saved outcomes. Try again after older outcomes expire." Never silently downgrade to an untracked Apply. Validate byte limits alongside the existing 56 KiB outcome bound.
- Each tracked UndoEntry carries its tracking id and plan. The server adds a bounded `saveOutcome` transition to `sys.restore`, naming the exact current revision and the expected plan. Undo requires `applied`, and Redo requires `undone`. It changes status and increases revision in the same transaction as the guarded restore. Carry that identity through `pushRestored`. Never restore lifecycle metadata through a generic entity inverse, where an unrelated restore could unlock the page.
- Undo/Redo of an expired record can still restore game state under the ordinary guards, but cannot reopen a page or recreate its record. The restored notification says the save page can no longer reopen. An unexpired mismatched record refuses the whole restore. A superseded outcome cannot unlock or relock its replacement.
- A tracked outcome is one unmerged step regardless of a supplied gesture group. Replaying an old first-Apply receipt after Undo returns that original receipt, but the newer status revision wins. Clients reconcile by revision and confirmed room sequence, never arrival order, and wait until the view covers the receipt's sequence before deciding that a record is missing.

`undo` and `redo` gain optional `scope: play | setup`, default Play, and the setup-head expectation. Players are refused Setup and setup-group declarations. `undo.of` is Play only and `undo.log` stays the separate HP path. The dispatch message gains the bounded optional `groupScope: setup` only alongside a group id, with section 3's server validation. Store scope and the safe correction event data on the resolved restore as needed for replay. Private head summaries are connection data, not RoomState or player projection.

Add the optional ledger to snapshot validation, keys/reads/projection plumbing where required, and export validation. Normal server snapshots retain it. Import into a new room deliberately drops it, as it drops open requests, since local drafts and undo stacks do not move rooms. Do not remap stale identities into live pages. Local checkpoint storage is versioned, bounded to one active page plus its latest pre-Apply and optional redo-held draft, with validated fields and a 512 KiB aggregate limit. If it cannot be saved durably, keep it in memory and say "This save can reopen here until this tab closes." A missing in-memory checkpoint cannot unlock either.

Use `OP_VERSION = 34` with an identity migration **33 to 34**. Gate new restore events, lifecycle transitions and embedded recharge behavior by original stored version so op-33 and earlier replay with their old state and log numbering. Old `actor.outcome` payloads remain valid without `page`. Use `SNAPSHOT_VERSION = 30` with identity migration **29 to 30**, since the new ledger is optional. Old snapshots gain no invented statuses. A v30 snapshot is the rollback boundary even if its ledger is empty.

## 7. Migration and rollout

1. Land the contract, permissions, classifier and server behavior together before enabling the client. Build on batch 39's op-33 migration, never replace it. Existing stored operations and inverse values retain their meaning. Existing room contents do not change scope as data, only future recording does.
2. Deploy with a room restart and clear both old in-memory stack directions. Do not split existing entries by guessing at inverse values. If a future hot upgrade preserves actors, explicitly clear their legacy histories before advertising the new protocol. Say once to DMs: "Undo now separates play from setup. Earlier undo history was cleared. Setup history is in the menu."
3. Reload all clients before resuming edits, using the app's existing version-change procedure. Reject incompatible pending ops through that procedure, not by interpreting an old unscoped Undo as setup. Existing applied local pages with no tracking identity stay locked. Old pending outcomes settle by their original receipts and never get retroactive reopen promises.
4. Back up before the version bump. No database table migration or manual room conversion is required. Restoring the pre-deploy backup is required for rollback to a build that cannot read snapshot 30 or op 34. This document authorizes no deploy.

The builder's final docs commit updates **FEATURES.md**: replace "Undo and Redo for the DM's changes" with the Play/Setup boundary, name the builder exception and the player's existing restrictions, explain visible correction notices, qualify the re-sync dialog's Undo, and extend the group-save paragraph with whole-outcome reopen, fresh rerolls, Redo locking and local-draft/24-hour retention. Do not claim HP Log undo reopens a group save.

Update **docs/dm-guide.md** in Undo, Dice/group saves, Characters/Re-sync and map preparation. Include a short procedure: Apply a group save, Undo its outcome, change DC or explicitly reroll, inspect the new result, Apply again. Give a second example of editing a stat block between two moves and using Setup history deliberately. Explain why an HP Log correction can work when a whole guarded Undo is stale, without implying it reverses all conditions. Clarify that forgotten exploration and information already shown cannot be recovered by Undo. Update the affected older design notes with a link here, including known forms' ordinary DM Undo claim and re-sync's toolbar example.

## 8. UI checklist

- **Loading and failures:** delay the shared busy indicator about 200 ms. Undo, Redo, Apply and reroll each refuse a second tap while pending. Every path ends with success, a named refusal or the existing unknown-outcome state. Offline and View as disable room actions. No speculative unlock and no automatic Apply retry.
- **Keys and focus:** keep native input Undo. Global shortcuts address Play except within the explicitly opened Setup history sheet. Escape closes it and returns focus to its opener. Reopening a save preserves focus on a surviving control, otherwise moves to the page's status line. Remote Undo/Redo never changes panels or steals focus.
- **Screen readers:** label the history scope and next action. Announce "Outcome undone. Change the DC, roll again, or apply again." once. Locked controls describe why. An unknown or expired status uses the exact words in sections 5 and 6. Do not announce the same result from both a toast and a second live region.
- **Phones and large interface sizes:** 44 px targets, 16 px inputs. Setup history is a bottom sheet on phones. Long action names wrap. Keep Apply/Done and Roll saves again reachable without sideways scrolling. Add the setup sheet and reopened/locked save states to the alignment roots.
- **Visual checks at build time:** `measureAlignment` at 1440 x 900, 390 x 844 and 320 x 568, at 100% and 130%, all differences at most 1 px. Also check 844 x 390 and 480 x 320 at 130% for controls behind alerts or toasts. No UI or screenshot verification has occurred in this design task.

## 9. Proof and e2e plan

| Case | Expected | Test |
| --- | --- | --- |
| Every client op and each patch field | Exactly the inventory's scope. Unknown additions fail coverage | Shared classifier table generated against the protocol discriminants and patch keys, plus before-state variants |
| Move, stat save, damage, room setting | Play Undo takes damage then move. Setup is untouched. Setup Undo takes setting then stat save | `server/rooms/undo.test.ts` and actor integration with labels and both depths |
| Mixed grid gesture and mixed token patch | One Setup scope, no partial Play inverse. A contradictory late group part is refused before mutation | Stack/actor tests with declared scopes, interrupted and oversized groups |
| Damage then a stat edit on the same holder | Whole Play Undo refuses, never rewrites the stat. Eligible HP Log correction preserves it | Actor plus `hpUndo` regression |
| Player move, resize, drawing, use and stats | Existing three undoable families only. Setup request forbidden. Hidden trap/attachment rules unchanged | Permissions, pose and trap tests, including same-visible-state/different-secret-state pairs |
| Different scopes, devices and co-DMs | Shared member heads, isolated member stacks, both redo directions cleared only under section 4's rule | Actor tests with two connections per member |
| Apply then its successful Undo | All targets, effects, Resistance, recharge mark and ask/trap return atomically. Only its page becomes editable | Outcome reducer/actor tests and `chain.test.ts` |
| HP Log Undo, failed whole Undo, Previous, manual HP equality | Page remains applied. No manufactured draft or unlock | Chain and actor tests |
| Change DC without reroll | Same totals, new derived verdicts, explicit marks unchanged, original logs unchanged | Rows/chain unit tests |
| Reroll all, one row, ask again, reroll damage | Fresh tags/ids, selected results replaced, old log retained, no automatic roll on reopen | Chain tests and receipt integration |
| Apply A, Undo A, Apply B, delayed A receipt/Undo/Redo | B wins by identity and revision. Undo B restores B's own checkpoint | Randomized chain/actor test |
| Undo, edit locally, Redo, Undo | Applied lock returns. Unsaved local edits are retained separately and can resume | Chain/storage tests |
| Cast withdrawn/dismissed, no-change Close the ask | No resurrected ask from an unrelated Undo. Plain outcome remains plain | Cast/chain tests |
| Trap changed, deleted or new occurrence | Guarded refusal or exact old occurrence restoration, no second trap action | Trap outcome tests |
| Reconnect, lost ack, duplicate receipt, status-before-ack and ack-before-view | No transient editable applied page, no double damage | Receipt/actor integration and randomized state machine |
| Restart, pruned logs, expired ledger, full ledger, failed storage, import | Status independent of log retention. Missing checkpoint/status stays locked. Caps refuse before mutation | Snapshot, import, actor and storage tests |
| Hidden actors, secret rolls, per-player vision, owners gained/lost, table display, blackout, View as | No page data or private label to players. Notice only for semantic state they receive | Projection byte assertions and log audience tests |
| Op-33 replay and snapshot-29 migration | Old state and log ids unchanged. Identity steps accept old records. New replay reproduces statuses/notices | Migration and replay fixtures |

Randomized tests generate Apply, duplicate sends, refusals, unknown receipts, reconnects, DC edits, explicit rerolls, Undo, Redo, expiry and a second device's actions. Name the invariants: at most one active outcome per page, committed damage at most once per plan, no unlock without matching successful full Undo, monotonically observed revisions, no command emitted by reconciliation, and no private bytes in a player projection. Use deterministic seeds and mutation-check each new behavior by removing its guard or transition and observing its test fail.

E2e labels start `undo-scope-`. Use DM desktop, a second device as that DM, a co-DM, the affected PC's player and an unrelated player:

1. Move a token, save its character's block, move it again. Undo twice from the top bar. The block stays saved. Open Setup history and Undo its named save. The owner gets one correction notice, the unrelated player gets none for private stats.
2. Paint a wall, Undo from Builder, Redo by shortcut. Change the scene's grid settings and prove Play Undo cannot revert them. Setup history can, subject to existing shape/dependency checks. Test phone access and native text Undo.
3. Apply a save with damage and a condition to two creatures, one with Resistance, from a recharge action. Undo its one outcome. Both creatures and the consumed use restore. The retained page shows the old totals and editable DC. Change DC, apply, undo, explicitly reroll, then apply again. Original and new rolls remain in the Log.
4. Undo from the second DM device while the original device is offline, then reload it. Its draft reopens from authoritative status. Redo locks both matching drafts. Done on one device removes only that local draft. A third device never invents it.
5. Undo only one HP log line. The save stays locked. Change another target so whole Undo refuses. It stays locked with the refusal. A copied stale page cannot apply a replacement while its record is still applied.
6. Repeat for a player's save ask, a prior withdrawal, final Close the ask, and a trap occurrence. Assert player card behavior and raw projected data. Two DM pages racing to resolve one ask change HP once.
7. Check pending controls, unknown Apply, storage failure, expired tracking, keyboard focus and the alignment matrix. Run `groupsave.e2e.ts`, `rolls.e2e.ts`, `savespell.e2e.ts`, `traps.e2e.ts`, `combatuses.e2e.ts`, `resync.e2e.ts`, `tools.e2e.ts` (Builder), `scenesetup.e2e.ts`, `shortcuts.e2e.ts`, the touched alignment suites and `reach.e2e.ts`.

Run the lane's typecheck, unit/build and integration checks before e2e. This design task runs only document and source-inventory checks. Do not report these planned runtime tests as passed.

## 10. Decided, for the project owner to overrule

These are recommendations inferred from the owner's notes and the existing decisions, not new owner approvals. No questions are outstanding.

| Decision | Picked | Rejected and why |
| --- | --- | --- |
| D-261029-370 | Ordinary Undo is play plus direct board edits | Every DM change in one history. It can quietly revert a sheet |
| D-261029-371 | A separately opened Setup history, with its own Undo/Redo | No recovery for saved configuration, or switching the top bar's scope with the selected panel. Both make mistakes harder to correct predictably |
| D-261029-372 | Classify op fields and actor context on the server | Classify by whether combat is running or trust a client scope flag. The same action must keep its meaning |
| D-261029-373 | Mixed patches/gestures are one Setup step | Splitting an inverse after commit. It can leave derived stats and HP inconsistent |
| D-261029-374 | Keep player stacks and explicit correction controls unchanged | General player HP/stat/use Undo. Existing Restore and re-sync correction avoid hidden-state leaks |
| D-261029-375 | Keep whole-value guards, dependencies and irreversible memory rules | Merge old DM inverses into newer values. This would risk restoring unseen stats or information |
| D-261029-376 | Named setup heads and safe player correction notices | DM-only success feedback, or broadcasting the full DM label. Players need to notice their changes without learning secrets |
| D-261029-377 | Reopen only the exact, fully undone current outcome | HP equality, one log-line undo, or any disappearance of an ask. None proves all effects were removed |
| D-261029-378 | Restore the pre-Apply choices and frozen rows | Reset to a blank page or follow the current selection. Both lose the save the DM meant to correct |
| D-261029-379 | Explicit fresh rerolls, original results retained in the log | Reroll on Undo or overwrite old results. Undo must not draw dice |
| D-261029-380 | A new plan/checkpoint per reapplication and monotonic server revision | Reuse the old plan tag. Its receipt would return the old success without applying the new result |
| D-261029-381 | Redo relocks and preserves intervening local draft edits separately | Leave a redone page editable, or silently discard its typed changes |
| D-261029-382 | Preserve final Dismiss/Withdraw/Close and exact trap occurrence rules | Turn a stale trap into plain damage or reopen every closed ask |
| D-261029-383 | Server lifecycle metadata, local draft checkpoints | Server storage/synchronization of entire save drafts. Today's drafts belong to a tab and reopening does not require collaborative editing |
| D-261029-384 | Other devices reconcile status, only retained matching drafts restore exactly | Invent another device's choices or automatically open a discarded panel |
| D-261029-385 | Missing status/checkpoint locks, bounded 24-hour tracking | Treat missing history as undone, or retain unbounded outcome metadata |
| D-261029-386 | Put automatic recharge spending inside tracked Apply | Leave an automatic extra undo step above the outcome. One Apply must reverse as one outcome |
| D-261029-387 | Clear legacy memory stacks at rollout, keep stored replay semantics | Reclassify old inverses or alter historical logs |
| D-261029-388 | Op 34 and snapshot 30, both identity migration steps | Reuse batch 39's op 33, or let an older snapshot reader drop reopen state |
| D-261029-389 | Document scope, player notices, local retention and partial-undo limits with tested examples | Advertise generic "Undo reopens saves". It promises unsafe reapplication after a partial correction |

The existing decisions retained here include the 2026-10-19 final-Dismiss rule, the 2026-10-22 guarded re-sync Undo and exact server stamp, player Restore rather than use Undo, the advisory Regeneration damage-type note, D-261028-76's fog gesture grouping, and the requirement that Undo/Redo remain available in the DM's top bar. Re-sync still undoes the whole sync in its dialog. An HP correction still does not erase the advisory record of a damage type.

## 11. As built

Not built. The implementation lane records deviations, exact version allocation, measured bounds, test results and screenshots here in its final docs commit. This task changes only this design document.
