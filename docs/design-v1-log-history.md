# raccoon-vtt design addendum: room log history

Status: built and deployed, revision 4 after round 3 disposition, 2026-10-30. Section 7 records how the build went.
Code references are against `de083a47ca084e07dd004068a9401df4bf15bd5b`.
This extends design.md 7.3, 10.8 and 16.2, and design-v1-dm-tools.md 3.10.
It changes archive retention and retrieval, not the reducer's live rings or who may read a line.

## 1. Today

### 1.1 Stored lines and their readers

- `LogEntry` is structured data with `id`, `at`, kind and optional event, sender, recipients, `parts` and `copyOf` (`shared/model.ts:2646`).
- The id is `<op seq>:<line index>`. Time comes from the op envelope, not from when a page is read (`shared/reducer/tx.ts:443`).
- `Tx.settleLog` fixes each new line's audience using the state after its op (`shared/reducer/tx.ts:284`).
- A shared line starts below 100,000. A party reader gets their own run from 100,000. DM lines start at 900,000 (`shared/logRings.ts:85`, `:99`).
- Party copies contain only their reader's data. The original belongs to the DM. Whispers belong only to sender and recipients, including for DMs (`shared/project.ts:3539`).
- The live rings retain 200 shared lines, 200 DM lines, and separately bounded whispers and party copies (`shared/logRings.ts:55`, `:70`, `:281`).
- Their bounds and byte budgets are reducer rules. Changing them needs an op version (`shared/logRings.ts:50`). This design leaves them alone.
- Read-time projection can narrow a previously readable line when a creature disappears or leaves sight, ownership changes, a handout closes, or blackout begins (`docs/design.md:647`).
- `projectArchivedLog` applies those rules without applying the live rings. It strips obsolete HP Undo records (`shared/project.ts:3497`).
- Players never receive `parts` or `copyOf`. Displays receive no log (`shared/project.ts:3536`).

`room_log` has `(room_id, id)` as its primary key, an `at` column and JSONB `entry` (`db/schema.sql:49`).
There is no numeric ordering index and no audience index on this table today.
`commitBatch` writes the op and every settled archive line in one transaction (`server/rooms/persistence.ts:196`, `:221`, `:346`).
Inserts use conflict handling, so retry does not duplicate a line.
Imports archive the complete remapped input and put only its bounded rings in the snapshot (`server/rooms/importRoom.ts:251`, `:267`).
`loadRoom` repairs older imports from surviving seq-0 snapshot lines, unless any are already archived or the archive holds at least 10,000 rows (`server/rooms/persistence.ts:80`).

### 1.2 Retention, pages and sessions

`LIMITS.logStored` is 10,000 (`shared/limits.ts:113`).
After writing a snapshot, `writeSnapshot` deletes all archive rows beyond the newest 10,000 in numeric id order, across every audience (`server/rooms/persistence.ts:307`, `:315`).
This is periodic pruning, not an insert-time hard maximum. Between snapshots a room can hold more.
The follow-up's reference near persistence.ts:89 is the import-repair guard, not another prune.

`readLogPage` sorts and compares numeric `split_part(id, ':', ...)` expressions (`server/rooms/persistence.ts:398`).
`GET /log` defaults to 50 lines, permits 100, reads raw batches of 100, and projects each batch (`server/http/log.ts:30`, `:204`).
Its outward cursor is the oldest returned line, never the last scanned hidden row (`server/http/log.ts:213`).
A full page always offers another page. A short page stops, so the final page may be empty.
However, more than 1,000 rejected rows stop the raw scan. At 1,100 hidden rows the next readable line is unreachable (`server/http/log.ts:50`, `:204`).
Each batch currently calls the actor's latest committed projection, rather than capturing one state for the request (`server/rooms/actor.ts:819`).
Preview pages also remove whispers the requesting DM cannot read and echo the chosen player (`server/http/log.ts:195`, `:209`).
The route still accepts a DM scene, but today's DM projection returns each non-copy line directly (`shared/project.ts:3543`). Its pages are all-scenes despite the older route comment.

The follow-up's direct count claim does not reproduce before pruning.
`ProjectedLogs.get` reads the archive, projects it, and only then supplies `log.entries.length` and `sessionsOf` (`server/http/log.ts:116`, `:123`, `:160`).
The four-hour grouping operates only on those projected entries (`server/http/logExport.ts:22`).
Whispers cannot bridge a nonparticipant's evenings, create a hidden-only evening, or move their session's endpoints by themselves.
The existing integration test checks listing, file and remaining rate limit after adding private rows (`server/http/logExport.itest.ts:77`).
It does not cross a snapshot prune or the 1,000-row scan cutoff.
The cache holds eight complete projected logs, keyed by room seq, member and role (`server/http/log.ts:75`, `:104`).
Both listing and export consume the same request limit, whether cached or not (`server/http/log.ts:146`).

### 1.3 Observable channels and limits of the claim

| Surface | Today | Result |
| --- | --- | --- |
| Retained history | A private row occupies one of the shared 10,000 places | Deletes somebody else's readable history, counts and earliest session boundary |
| `/log` termination | Raw rejected rows exhaust `SCAN_HIDDEN` | A short page or null cursor can reveal a private stretch and falsely report the start |
| Session totals | Count after projection | Correct for retained rows, but shared pruning changes which readable rows survive |
| Session boundaries | Four-hour gaps after projection | Correct before pruning. Deleting readable endpoints can shrink, remove or split sessions |
| Export text, dates and filename | Projected retained rows only (`log.ts:175`, `:178`) | Inherits missing readable rows from pruning, not raw private timestamps |
| Ids and cursors | Raw `<seq>:<index>` survives projection | No newly introduced within-op gap for another audience under current numbering |
| Older stored ids | Pre-version-19 ids were numbered together (`tx.ts:242`) | Historical within-op gaps can remain. They do not prove a count of hidden archive lines |
| Global seq | Existing room sequencing is visible on the live protocol | Gaps across ops are not a log row count. Opaque HTTP cursors alone cannot hide them |
| Live and trap logs | Per-audience bounded rings. Trap logs are separate (`tx.ts:486`) | Not part of the room archive or its session count |
| Client history | `older` grows without bound and every row renders (`LogPanel.tsx:84`, `:151`, `:185`) | Raising storage alone eventually makes a phone slow |
| Export memory | Server builds a complete string. Client builds a Blob (`logExport.ts:116`, `ExportLog.tsx:71`) | Raising storage alone eventually makes both processes large |

