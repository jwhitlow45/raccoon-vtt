# raccoon-vtt: the room count

Status: built, 2026-11-10. It stepped OP_VERSION to 57 and SNAPSHOT_VERSION to 44 (`COUNT_OP_VERSION` and `COUNT_SNAPSHOT_VERSION` in shared/migrate.ts). Code is cited by function and file, not by line, since the room actor changes often. As built, near the end, lists where the build went its own way.

Devices get their numbers from a count that only members' ops move. A private server op, such as the explore that records what a player's character has seen, moves no number a player's device receives.

## 1. The problem

The room actor keeps one sequence, `seq`, and every stored op takes the next number in it. Members' ops take numbers, and so do the server's own ops: the explore that stores newly seen ground, the remember steps that keep a player's map memory, and the music's tick. Several of these are written only when state some player cannot see has changed.

A player reads `seq`, or a number made from it, in event frames, log line ids, turn numbers and receipts. So the gap between two numbers a player sees counts ops the player never saw, and that count depends on hidden state.

The secret door twin tests showed it. Two rooms are identical except that one has a secret door and the other solid rock. In the room with the door, a second player walks inside a closed room, out of the first player's sight, and the server writes explore ops for what that player now sees. The first player sees the same token moves in both rooms and then sends a chat line. The chat's event number and log id differ between the rooms (8 and `8:0` against 9 and `9:0`), and the first player has learned that the door exists.

## 2. Every number a player receives

Each number below is made from the count after the change.

- The `seq` of an event frame, of a snapshot and of a history frame, and of a resent event.
- A log line's id, written `"<number>:<index>"`. It appears in the log's keys, in log pages and their cursors, in sessions and in receipt lines.
- The ids of trap lines a player has seen.
- The `seq` of a turn start in the initiative state, and the `turn` of a token's path.
- The id of a turn record, which a player's device sends back when it uses the record.
- A receipt's `seq`.