The promise here is equality of archive responses for the same readable retained sequence and the same viewer projection context.
Adding, deleting or inserting lines outside that sequence must not change a count, page, cursor, session, filename or export body.
It is not a claim that the app hides global op sequencing, shared resource contention or wall-clock execution time.
The existing timing limit is documented in design.md 7.3. Do not describe this work as closing every application side channel.
Storage quota is another existing boundary: `roomStoredBytes` counts archive bytes (`server/assets/quota.ts:24`).
It can cause read-only mode (`server/rooms/actor.ts:2012`) or refuse a player's image upload (`server/assets/quota.ts:64`).
That channel must close in the same deployable stage as no-prune. Archive bytes leave upload and read-only decisions, but remain in admin size reporting (LOG-OPUS-01).

## 2. The leak fix

### 2.1 One reader for every archive route

Create one server-only history reader for pages, canonical session summaries and Markdown export.
Capture `{ state, seq }` once from `actor.committed`, plus authenticated member, role, scene and preview identity. Read only rows at or below that seq.
Project every batch with `projectArchivedLog(state, ...)` against that same immutable state. Database audience metadata is only a candidate filter.
Apply `previewOmits` before counts, grouping, continuations or rendering. Preview caches bind both selected player and requesting DM.
Players use the player scene. DM pages and exports remain all-scenes, as today's projector actually implements them. Export names come from the full captured DM state.
Remove `SCAN_HIDDEN` completely. A batch size bounds memory, never the extent of readable history. Stop only after filling the requested projected page or exhausting candidates.
A timeout or rejected admission is a request failure, never a successful short page or false end. Return no raw offsets, skipped counts, scanned ids or raw activity timestamps.
Before headers and between export batches run one uncached join of the captured session, its grant and room, requiring sessions.token_hash = capturedOriginalTokenHash, sessions.expires_at > now(), room-session purpose, current role epoch, and the exact member and role captured at admission. Never reuse the request-cached SessionStore.lookup result as this check.
At admission capture the authenticated cookie token's SHA-256 hash once, alongside session id. Keep it only in request-local server state, never in logs, response fields or summary caches. Do not replace it from a later session lookup or rotated session row.
Set `Cache-Control: no-store` on all archive responses. Cache hits consume the same fixed request allowance as misses.

### 2.2 Page and session contracts

`GET /log` accepts mutually exclusive `before` or `after`, numeric entry-id boundaries, and limit 1 to 100, default 50. Omitted direction means newest backward page.
Always return entries oldest-first. Fetch descending before a boundary and ascending after one. Comparisons are exclusive in both directions.
For nonempty results let `lo` and `hi` be their oldest and newest readable ids, and `full` mean returned count equals the requested limit:

| Read direction | nextBefore | nextAfter |
| --- | --- | --- |
| Backward, full | lo | hi |
| Backward, short | null | hi |
| Forward, full | lo | hi |
| Forward, short | lo | null |
| Either, empty | null | null |

A full page can offer a final empty page. Opposite-direction links may also reach an empty page. Neither requires a hidden-row lookahead.
On empty results the client keeps its prior window and reverse cursor, and marks only the attempted direction ended. It never replaces a readable window with an empty one.
Cursors name returned readable endpoints. Treat an arbitrary syntactically valid input id as a range boundary, with no existence probe or disclosure of whether that row exists.
Keep entry ids for merge, receipts, display ordering and HP Undo, and retain current audience number ranges. Keep `parts` and `copyOf` server-only.
Legacy within-op gaps and existing global seq remain explicit residuals. HTTP-only opaque ids cannot hide an already-visible live sequence.

`GET /log/sessions` accepts optional `before` and limit 1 to 50, default 25. Return `{ sessions, lines, nextSessionsBefore }`.
Each session is `{ firstId, lastId, from, to, lines }`, with first/last readable ids in numeric id order. `from` and `to` are display timestamps only.
`lines` at the response root always counts the whole readable retained archive, regardless of page boundary or limit. Session continuation uses the oldest returned session's firstId.
Keep the current strictly-greater-than-four-hours grouping after projection and in id order. Equal times and backward clock steps never reorder or drop rows.
Session exports use inclusive `fromId` and `toId`, both present with numeric fromId <= toId, or neither for Everything. UI keys use firstId and lastId, never timestamps.
Reject mixed id/time selectors or one missing id with 400. Timestamp-only `from`/`to` can remain a legacy filter for old clients, but is not the new session selector.
Filenames, titles and day headings use only projected entries. A fresh request captures access anew, and previously fetched rows grant no continued server access.

### 2.3 Scan admission (LOG-OPUS-02)

The existing 600/minute session HTTP limit remains (`server/auth/ratelimit.ts:27`). Add a dedicated GET /log bucket keyed by room and member, shared across devices and roles.
Choose burst 10 and refill one request per second. Charge one fixed token before scan admission, including cache hits. Never charge by rejected rows, bytes, CPU time or cache misses.
Allow one outstanding page request per member. Excess requests return 429 busy with Retry-After 1. Ordinary rate exhaustion uses 429 rate_limited with its calculated retry time.
Use two server-wide page/summary/backfill batch slots, separate from two export batch slots. Keep one export per room and the existing export/list hourly budgets.
Across both pools allow at most one active scan batch per room. A slot covers at most 500 source rows projected, then releases before the next batch or any client backpressure.
Schedule room queues round-robin, then member queues within a room. A continuing scan joins the back, so a flood cannot retain a slot across batches.
Bound waiting to 16 queued batch requests globally, two waiting user requests per room and one background backfill job per room. Wait at most 1 second for a batch slot, then fail 429 busy.
Foreground work precedes background backfill within a room, while other rooms retain round-robin turns. Cap a whole page/list request at 5 seconds and an export at 30 seconds.
Disconnects, room deletion, shutdown and deadline expiry remove queued work and cancel active queries. Releasing a slot must run in finally, including errors and cancellations.
Raw cursor leases are separate persistent admission resources: two page/summary leases and two export leases server-wide, with at most one lease per room in each pool. A retained cursor counts even between batches or during backpressure.
Queue lease requests fairly by room with an independent 1-second lease-wait deadline, then 429 busy with Retry-After 1. Cancel that wait on disconnect, shutdown, room deletion or request expiry. This deadline is separate from each batch wait.
Lease waiters share the 16-global/two-per-room queued-user-request cap, rather than opening an unbounded second queue.
Acquire a raw lease and open its cursor only while the request holds that room's admitted batch turn. If a connection or that room's lease is unavailable, release the batch slot immediately and fairly requeue until the lease deadline, without reserving a connection first.
A lease lasts until its cursor closes or the request ends. A batch slot lasts only through DECLARE or one bounded FETCH/projection quantum. Release batch slots between batches and during backpressure, and release leases/connections in finally on every exit.
A slot or lease failure after export headers aborts the transport, as below. Resource contention and elapsed time remain the documented general limits, not hidden-row success metadata.

## 3. History beyond 10,000

### 3.1 Retention, quota and disk admission (LOG-OPUS-01)

Use session-bounded retrieval over the existing indexed `room_log`. Stop count-based deletion from `writeSnapshot`, retaining present and future archived rows until room deletion.
In that same first stage exclude both `room_log` and `room_log_access` from upload reservation and room read-only calculations. Leave other quota components unchanged.
Keep both tables in admin physical-size reporting, with its hint distinguishing physical bytes from upload/read-only quota. Archive-only growth must not refuse a player's upload or make a room permanently read-only.
On acquisition, before exposing the actor or admitting any write, recheck a persisted quota-read-only room with the new archive-excluding formula, even with no pending ops or deletable assets. Recompute/clear only its persisted quota flag, then set effective readOnly = quotaFlag || replayFailed (`actor.ts:409`). Never clear replayFailed or bypass replay-failure protection. Keep this in stage A. Omit a startup sweep. Recovery runs on acquisition.
Reject keeping archives in quota, and reject a new per-room archive ceiling that prunes older rows. A DM clear-history-before-date control is a separate follow-up.

Extend the existing volume-wide free-space guard, currently used only by asset operations, to every archive insert path: batch commit, import, old-import repair and metadata backfill.
Use the existing 2 GiB floor (`server/assets/service.ts:83`), with an injected guard for tests. Check before each bounded archive write, not only before uploads.
When below the floor or a free-space check fails, skip that source/access insert batch, log an operator warning, and let ops, receipts, snapshots and bounded live rings continue under their existing commit rules.
Skip memberships with their source batch. Backfill denied admission leaves its rows incomplete and pauses. Never mark skipped rows complete or hold an unbounded queue of deferred log payloads.
This is an explicit disk-pressure exception to archive durability. A skipped line may survive in the live ring temporarily, but later archive completeness is not promised or fabricated.
Do not expose skipped-row counters, per-room archive quotas or pruning notices to viewers. The admission decision reads free disk, never hidden-row counts or per-room archive bytes.
Use the existing guarded asset volume as the deployment's shared-storage free-space signal. Verify the database and asset volumes share its backing storage in deployment validation. Separate-storage installs require a guard for the database volume before this feature is enabled, not an assumption that asset free bytes measure another disk.
The guard leaves headroom, not a guarantee that the database can keep writing on a physically full device. Do not swallow arbitrary SQL failures or change commit-outcome retry handling into silent skips.

At 200,000 entries, 512 bytes each is about 98 MiB, 1 KiB each about 195 MiB, and 8 KiB each about 1.53 GiB before tuple/index overhead.
Budget another 40 to 100 MiB for tuples/indexes in the small-entry case, then measure. These are sizing cases, not measured database sizes or a storage promise.
Whisper access rows multiply by unique sender/recipients, up to the member limit. No cold table, archive eraser or reducer ring increase is introduced.
Residual LOG-OPUS-18: one member can grow authored history until the shared disk floor pauses archive inserts and image uploads in other rooms. A separate follow-up will design a per-member budget on caller-known authored archive bytes plus an admin warning. Never charge all rows an op produces, since those can include hidden lines and audience copies. This budget and warning do not ship in this design.
No new archive-wide read belongs in ordinary boot or room acquire. Previously pruned rows are not reconstructed from gaps. Full database backup is their recovery source.
The room ZIP contains only the bounded in-memory log. Moving a room by ZIP does not carry its full archive. Session Markdown exports history, and full database backup preserves the SQL archive.

### 3.2 Candidate streams and receipts

Add server-only nullable `seq bigint` and `line_no integer` to `room_log` for old rows, with no non-null defaults at cutover.
Add `room_log_access(room_id, stream, member_id, seq, line_no, id)`, foreign-keyed to `(room_id, id)` with delete cascade.
Its primary key is `(room_id, stream, member_id, seq, line_no)`. Only shared and DM streams use member_id = ''. Source JSONB stays authoritative.
Use shared, dm, party and whisper streams. Party copies name their one reader. Whispers get one access row per unique sender/recipient. DM originals never duplicate party copies into the DM stream.
Derive candidates from `lineAudience` and `whisperParties`, including conservative old-row classification, not today's sight. Always run the current shared projector afterward.
Numeric columns and every required membership for one source row become complete atomically in one transaction. A non-null seq is a row-level completeness invariant, not merely a parsed number.
New writes and retries insert/repair memberships and numeric columns together. Never publish a non-null seq before all memberships exist. Reconcile conflicts idempotently.
Do not add `room_log(room_id, seq, line_no)`. Receipt fallback reads the caller's stream prefixes plus seq in the access primary key, joins source ids through the existing source primary key, then projects.
Before metadata readiness, receipts use the complete raw seq query. Keep caller-owned receipt authorization and capture one projection state. Removing a redundant index must not lose receipt rows.