Three more numbers are made from the count and never sent to a player: the log read cap, the receipt wait, and the DM-only numbers (`startSeq`, a saved roll's `seq`, due ids, the copy-of ids, the `of` in an HP undo and the `seq` in room.json).

Other numbers were already independent of hidden state. The `lines` count of a session and the sessions cursor count lines after projection. The tie order in initiative is renumbered over the rows a player sees. A scene's `order` and `wallsVersion` are zeroed for players. A floor's `level` counts only the floors a player holds. `time.at` is the server's clock, and presence lists online members only. A device's own numbers (`hello.resumeFrom`, watermarks, the history `serial` and `depth`, acks, retry gaps and `pong.k`) were never made from `seq`.

The server's own ops fall in two classes.

| Op | Reads hidden state | Writes log lines | Class |
| --- | --- | --- | --- |
| `sys.explore`, at the end of a batch and in the middle of one | yes | no | uncounted |
| `sys.remember`, the map step, forgetting and the image cleanup | yes | no | uncounted |
| `sys.sound`, the music tick | yes | no | uncounted |
| `sys.restore`, `sys.dice` | no | yes | counted, as the member's op they stand for |
| `sys.memberJoin`, `sys.memberSetKind`, `sys.memberRemove` | no | one shared line | counted |

A deletion step, asked for or swept, takes no op number and sends no answer, so it never moves a count.

The client's readers of these numbers stay as they are. The store predicts an op's number as `seq + 1 + i`, the history needs `history.seq === store.seq`, the log orders ids with `compareLogIds`, and the unread marker keeps the last id seen. All of them need one number space ordered as time runs, and the count is one.

## 3. Approaches weighed

- **A count that private ops never move (chosen).** A second number beside `seq` moves once for each member op the room answers, taken or refused, and once for each member change applied over HTTP. Bookkeeping never moves it. A member's answer takes the server's clock in milliseconds, or one past the last number when that is later, and frames carry the clock as their batch closes (4.8). The stored number is written in every commit's transaction. Twin rooms that receive the same members' ops get the same numbers, whatever the bookkeeping does. It costs one integer per batch, and the client does not change.
- **Numbers per recipient.** Log ids are stored once and shared by the state, the archive, receipts and `room_log_access`, and turn numbers and record ids live in state and come back in ops (`undo` with `log`, `record`). Each projection would need a translation for each player and a reverse map for each op, plus a record of which ops reached each player, offline ones too. That means projecting every member on every batch inside the fan-out and changing about 40 client readers. Rejected for cost (D-261109-066).
- **Equal counts by padding.** Write every bookkeeping op for every floor in every batch and tick on a fixed clock. This stores more rows, the explore itself reads the list of sight holders, and any conditional server op added later would reopen the problem without a sign. Rejected.
- **No numbers on the wire.** Opaque ids ordered by time. Two lines in the same millisecond would misorder, and every reader in section 2 would change. Rejected.

## 4. Design

### 4.1 The count, and what stays on `seq`

The count (`#pub` in the room actor, the stored number) is a nonnegative integer for each room, at or above the number of every stored row and line. The highest number handed out (`#handed`, 4.8) is at or above it and every number a device was given.

`seq` keeps every storage job, and nothing a player receives is made from it. Those jobs are the numbering of stored rows, replay order and contiguity, the prune of covered rows, `batchCommitted`, snapshot gating, `#ensureBatch`, the asset caches `#visibleCache` and `#stagedVisibleCache` (which must miss after an uncounted op changes state, for example a tick moving to a track whose sound is refused), and a deletion step's `committed.seq` argument.

The two are never compared. The number runs far ahead of `seq`, since it follows the clock, and bookkeeping rows take a `seq` and leave it.

### 4.2 Where the count moves

A new number is taken once for each answered member op and each applied member change, at these points and nowhere else, and the stored number moves to the batch's number at the close of a batch that answered one (4.8).

- `#reduce` installs a counted op in one step with nothing inside it that can throw. Everything the step needs is prepared before it: `#ensureBatch`, the row, `growthBound` for the size guard, and the time `lastOpAt` takes. The step adds the row to the batch, moves the staged state and `seq`, moves the count and the batch's `answered`, sets `lastOpAt`, and installs the fan-out's metadata: each of `result.touched` pushed onto `batch.touched` by a loop, and `batch.global` when set. The size guard's `grew` and `memory?.commit()` run after it. Done in another order, a throw between the staged state and the row would keep a refused op's state and leave a gap in `seq`. Without its touched keys an accepted op would reach no other device. A throw before the install leaves no effect of the op, and `#refuseFault` moves the count once. A throw after it keeps the whole accepted state, its row once and its keys, and `#settleStaged` finishes it. The ops that go through this step are a member's op, `sys.restore`, `sys.dice` and the three member changes from `#processSys`.
- `#refuse` moves it for every refusal of a member op, including one after a failed `#reduce` and the refused branches of `#answerFromReceipt` and `#finishAsk`.
- The three answers that store no row move it where they answer: a discard, an `#answerFromReceipt` that is taken, and `#finishAsk`.

It does not move in `#settleStaged` (the staged row already moved it), on a hello's settle, a resend, a silent duplicate, a `retry` answered busy or gap, `#processSys` finding the work already done or rejecting it, a deletion step, or any uncounted op. An op that throws after its install keeps its number, so the next op's ids stay unique and higher.

### 4.3 The numbers ops carry

- A counted op reduces with `env.seq` set to `#nextNumber()`, which is the number it takes at staging (4.8). The restore preflight and the ask read use the same helper.
- An uncounted op reduces with `env.seq` set to the count at its staging, whatever was last published (D-261109-068). Its result never depends on that number.
- **No bookkeeping op starts a turn.** `turnStarted` in shared/reducer/trapStep.ts returns null for `sys.explore`, `sys.remember` and `sys.sound` by op type, live and in replay, for every op version (D-261109-078). It used to test `start.seq === tx.env.seq`, and an uncounted op carries the count of the Next before it, so a tick or a mid-batch explore would have sprung the turn-start traps a second time. Before op 57 these rows took `seq + 1`, never equal to a turn's number, so the exclusion changes no stored room.
- `Env.uncounted: true` (shared/reducer/tx.ts) marks an uncounted op. `Tx` refuses with `invalid` any log or trap line written under it. This is a net only. The actor's refused-server-op path logs it, and a refused map step makes its scene forget.
- The class is frozen for each op version. `counted(type, opVersion)` in server/rooms/counted.ts is a `Record` over every `ServerOnlyOp["t"]`, so a new type fails the typecheck until it is classed, and member types are counted. Every type counts below op 57 (D-261109-111). Replay sets `uncounted` from the row's op version, so live and replay agree. Moving a type between classes later steps OP_VERSION.

### 4.4 Batches and frames

- A batch's `pub` is the number its frames carry, set at `#commitNow` before its explore and map steps, and its `stored` is the stored number then (4.8). The fan-out's `CommittedBatch.pub` and an event's `seq` are `batch.pub`. When the commit lands `committed.pub` takes it, and `committed.through` takes `stored`.
- `buildSnapshot(state, pub, conn, watermark)`, the resent event, the empty event and the history frame are sent at the close of the batch the request joined, with that batch's number (4.8). A refused op and a taken one read alike.
- The receipt row's `seq` is the op's number. `stateThrough` (server/http/receipts.ts) waits on the committed `through`. `captureView` in server/rooms/logHistory.ts carries the committed `through`, and the log read's scan stops at it (its `maxSeq` is the view's `through`), so a page read during a commit returns none of that commit's lines.
- The batch cap counts answers only. Each batch keeps `answered`, the count's moves since it opened. The cap compares `answered` with `maxBatchOps`, so a refusal fills a batch as a taken op does. Compared by rows instead, a second player's hidden move that is taken would split another player's acks into [1, 2] and [3], and the same move refused would give [1, 2, 3]. Both the cap and `#walkNeedsSteps` count the answers since the batch's steps last ran (4.8). A walk finds work only after such an answer, which keeps its invariant: a batch with no answer since holds at most a tick or a cleanup remember, and neither changes what `stopGround` reads (fog, explored tiles and sight).
- A batch closes at the next multiple of `batchMs` on the number clock, whoever opened it (`#scheduleCommit`), or at the cap. A deletion step waits for the open batch's own commit.
- `lastOpAt`, which eviction reads, moves with the count, refusals and row-less answers included, and never for bookkeeping.
- The wire keeps the name `seq` (D-261109-072). Export keeps writing `seq` in room.json, and it is the count (D-261109-116). Import starts a room at its last line's number, which is already in the count's space.