### 3.3 Migration and rollback (LOG-OPUS-03, LA-ASTRA-01/02)

Follow `db/schema.sql:1` and `server/db.ts:58`: idempotent statements, new columns in separate ALTER TABLE ADD COLUMN IF NOT EXISTS statements.
Boot SQL creates nullable columns and the empty access table/indexes, never backfills or creates an index over populated room_log.
After the server starts, a separately owned migration worker builds `room_log_unindexed_room` CONCURRENTLY on room_log(room_id) WHERE seq IS NULL, outside schema.sql and any transaction block.
Serialize DDL with an advisory lock on its dedicated connection. Check pg_index.indisvalid after creation. An interrupted invalid index is dropped CONCURRENTLY and rebuilt. An absent index is created, a valid one reused.
Do not trust IF NOT EXISTS to repair an invalid index. Stop retrying on shutdown, release the connection/lock, and retry recovery on the next startup. This worker never delays listen or health readiness.
Before each indexed page, summary, export or receipt read, check `exists (select 1 from room_log where room_id = $1 and seq is null)` using that partial index.
If any source row is incomplete, use the complete raw reader for that request. A stored per-room complete flag can be a hint only, never the authority.
Until the partial index is valid, use the raw reader and queue the completeness check/backfill work outside the request. The row invariant makes a later upgrade detect writes made by the stage-1 rollback binary.

A history request only signals lazy backfill and immediately continues with the raw reader. Backfill runs outside that request, one deduplicated job per room under a PostgreSQL advisory lock.
Count its batches against the page/summary scan pool and shared room exclusion. Keep one dedicated session connection for the advisory lock, bound server-wide to one backfill worker, and release it on cancellation, shutdown or room deletion.
Read incomplete rows in bounded batches of 500. Validate the existing id grammar in TypeScript, then transactionally write memberships and numeric columns. A failed or disk-denied batch leaves seq null.
No permanent forward checkpoint may skip rollback-period rows. Revisit the partial index until none remain, including rows from concurrent legacy writes. A completion hint cannot suppress the null-row check.
Malformed ids stop that room's backfill with an operator error and leave the complete raw path available as far as its existing parser permits. Never silently exclude the malformed portion as indexed history.

Drop the proposed import-seeding marker. Preserve today's any-matching-seq-0 or at-old-cap guard with `LEGACY_LOG_STORED = 10_000` in persistence.ts. It is historical evidence, not current retention.
Keep the existing all-rows-deleted old-import repair test. Describe partially missing seq-0 rows as simulating pre-cutover pruning, including the comments in export.itest.ts:1002 and persistence.ts:80-83.
Remove LIMITS.logStored and update its references. No op, snapshot or room-export version bump: the reducer and RoomState do not change.
Migration is additive and resumable. Rollback may leave new structures unused, but only to the first stage below, never the old pruning binary. Do not drop source history or restore pruning as a rollback step.
Test upgrade, full backfill, rollback writes with null numeric columns, and upgrade again. The null-row check must select complete raw history until the missed rows are indexed.

## 4. Speed and queries

### 4.1 Bounded reads and summaries

For each eligible stream, read by its primary-key prefix, exclusive numeric boundary and captured high-water seq:

```sql
select id, seq, line_no from room_log_access
where room_id = $1 and stream = $2 and member_id = $3
  and seq <= $4 and (seq, line_no) < ($5, $6)
order by seq desc, line_no desc limit $7;
```

A player merges shared, their party and their whisper streams. A DM merges shared, dm and their whisper streams. Receipts add equality on seq instead of a page boundary.
Fetch at most 500 candidate ids per stream, merge numerically, and join at most 500 consumed source rows per scan quantum. Buffer overfetch or advance only through consumed candidates.
Projection rejection advances only the internal scan key. Only readable endpoints become outward cursors. Forward reads reverse comparison/order. Never use OFFSET for archive pages.
The raw fallback preserves numeric-expression ordering, but uses a bounded PostgreSQL cursor: one ordered scan/sort per pass and FETCH 500, not a full-room sort for every batch. This is required in stage A, not postponed to metadata.

Fold the whole readable summary list once per captured context, then slice pages from that canonical result. Root lines counts the whole readable archive, never a selected session page.
Cache keys include room, seq, member, role, scene/preview identities, not before or limit. Normalize/validate page parameters before slicing. Both request orders for limits 1 and 50 must work.
Keep at most eight canonical entries with a combined 1 MiB retained budget. Session records carry firstId/lastId, times and count, not payloads.
If one canonical list exceeds the byte budget, do not cache a partial list or allocate without bound. Finish a streaming fold retaining only the requested summary slice and total, and allow an uncached repeat on later requests. An overflow slice is request-local and never shared for another boundary or limit.
Every listing page and export remains charged by the existing hourly rule, independent of cache hits. Canonical cache reuse removes repeated scans for ordinary lists, not request charging.
Exact totals and pathological current visibility remain O(N) on a miss. Benchmark them explicitly. Do not restore a rejected-row cutoff to meet a latency target.

### 4.2 Streaming export and failures (LOG-OPUS-04/13)