### 4.5 Storage and versions

- db/schema.sql adds `room_ops.pub` (each row's envelope number) and `rooms.pub` (the count at the room's last commit), both `bigint` and null on rows from before. There is no snapshot column (D-261109-076).
- `commitBatch` writes each row's `pub`, and sets `rooms.pub` in the transaction of every batch that carries ops or watermarks (D-261109-112).
- OP_VERSION 57 and SNAPSHOT_VERSION 44 are identity steps in shared/migrate.ts (D-261109-070). An older build would number new lines by `seq`, which the count can pass, and would reuse ids. So an older build must refuse the rows and snapshots this build wrote, and `runMigrations` does.

**The barrier.** A room saved before the change gets one snapshot at format 44 in the transaction of its first commit that answers anything. That snapshot is what makes an older build refuse the room.

- It is armed when the loaded snapshot is below format 44, so never for a room made or imported after the deploy. A room whose replay failed is never armed. It is read-only, takes no op and writes no line an older build could number again, and it keeps its snapshot row and rows so a fixed build can rebuild it.
- The first commit while armed carries the snapshot, built from the batch's state at the batch's `seq`, with the prune of covered rows. It does so even when the commit holds only refusals or watermarks and `seq` has not moved, which a plain `#writeSnapshot` would skip. A batch with no ops and no watermarks writes neither `rooms.pub` nor the barrier.
- The snapshot's JSON is built and checked once, at the top of `#runCommit`, before the retry loop, so every retry sends the same bytes. A build that throws is logged once and the batch commits without it, still armed. The next try is the first commit `snapshotIdleMs` later by the actor's clock (D-261109-113). A `#writeSnapshot` that lands at format 44 disarms the barrier, and so does a load-time one.
- Only once the commit is confirmed does the actor disarm the barrier and record the snapshot: `#snapshotSeq`, `#opsSinceSnapshot` and the stored size. A failed snapshot write rolls the whole transaction back, and the same batch retries. The barrier commit waits for a running `#snapshotting` and holds it until it lands, so two writers never touch the snapshot row at once. Its quota check runs unawaited (D-261109-114).
- Once a room's barrier has landed, an older build refuses it (D-261109-107). There are two stated exceptions, in this note and in the update note. A barrier whose build throws, a bug, commits its batch without it and stays armed, so an older build still loads the room until a later commit lands one. A room whose replay failed here gets no barrier, for the reason above. Rejected: holding a batch's answers until its barrier builds, since one bad build would then stop the room, and a marker op type, which would be a protocol change for a window only a bug opens.

### 4.6 Replay, restart and old rooms

- `loadRoom` (server/rooms/persistence.ts) sets the count to `rooms.pub` when it is not null. Every commit since the upgrade wrote it in the transaction of its rows, so no stored row's number is above it, and the snapshot's `seq`, which counts bookkeeping too, never seeds it. A room whose `rooms.pub` is null (an old room, or one made or imported before its first commit) starts at the snapshot's `seq` and rises with each replayed row's number.
- A load also counts past every number an older build's rows or snapshot reserve, the rows after a replay failure included. A replay-failed room's first commit therefore never stores a count below a line the tail holds, and a repaired replay cannot number a line twice (D-261109-118).
- Each replayed row reduces with `env.seq = r.pub` and `uncounted` from its op version. A row before op 57 uses its `seq`. A row at op 57 or later with a null `pub` fails replay, so no new-format row ever reads a storage number. Replay never recomputes a number.
- A restart keeps every answered op the last commit held, refusals included, because `rooms.pub` was written in the same transaction as their watermarks. Answers still in flight are lost with their acks, and their clients resend.
- An old room replays as before and its count ends at its last `seq`. Every number a device holds (log ids, turn numbers, record ids, receipts in their 24 hours, archive rows and the last seen id in localStorage) is at most that, so ordering holds. Nothing is renumbered (D-261109-071).
- `loadRoom` also returns `through`, the newest number whose op the state holds. It equals `pub` after a whole replay. After a failed replay it is the last replayed row's number. `committed.through` stays put while refusals move the count, and `stateThrough` and every log route (page, sessions, export) stop at it.

### 4.7 Resync, reconnect, undo and redo, co-DM

- A hello's snapshot carries the number of the batch that answered it (4.8), and the client overwrites its number with it.
- An undo or redo is answered once, and its `sys.restore` stores that number. Rides compare `TurnStart.seq` by equality. An HP undo finds its line by id, and that id is in the count's space. A history frame carries the number of the frames it goes out with, so `history.seq === store.seq` holds.
- Prediction at `store.seq + 1 + i` is a placeholder the confirmed line replaces. The DM's device does not predict an op that can change the turn, so every turn number and record id it holds is a confirmed one.
- Every DM socket, preview and table display gets the same count. A saved roll's `seq` comes from `env.seq`, so reopening a save compares numbers in one space.

### 4.8 Numbers on the clock

- `ActorOptions.numberClock` is `now` unless a test passes one. A counted answer takes `max(handed + 1, clock)`, where `handed` is the highest number any device was sent or any answer took, kept in memory. The stored number (`#pub`) moves only with answers and at the close of a batch that answered one.
- A command reads both clocks once, as it is queued (`#enqueue`), and its number, its lines' times and `lastOpAt` come from that reading, however long it waited behind a commit or a deletion step. The music's tick reads them as the queue reaches it, since the step it works out is for that moment.
- A batch's frames carry `max(handed, close)`, where `close` is the number clock read as the batch closes, before its explore and map steps. A batch that answered no one stores nothing new, and hands its number out only as one of its frames goes to a device.
- A counted op's `at` is its number as a date while that leads the clock by at most a second, and the clock otherwise.
- Every snapshot, the hello's, a preview's, a display's and a delayed one's, and every resent op's ack with the history after it, joins the open batch and is answered when it commits, from the committed state, with its number. A batch of reads alone writes nothing.
- A walk that needs the batch's sight runs the batch's explore and map steps in place from a cursor, and the end step reads from the cursor, so the rows and the state equal a commit before the walk.
- A load warns once when `rooms.pub` leads the clock by more than 5 minutes, and an import refuses a file whose newest line leads it by more than 5 minutes.
- Tests that pin small numbers run a standing number clock (`STANDING_CLOCK` in server/rooms/undoScopeTesting.ts, the default of `startEngine`, `scopeActor` and `storedActor`). `ITEST_NUMBER_CLOCK=real` runs the integration suite on the real clock.

## 5. Residuals

- **A line the projection withholds later.** A shared line that the projection withholds afterwards, such as a pause or a creature that has been hidden since, leaves a gap in that op's line indexes for any device that reads afterwards, one loading for the first time included. Every player could read the line when it was written.
- **Numbers made before op 57.** They keep counting what they counted, and a device that reads them for the first time gets that numbering too.

## 6. Tests

Twin rooms differ in hidden state alone and take the same members' ops. `numbersIn(frames)` in shared/seqTestutil.ts lists every frame's `seq` and every log and trap line id, turn start, path turn, turn record id and receipt `seq` the frames carry. Each twin test compares the first player's and the table display's whole frames byte for byte, every rev included, with history ids mapped to a first-seen order. Every twin case fails on the code before the change.