The first deployable correctness stage removes readWholeLog and the full projected-log cache, installs the bounded summary fold and streaming formatter, and is tested alone as the rollback binary.
Find first and last readable entries without collecting payloads, then stream the existing title, headings and lines in a second bounded pass over the same captured state/seq and inclusive id range.
Keep one formatter context, release scan slots between batches and obey backpressure. Indexed reads release query connections before waiting on the client. Raw fallback uses the four dedicated connections and separately admitted, per-room-limited leases in section 2.3, apart from the actor pool. Cursor lifetime can span batch turns and backpressure, but never escapes lease accounting, cancellation or request deadlines. This explicit raw-path exception avoids buffering the archive or repeated full-room sorts.
The uncached session/grant/room join requires sessions.token_hash = capturedOriginalTokenHash and checks natural session expiry, sign-out, grant removal, room deletion and role/member replacement between batches. Rotation can preserve session id and the exported room's grant (`server/http/dm.ts:117`, `server/auth/sessions.ts:174`), so identity and epoch alone are insufficient. Keep the original token hash fixed, without refreshing expiry. Before headers return the ordinary authorization error. After headers use transport abortion below.
Run that join as a separate autocommit statement on the ordinary auth pool, never inside the raw cursor transaction, where now() would remain anchored to transaction start.
After headers, any query, authorization, admission or formatting failure destroys the reply stream/connection without the final chunk. Omit Content-Length. Never append an error as valid Markdown or cleanly end a truncated file.
The fetch must reject, or the browser must mark a native download failed. Disconnect cancels both passes, database queries and queued work. Test failure after at least one body chunk.
Small client exports retain Save or share. Read the body incrementally with an 8 MiB ceiling before Blob creation. At overflow cancel and offer native Download, which is another charged request.
An upfront native Download remains optional for every range. Line count is not a byte estimate. Do not auto-select it from a count threshold or claim the aborted attempt was uncharged.
The standard room ZIP remains bounded RoomState only, not the SQL archive. State this plainly in the DM guide after deployment.

### 4.3 Builder benchmark, not measured results

Seed 200,000 rows through production archive helpers with ten players, two DMs, one mixed-role member, real events, copies and 4 KiB whispers, then ANALYZE.
Use all-public chat, 90% nonrecipient-private rows, 199,900 contiguous private rows, and 199,900 currently unreadable shared events. Include one huge session, 200,000 tiny sessions, equal times, backward clocks and seq-0 imports.
Record actual tuple/index bytes, candidate rows and calls, peak heap/RSS, event-loop delay and request latency. Capture EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS) for access reads, joins, null checks, fallback and receipts.
Separately run first schema application against a populated 200,000-row table spread across rooms. Measure boot/listen, concurrent writes, partial-index build, lock waits, interrupted-build recovery and the first background backfill.
Use 30 samples after five warmups and a separate cold-process run. Record versions/hardware and admission load. Do not clear shared machine caches.

| Operation | Acceptance target, excluding network transit |
| --- | --- |
| Indexed 50-line page, including private run | Warm p95 <= 100 ms, cold <= 250 ms, no full-room sort |
| Pathological narrowing or first exact-total listing | Idle <= 2 s, event-loop delay p95 <= 20 ms, no false end |
| Cached summary page | p95 <= 100 ms, at most 25 summaries by default |
| Export | First body byte idle <= 2 s, <= 30 s local total, incremental heap <= 16 MiB |
| Ordinary archive write | Added warm p95 <= 20 ms per representative batch |
| Normal startup/acquire | No new archive-wide read, <= 5% regression against same snapshot at 10,000 rows |
| First application/index recovery | No populated-table index in boot transaction, concurrent writes progress, all incomplete rows remain readable |
| Two flooding members in room A, page in room B, plus slow export reader | In stage-A raw mode A owns at most one lease per pool, B gets a fair batch/lease within their separate 1 s bounds, backpressure retains no batch slot |
| Phone navigation | At most 500 rendered rows, <= 50 ms main-thread task under existing phone CPU fixture |

The idle two-second worst-case allowance is explicit. This design does not promise constant-time current-visibility paging. A failed target blocks performance sign-off, not correctness by truncation.

## 5. The parts: feature-run ownership

### 5.1 Server A, correctness and quota, first and independently deployable

Own `shared/limits.ts` and `shared/limits.test.ts`, `server/assets/quota.ts` and its unit test, `server/assets/service.ts`, `server/assets/cleanup.ts` and its itest, `server/http/admin.ts` and its itest, and `scripts/admin.ts` for physical-size versus quota wording.
Own `server/app.ts`, `server/rooms/manager.ts`, `server/rooms/actor.ts` and its unit tests, `server/rooms/testing.ts`, `server/rooms/persistence.ts` and its unit test, and new `server/rooms/logArchive.itest.ts` for guard/commit coverage.
Own `server/http/log.ts`, `server/http/logExport.ts` and its unit test, `server/http/log.itest.ts`, `server/http/logExport.itest.ts`, `server/http/export.itest.ts`, new `server/rooms/logHistory.ts`, and new `server/rooms/logScanBudget.ts` with its unit test.
Ship no-prune, quota isolation/recovery, archive disk admission, frozen raw-reader projection, fair admission, bounded canonical summaries, id session ranges and streamed exports together. This binary must work without metadata tables.
Correct comments in log.ts:20-21, :37-49, :63, :75, :87 and persistence.ts:80-83, :302-305, plus export.itest.ts:1002, server/http/admin.ts:40/:73-74 and scripts/admin.ts:182-183. Update size versus admission descriptions. A owns acquisition-time quota recovery and the uncached export authorization helper in its history reader.
Extend app/actor/import wiring only through the owned interfaces. `server/rooms/importRoom.ts` belongs to A for disk-guard coverage of its existing archive write, with `server/rooms/importRoom.test.ts` for focused verification.

### 5.2 Server B, metadata, strictly after A

Own `db/schema.sql`, `server/db.ts` and its unit test, `server/main.ts`, `server/shutdown.ts` and its itest, new `server/rooms/logHistoryMigration.ts` with unit/itest files, and new `server/http/logHistory.test.ts` for indexed/fallback agreement.
After A's exact commit handoff, B takes `server/app.ts`, `server/rooms/persistence.ts` and its unit test, `server/rooms/logHistory.ts`, `server/http/log.itest.ts`, `server/http/logExport.itest.ts` and `server/rooms/logArchive.itest.ts`. Never edit these concurrently with A.
B also owns `server/http/receipts.ts`, `server/rooms/receipts.test.ts`, and new `server/http/receipts.itest.ts`, plus `server/http/admin.ts` and its itest after A for access-table physical-size reporting.
Implement atomic source/membership completion, post-boot concurrent partial-index creation/recovery, fair advisory-locked background backfill, null-row checks on all indexed reads, and access-prefix receipt lookup.
No full numeric source-table index, import marker or trusted completeness flag. Wire worker lifecycle, disk guard and shutdown cancellation through the handed-off interfaces.

### 5.3 Client and post-deploy docs lane

Own `client/panels/LogPanel.tsx`, `client/panels/olderLog.ts`, `client/features/log/ExportLog.tsx`, `client/features/log/exportLog.ts` and its test, `client/lib/api.ts` and its test, and a new history-window helper with its unit test.
Own `e2e/tools.e2e.ts`, `e2e/alignmentRoom.ts`, `client/features/admin/api.ts` and `client/features/admin/RoomsCard.tsx`. Correct olderLog.ts:7-8, api.ts:73 and its session/export type docs, exportLog.ts:38/:56, admin/api.ts:15 and RoomsCard.tsx:29. The admin hint must distinguish physical archive-inclusive size from upload/read-only quota.
Keep live view as today. Browsing history renders/retains at most 500 rows with Show older, Show newer and Back to latest. Handle an empty live tail in the owned helper without changing shared/logText.ts.
Keep only the current bounded window, discard wrong-room/viewer/scene/preview replies, and preserve reverse navigation when an attempted page is empty.
Page 25 sessions using canonical summary slices and firstId/lastId keys/ranges. Preserve total lines and the 8 MiB share/native-download behavior. Older sessions requests count against the same hourly budget.
This lane owns staged updates to `FEATURES.md`, `docs/dm-guide.md`, `docs/design.md` and `docs/design-v1-dm-tools.md`, plus this note when the coordinator moves it. Publish those files only after deployment, never in pre-deploy public commits.
Replace stale archive cap/cache/scoping text in design.md:1285/:1852 and dm-tools.md:535/:540/:883/:886, and explain bounded room ZIP versus full archive backup. Every expected file belongs to a lane, not an unowned integration step.

### 5.4 UI checklist

- Loading: retain rows, delay the shared indicator about 200 ms. Keep Loading..., Finding the sessions..., Preparing the log..., with existing ellipsis typography in code.
- Words: Show older, Show newer, Back to latest, Older sessions, This is the start of the log, Could not load older messages. Large file: This file is large. Use Download to save it. Download uses another export request.
- Native 44 px buttons, 16 px inputs and bottom sheets. Keep focus on navigation, preserve the anchored readable row, and focus the composer only after explicit Back to latest activation.
- Name the list Log history. Announce completion politely without raw offsets or hidden counts. Errors use the existing alert component. Backward timestamp labels may run backward, but keys and export selection must stay correct.
- Sweep live/history/export, loading/error/long labels/large download, and the admin Rooms size hint at 1440x900, 390x844 and 320x568, 100% and 130%, adding roots if missing. The client lane owns admin hint wrapping/accessibility verification using the same browser alignment tooling. No discrepancy over 1 px.

### 5.5 Verification and mutations

| Case | Expected | Test |
| --- | --- | --- |
| More than 10,000 private rows, snapshot, reload | Nonreader's readable history/count/endpoints persist | Postgres itest per DM, player, whisper sender, recipient and nonparticipant |
| Hidden runs at 0, 999, 1,000, 1,001, 1,100 and 20,000 | Every readable row reachable, no secret-dependent termination | Paired paging itest, fixed ids/times, no socket flood sleeps |
| Count versus all pages and exports | Root total and session counts equal deduplicated current projection | Itest including mixed-role member and preview |
| Archive-only bytes, persisted quota-read-only room unloaded with no deletable assets or pending ops | Acquisition clears only quota flag before write admission, replayFailed still blocks, upload unchanged, admin physical size includes both tables | A actor/manager acquisition itest, replay-failure pair, quota/assets/admin itests |
| Low disk, guard error, recovery, SQL failure and unknown COMMIT | Archive/access inserts skip only on guard, live commits work, warning logged, ordinary failure/retry rules remain | Injected guard and recording pool plus commit itest |
| Two members flood room A in stage-A raw mode, B requests page/export in room B, and one A export consumer stalls | Fixed charging, A cannot pin both connections in either pool, separate 1 s lease/batch waits, no batch slot held under backpressure, cancellation releases leases | Fake-clock admission unit and barrier-controlled raw-mode Postgres itest, including incomplete metadata fallback |
| Backfill complete, stage-A rollback writes, re-upgrade | Null-row check forces complete raw reader until atomic repair | Postgres upgrade/rollback/upgrade itest |
| Partial membership write, duplicate retry, interruption or disk-denied backfill | Source seq stays null unless every access row commits | Transaction-fault itest and metadata invariant unit |
| Stage A alone with 200,000 rows | No whole-log cache or unbounded payload list, summaries/export bounded without metadata | Independent A integration/heap benchmark before B |
| Interrupted concurrent index, restart, writes in another room | Invalid index rebuilt, boot/writes progress, no missing reads | Migration itest and first-application benchmark |
| Times 10:00, 16:00, 09:00 and overlapping time ranges | Session ids select exactly their rows and UI keys stay distinct | Production-grouper unit, route export itest and client label/key test |
| Canonical summary cache, limits 1 then 50 and 50 then 1 | Correct slice/cursor, unchanged whole-archive total and per-request charge | Unit and listing itest, including 1 MiB overflow fallback |
| Seven readable ids, forward/backward full/short/empty pages | Exclusive boundary both ways, opposite cursors per table, empty result retains window | Two off-by-one assertions each direction plus client unit |
| Concurrent commit and sight/owner/scene/blackout changes | Frozen projection per request, new requests recheck | Barrier itest and visibility units |
| Token rotation, natural expiry, sign-out, or role/member change after first export chunk | Uncached token-bound live-session join rejects before another chunk, aborts without final chunk and releases leases/slots | A streamed-export itest rotates after first chunk while session id, exported-room grant, member, role and epoch stay unchanged. Also test expiry/sign-out/role changes. Removing only the token_hash predicate must fail the rotation test |
| Random audiences, live-ring prunes, snapshots and batch sizes | Retained archive/page/count/export agree, private additions change no readable response | 20 seeds x 2,000 reducer operations, independent array oracle |
| Abort, late answers, identity change, repeated window moves | No stale merge, duplicates, lost anchor or unbounded cache/DOM | Seeded randomized client unit, tools e2e for changed screens plus reach |