- **server/rooms/seq.twin.test.ts** covers a second player walking out of sight, then a reload, a resend, a tagged roll, initiative with Next, a trap, a map step, an image cleanup, a tick, an op taken in one twin and refused in the other, restarts with snapshots, undo and redo, two DM sockets with a preview, faults before and after the install, bursts queued behind a held commit with `maxBatchOps` 3, a walk after a lone tick, the sweep, and the batch timer.
- **server/rooms/seq.random.test.ts** runs random twins: moves, chats, whispers, rolls, initiative, undo, edits on remembered ground, an image delete, the clock past a track's end, the sweep, resends, page reloads and room reloads through a stored room fake, and bursts that the actor's own cap splits. After every event the counts agree between twins and every frame the first player got is equal byte for byte while the two twins' players see the same ground. A frame's `seq` never decreases, and no turn-start trap springs twice for one Next.
- **server/rooms/seq.itest.ts**, **countSnapshot.itest.ts** and **countSnapshot.test.ts** cover the database half: log pages and sessions across edges, restarts, an old room's first commit and its barrier, a replay-failed room, and the older loader's refusal.
- **server/rooms/counted.test.ts**, **counted.prop.test.ts**, **shared/reducer/tx.uncounted.test.ts** and **server/rooms/trapStep.uncounted.test.ts** cover the class table, uncounted ops over random rooms (equal states and touched keys, an empty log), the line guard, and bookkeeping ops that start no turn.
- **server/rooms/logHistory.seq.test.ts** checks that a page read during a commit holds no line above the captured count. server/rooms/secretDoor.random.test.ts and dungeon.secret.test.ts compare whole frames.

Each rule has a mutant that fails a named test: bookkeeping that moves the count, refusals that do not count, frames made from stored rows or from `seq`, receipts from the staged `seq`, replay with a row's `seq`, `rooms.pub` not written on a refusal-only commit, the count moved in `#settleStaged`, the exclusion in `turnStarted` removed, the Tx guard removed, the cap or the walk on rows, a barrier on a replay-failed room or missing from a refusal-only first commit, and a timer from the batch's opening.

## 7. What proves nothing older broke

The whole unit and integration suites run, with the tests that pinned a number counting a bookkeeping op taking the new number and a line saying so. The end-to-end files that read these numbers run too: reach, resync, undo-scope, pervision, mapdiscovery, groupsave, rolls, combat and traps. No bench row changes, since the fan-out does the same work.

## 8. As built

- `#reduce` reads the clock for `lastOpAt` just after the install, with `grew` and the memory commit (D-261109-110).
- The barrier is `#countSnapshot`, built by the `snapshotJson` option, which only tests replace to make the build throw. Its gate (ops or watermarks) is in the actor, and `commitBatch` writes any snapshot it is given.
- `CommittedBatch` carries `pub` and `HistoryView` carries `through`, and neither carries the storage `seq`. The sessions cache keys on the view's `through`, the number the read stops at: the stored number at the last commit, or where a failed replay stopped (D-261109-164).
- The batch-end explore runs when the batch answered something (`answered > 0`) or holds door work, and the explore inside it needs an answer. A refusal therefore explores, and a batch that only keeps the room's books never does (D-261109-165).
- A room whose replay failed skips the explore and the map step, and `#appendServerOp` refuses with an error log, so no server op writes into the failed tail. Its refusals still commit their count and watermarks (D-261109-186).
- One helper, `#snapshotStored`, records a stored snapshot for a commit's barrier and for a snapshot written alone, and returns the quota check, which `#writeSnapshot` awaits.
- The stored room fake is `StoredRoomDb`, with `storedActor` and `restartStored` in server/rooms/undoScopeTesting.ts. It keeps rows, the snapshot, watermarks, receipts and `rooms.pub`, and it refuses a stored row's `seq` at the INSERT statement, as the primary key does (D-261109-187).
- The undo-scope end-to-end file waits for each DM page to cover its own newest frame. A DM page's own refusal moves the count and sends the other DM pages no frame.

## 9. Decisions

D-261109-066 rejects per-recipient numbers. 068 gives an uncounted op the count at its staging. 070 makes the version steps identity steps. 071 renumbers nothing. 072 keeps `seq` on the wire. 076 stores the count in `rooms.pub` on every commit and adds no snapshot column. 077 maps history ids in the twin tests instead of seeding them. 078 excludes bookkeeping ops from `turnStarted` by type for every version. 105 makes batch boundaries follow answers, with the timer from the first answer. 107 states the downgrade guarantee and its two exceptions. 110 to 118 and 164 to 169 are the build choices in section 8. 186 and 187 cover the replay-failed room and the stored fake's key check. The update note is in [docs/self-hosting.md](../self-hosting.md) under "Change numbers".