Mutation-check removing projection, pre-projection counts, restored prune/cutoff, leaked scan cursor, missing role, mixed-state batches, missed/duplicate whisper membership and an unbounded window.
Also kill quota including archives, missing disk guard, monopolized batch/lease admission, skipped acquisition quota recheck, cleared replayFailed, cached, expiry-blind or token-rotation-blind export checks, trusted completion flag, non-atomic seq completion, ignored invalid index, timestamp session selection and cleanly ended failed export.
Builders run their required lane checks and report exact commits and actual outcomes. The revision-2 backward-clock reproduction remains source-function verification only. Revisions 3 and 4 ran source/document checks, not implementation, database, migration or performance tests.

## 6. Decided

| Id | Chosen | Rejected and why |
| --- | --- | --- |
| D-261030-470 | Direct raw-count allegation is stale, fix retention/scan termination | Calling today's projected counts raw misstates the bug |
| D-261030-471 | One archive, bounded pages and viewer sessions | Higher caps delete history. A cold table adds moves and unions |
| D-261030-472 | Archive/access outside admission quota, inside admin physical size, disk-guarded writes and quota recovery on acquisition before write admission in A | Quota lock-in, replayFailed clearing and count-based pruning are rejected. Clear-before-date and caller-known authored-byte budgets/admin warning are follow-ups |
| D-261030-473 | Indexed audience candidates plus current projector, access-prefix receipts, atomic completeness with null-row fallback | Raw counts, frozen rendering, redundant numeric index and trusted flags can miscount or omit rows |
| D-261030-474 | No hidden-row stop, fixed-cost member budget, fair batch and raw-lease admission, one lease per room per pool, independent export capacity and separate 1 s waits | Secret-density cutoff, work-dependent charging, pre-turn lease acquisition and unaccounted persistent cursors can leak or starve other rooms |
| D-261030-475 | Frozen state/seq, id ranges, canonical summaries, uncached live-session/grant/epoch/room join requiring the original admission token hash and captured member/role between export batches | Mixed states, timestamp ranges, page-sized keys and cached, expiry-blind or rotation-blind authentication give stale checks |
| D-261030-476 | Preserve ids/visible times and document legacy/global-seq residuals | HTTP-only opaque ids break merging without hiding the live seq |
| D-261030-477 | 500 rendered rows, 25 sessions, 8 MiB Blob ceiling and optional native download | Unbounded client memory and line-count byte guesses are unsound |
| D-261030-478 | Feature-run A correctness/quota/streaming rollback, B atomic metadata and post-boot concurrent index recovery, lazy fair backfill, no import marker | A no-prune binary with full-log cache is unsafe. Boot index builds, partial lane ownership and extra import state add risk |
| D-261030-479 | Every list/export request charged independently of cache, room ZIP keeps in-memory log only, guide states archive backup separately | Cache-dependent charging leaks activity. Expanded ZIP format or allowances are outside this feature |

Revision 4 follows the coordinator's round 1 through round 3 dispositions. LOG-OPUS-18 remains an explicitly named follow-up. These records do not assert owner approval or review consensus.

## 7. As built

Server A and server B shipped first, by `ff48d3ef`, and the client lane after them. No op, snapshot, protocol or room-export version changed.

### 7.1 Server A, correctness and quota

- No-prune: `writeSnapshot` no longer trims `room_log`. `LEGACY_LOG_STORED = 10_000` in persistence.ts keeps the old-import repair guard, and `LIMITS.logStored` is gone.
- Quota: `ROOM_QUOTA_BYTES_SQL` (server/assets/quota.ts) leaves `room_log` and `room_log_access` out, and upload reservation, the actor's quota check and cleanup's recheck all read it. The admin page and the CLI show size on disk as the quota sum plus the archive and its access rows. The admin listing also counts `roll_receipts`, which the quota counted and the listing had missed, so size on disk is exactly the quota sum plus the archive.
- Acquisition recheck: `RoomActor.load` measures a stored quota-read-only flag again before it builds the actor and clears only that flag. Effective read-only stays the flag or a replay failure.
- Disk guard: `ArchiveGuard` (persistence.ts) runs on every commit attempt, the import's archive write and the old-import repair, on the asset volume's 2 GiB floor, and a failed check counts as no. A refused batch commits its ops, receipts and watermarks without its log rows. Its operator warning is throttled to once a minute per room, with the count of refused writes since the last.
- Reader (`server/rooms/logHistory.ts`): one captured `{state, seq}` per request, rows at or below that seq only. A raw pass runs a REPEATABLE READ READ ONLY transaction with a cursor over ids, sorted once per pass, FETCH 500, entries read by primary key per batch and projected against the captured state. There is no hidden-row cutoff. Session lists fold once per view into an LRU of eight lists within 1 MiB, keyed with a serial of the committed state object, so a reload at the same seq never reuses a list. Two listings of one list at once fold it once. A list too large to keep is folded each time into a ring of the sessions the page needs.
- Admission (`server/rooms/logScanBudget.ts`) follows 2.3 with these deviations. A lease is taken in the same dispatch as a turn, so a scan that needs a lease is admitted only when both are free, which holds no turn while waiting, as 2.3 asks. Continuing scans that already hold a lease are not counted against the 16 and 2 waiting caps, since counting them would let waiters fail a scan mid-way. A deadline or a cancellation answers 503 busy with Retry-After 1, while admission answers 429 busy. One page lease per room means two members' pages in one room run in turn, the second waiting up to 1 s. An export keeps its one lease across both passes. The page bucket lives in memory per server process.
- Connections: the scan pool watches client errors idle or checked out, a checkout races the abort and a late connection is destroyed, a refused checkout frees the turn and retries every 50 ms until its 1 s, and an aborted scan cancels its backend's query (`pg_cancel_backend`, bounded at 1 s) before the connection is dropped without a rollback.
- Measured on a development machine with other work running, stage A alone at 200,000 rows: a newest 50-line page p95 42 to 63 ms, 1,061 ms with 199,900 hidden rows above the readable ones and no false end. A first exact-total listing p95 0.78 to 1.30 s, a cached page under 0.1 ms, export first byte 0.66 to 0.90 s and total 1.5 to 2.2 s, event-loop delay p95 11 to 12 ms, and at most 0.86 MiB held at once with a full collection at every batch. The cold-process run, the hidden-event and seq-0 import cases and the EXPLAIN captures were not run.

### 7.2 Server B, metadata

- Schema: nullable `seq bigint` and `line_no integer` on `room_log`, and `room_log_access` with the primary key of 3.2. Its cascade index is `(id, room_id)`, id first: led by `room_id`, the planner chose it for a room newer than the table's statistics and sorted the whole room for every stream read. An itest asserts no non-primary index on the table leads with `room_id`.
- Writes: `archiveLines` writes the source row, its numbers and all its access rows in one statement, atomic even outside a transaction. Only the reducer's canonical ids get numbers (`05:7` would collide with `5:7`), and any other stays null and keeps its room on the raw reader.
- The worker (`server/rooms/logHistoryMigration.ts`) builds `room_log_unindexed_room` concurrently after listen under an advisory lock, reuses a valid index and drops and rebuilds an invalid one, and backfills a room only when a read finds it incomplete, in batches of 500 under a room advisory lock and the disk guard. It reads the index's validity once when it starts, so an index dropped while the server runs leaves reads correct but slow until the next restart (follow-up LOGB-OPUS-3).
- Receipts: one captured state for every part, then the access-key lookup or the raw seq query on one bounded connection (1 s checkout, 5 s a query and a request).
- Boot measures `DATABASE_DISK_DIR` once and refuses to start when it cannot.

### 7.3 Client

- `client/panels/historyWindow.ts` holds the Log panel's window and its one request at a time. While the window meets the live log ("live"), its archive rows sit above the live log, and lines the live log drops off its front are kept from the first Show older on. The window holds at most 500 rows with the live view counted, trap lines among them. Past that, new live lines push the oldest held rows out, and a page that would push the live log out parts the window from it ("history"): its oldest 500 rows stay, and Show newer and Back to latest come. The live view alone, before any Show older, is as before.
- Kept lines are the room log's alone: a trap line that leaves its own ring leaves the window too, since trap logs reach no archive and a trap line can never be a cursor.
- A live log that jumps past every line the panel held, as after a long time offline, parts the window rather than join two stretches with an unknown gap between them, and so does a live log that fills again from empty beside held rows, since its first line looks the same whether it follows them or not. Show newer then reads up to the live log.
- The row at the top of the reader's view is held in place whenever rows go in or out: for a page, for new live lines that push held rows out, and for a jump that parts the window. The panel notes it with the rows it was taken among and puts it back only once those rows have changed, since a commit that draws only the new live lines can come first. New live lines take no anchor from a reader at the end or one who just sent, who follows them to the bottom instead, so a message sent from mid-list shows.
- A page lands only if it answers the request still waiting, from the edge the window still has. Back to latest and a new room, viewer or preview abort it, and so does a new scene for a player or a previewed player, whose lines depend on the scene on screen. A DM reads every line whole on any scene, so a DM's window stays across scene switches. The scene still goes to the route as before only for a DM's own pages. and a page from an edge the live log moved is dropped and the button armed again. An empty page keeps the window and its way back and ends only its own direction.
- Show older shows whenever the room has loaded, also with an empty live log, which then asks for the newest page. Sending a message from a parted window goes back to the latest.
- Focus stays on the button pressed. When Show older gives way to "This is the start of the log." that line takes the focus, and when Show newer goes Back to latest takes it. Back to latest focuses the message field. The list is named "Log history" while the window is parted, else "Log". A status line says "Older messages loaded.", "You reached the start of the log.", "Newer messages loaded." or "No newer messages.", never a count. A failure says "Could not load older messages." or "Could not load newer messages.", with the server's own words after it except for busy, and "Check your connection." for no answer.
- LOG-OPUS-19: a 429 busy from `GET /log` waits out its Retry-After, at most 5 s, and asks once more (`client/panels/olderLog.ts`). A 503 busy is not retried, since it follows a 5 s deadline.
- Export: sessions are keyed and exported by `firstId` and `lastId`. Older sessions, a row before Everything, reads the next 25 before the oldest held. Everything counts the newest answer's `lines`. The file is read a chunk at a time and cancelled past 8 MiB of body, before any Blob is made, and then its row says "This file is large. Use Download to save it. Download uses another export request." with a link to the export route, which the browser saves itself. The note scrolls itself into view, so Download shows whole on a phone. A body that breaks off is an error ("The file stopped before its end."), never a shorter file. No upfront native Download is offered: Export already saves a small file at once, and an extra button on every row would crowd a phone's sheet.
- The admin Rooms card says: "A room's size is what it takes on disk: every image it holds and its whole log. An image two rooms share counts in both. Its storage quota, which can stop uploads and make the room read-only, leaves the log out." Measuring the card at a phone's width found a room's Pinned and Read-only tags wrapping alone under its buttons, at half their height, so the tags now take a line of their own above them.
- The Log's top controls keep their layout from before this work. On a narrow phone at a large interface size Chat only stands under Show older and Export, and the alignment sweep measures the list, Show older and the row under a parted window rather than that row.
- Tests: a seeded randomized unit of the window (60 seeds of 400 events: older and newer pages, Back to latest, viewer changes, live growth with jumps past the ring, a live log that empties and fills again, trap lines, failures, late and foreign answers), checking order, no duplicates, the 500-row bound, one unbroken run of the viewer's readable lines, the start said only at the start, the anchor row kept and empty pages changing nothing, plus fixed cases for each rule. 33 mutants of the window, the busy retry, the 8 MiB ceiling and the session keys were killed. The phone navigation target of 4.3 was not benchmarked.
