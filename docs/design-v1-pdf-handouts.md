# raccoon-vtt v1: PDF handouts

Status: draft 3, after design review round 2. Round 1's three reviewers found four P1s and many P2s, most of them sharing three roots. Every finding was adopted, P3s included, and each root is answered by one model: the upload job (4.1), rendering safety (4.2) and the viewer's controls and identity (5.1). Round 2 found three P2s and ten P3s, each fixed as a class: an `unknown` answer is checked only against a fresh snapshot, the page buttons step by the view's position, and Cancel waits a bounded grace. Section 15 maps every finding of both rounds to the rule that answers it. The project owner's decisions are in section 14. Code is cited from public main `e4ec8696`, after the bar dock and the session 1 feedback wave, where the handout viewer of docs/design-v1-layout-hierarchy.md section 5 is built. This design builds on that viewer and adds no second one.

The project owner asked on 2026-10-15: "also how complicated would be adding pdf support to handouts?" Of three ways offered, the project owner chose the first: the DM's browser turns each PDF page into an image with pdf.js and uploads the pages as ordinary images, so the server stays images-only. Then: "would handouts be shown as pages one after the other from the pdf, as opposed to multiple handouts? id prefer if they could be viewed/scrolled as if they were still a pdf but just faked (dont need ocr i just want the interaction to be pdf-like)".

Settled before this design:

- One handout per PDF, holding all its pages in order. Never one handout per page.
- The viewer behaves like a PDF reader: the pages stacked top to bottom in one scrolling document with a gap between them, a page indicator, zoom over the whole document (pinch, wheel, double tap, and buttons and keys), and panning when zoomed. No text layer, no OCR, no search.
- `pdfjs-dist` (Apache-2.0) renders in the DM's browser, loaded only when a DM picks a PDF. The upload route stays images-only: it sniffs magic bytes, converts to WebP and caps the long side at 2048 px. Each page uploads as an ordinary handout image.

Sizes are layout px, as in the other v1 designs. A number given as "about" or "for example" illustrates a rule and is not the rule, so later layout changes do not make this document stale. Times depend on the device and the link, and are given only as rough examples.

## 1. Summary

- **Model.** A handout gains `pages`: its images in order, each with its size. A handout without it is one page, as every stored handout is. The DM's library gains documents (`handoutDocs`), each a title and its pages, kept until the DM deletes it and held only in the DM's projection. Two new ops save and delete one. `handout.show` can take pages in place of one image. Old rooms, old ops and old exports read as before. Rolling back to an older build means restoring the backup taken before the update.
- **The upload job.** "Upload a file" in Show a handout takes an image or a PDF. A PDF opens in its own block in the DM panel's Handouts section, with a page range (all pages by default, at most 100) and a title from the PDF. Its pages are drawn and uploaded one at a time with "Preparing page 3 of 12". The job lives outside the form, so the form keeps working and closing the panel keeps the job. Pauses and stops are badged, and toasted while the block is out of sight, and every stop has a way on. The job deletes only images it made itself, records them on the device so an interrupted upload can be cleaned up exactly, and saves its document under an id it chose first, so a lost answer is checked against a fresh snapshot rather than guessed. Its uploads share the table's one upload slot with other devices, and Cancel waits a bounded grace for a page in flight.
- **Rendering safety.** pdf.js runs only in a native worker the job starts and ends itself, with no main-thread fallback. The image decoders that scanned PDFs need are loaded and checked before any page draws, and a page whose image could not be decoded fails rather than uploading blank. The document's caches are cleaned between pages. Tests assert pixels, not only that a render resolved.
- **The viewer.** The handout viewer from the session 1 build, given every page: one column fitted to the width, zooming out as far as a whole page and in to 6 times. Previous page and Next page buttons sit beside "3 of 12". A finger drags with a fling, the wheel scrolls, and PageUp, PageDown, Home, End, Space and the arrows move through it. Pages load near the screen in boxes of their known size, with a low-resolution copy first when the full one is slow. Loading and failure controls draw in screen pixels. The viewer knows which showing it shows, keeps the reader's place and page, and starts fresh only for a new showing.
- **Download** builds a PDF in the browser from the page images, with about 120 lines of our own code and no new dependency. It shows its progress with a Cancel, and one build runs at a time. A one-page handout saves its image as today.
- **Table display.** One page at a time, fitted whole, with "Page 2 of 5" under the title. The page keys step pages, and a tap shows a bar with Previous page, Next page and Close over the page.
- **DM side.** The Library lists a document as one tile, its first page with a "12 pages" tag. A tap opens it in the viewer, whose header holds a two-tap Delete that removes its pages too (8.4). A document counts as showing only when a handout shows exactly its pages in order. Show a handout lists documents first and shows the whole document.
- **Security.** pdfjs-dist pinned at 6.3.289, which has no eval code path left, under a CSP that forbids one anyway. No WebAssembly, scripting or XFA, and no annotation or text layer. Nothing is fetched for the document. The two image decoders ship with the app and load from its own origin.

## 2. Today

- **A handout** is `{ id, rev, assetId, title, to, shownAt }` (`shared/model.ts:1240-1247`). It exists only while shown: `handout.show` writes it, showing it again updates it in place with a new `shownAt` (`shared/reducer/misc.ts:19-33`), and `handout.close` deletes it (`:35-38`). Both ops are the DM's (`shared/permissions.ts:334-335`), and the shown image must be a `handout` asset of the room (`:260-261`).
- **The library** is the room's asset rows. A handout image kept for later is an asset of kind `handout` that no state names, which the DM's library marks "Not in use" (`client/features/images/library.ts` `notInUse`). Rows have no title: the DM types one in Show a handout (`client/features/handouts/HandoutsSection.tsx`, `ShowHandout`), whose title, audience and pick are the form component's own state (`:73-77`).
- **Upload** takes `image/*` (`HandoutsSection.tsx:175`), shrinks it to 2048 px in a canvas (`images/upload.ts` `prepareImageUpload`) and PUTs it with `?kind=handout`. The server checks magic bytes and re-encodes to WebP, `full` at 2048 px and `thumb` at 512, each the whole page (`server/assets/kinds.ts:63`), at most 10 MiB and 60 s an upload. The same bytes uploaded again to the same room reuse the existing row, and the answer does not say so (`server/assets/service.ts:209-213`, and a concurrent duplicate through `on conflict do nothing` in `server/assets/store.ts:258-276`). Handout uploads share one hourly budget with token images: 30 a session, 60 an IP and 120 a room (`service.ts:57`, `hourlyChecks` at `:159`). Scene thumbnails have their own (`:67`).
- **Ops' answers.** `dispatch` returns `null` without sending when the op fails the client's own schema check (`client/state/store.ts:480-485`). Otherwise `onAnswer` hears `taken`, `refused` or `unknown`, the last when a reconnect's snapshot settled the op without saying whether it applied, or the op grew too old to send, which the store reports while it prepares its hello, before any new snapshot (`client/state/types.ts:91-98`, `store.ts:509`, `:523-556`).
- **A room at its storage quota** accepts only the ops in the actor's deletion list (`server/rooms/actor.ts:176`), and the asset delete route still works there.
- **The viewer** (`HandoutViewer.tsx`) already takes `pages: { src, alt, width?, height? }[]` and lays them in one column with a 16 page-pixel gap (`zoom.ts:37`, `layoutPages` at `:56`). Several pages fit the widest page's width (`fitScale`, `:68`), and that fit is the zoom's floor (`zoomOutDisabled`, `:196`). The wheel scrolls by `deltaY` in whatever unit the browser sends (`HandoutViewer.tsx:261`). It shows nothing until every page has a size (`:138`), one failed image fails the whole viewer (`:139`, `:351`), and it starts again from rest only when the joined image URLs change (`:134`, `:161-167`). The stage is a transformed layer under `touch-action: none`, not a native scroller, so a screen reader's scroll gestures do not move it. Every caller passes one page (`HandoutPopup.tsx:148`, `LibraryGrid.tsx:291`).
- **Players** get each handout addressed to them (`shared/project.ts:888`), and its image joins their visible set (`:1666`), which the asset route checks. A table display is a player who owns nothing, so it gets those shown to everyone. Behind a blackout players get none.
- **Download** fetches the `full` image and saves `<title>.webp`, or opens the share sheet on a touch device that shares files (`download.ts`, `HandoutPopup.tsx:103`). The popup fetches the image as it opens (`:79`) and holds one ready image.
- **The table display** shows the image whole over a dark scrim, and a tap or a key closes it (`DisplayRoom.tsx:373`, `logic.ts:116`).
- **pdf.js 6.3.289** falls back to parsing on the page's own thread (its "fake worker") when the worker it starts cannot run. It loads its JBIG2, CCITT fax and JPEG 2000 decoders from `wasmUrl` when a page needs one, and when that load fails it draws the page without the image and only warns (`src/core/wasm_image.js` and `src/core/evaluator.js` at that tag).

## 3. Data model and protocol

### 3.1 Pages on a handout

```ts
/** One page of a handout: a `handout` image and its canonical size, the `full` variant's pixels. */
export type HandoutPage = { assetId: AssetId; width: number; height: number };

export type Handout = {
  id: HandoutId;
  rev: number;
  /** The first page. A handout without `pages` is this one image, as every handout from before PDFs is. */
  assetId: AssetId;
  /** Every page in order, the first included (docs/design-v1-pdf-handouts.md 3.1). Absent for one image. */
  pages?: HandoutPage[];
  title: string;
  to: "all" | MemberId[];
  shownAt: string;
};
```

- `assetId` stays, and always names the first page. The reducer writes it from `pages[0]`, so the two cannot drift. A reader that knows only `assetId` still shows the first page: the DM's Showing now thumbnail, a player's Handouts from the DM row, and a page left open from before the deploy.
- One helper, `handoutPages(h)` in `shared/handouts.ts` (new), returns `h.pages`, or `[{ assetId: h.assetId }]` with no size. Every reader that wants all pages goes through it: the references, the visible set, the remap, the popup, the display and download.
- Sizes ride in the state so the viewer can lay out every page before any of them loads (5.4). They are the asset rows' sizes: the actor puts each row's `width` and `height` over what the client sent, as it already does for maps and phases (`withAssetSizes`, `server/rooms/actor.ts:1459`). `assetIdsOf` (`server/rooms/persistence.ts:328`) already finds every `assetId` key in a raw op, inside lists too, so the rows load with no change there.
- **A page may repeat.** The server reuses the row for identical bytes, so two blank pages of one PDF are one asset, and two documents can share one. Nothing requires distinct page ids, every list keys pages by their index, and nothing infers a document from one shared page (8.1).

### 3.2 Documents in the library

```ts
export type HandoutDocId = string;

/** A PDF the DM uploaded, kept in the library until the DM deletes it (docs/design-v1-pdf-handouts.md 3.2). */
export type HandoutDoc = {
  id: HandoutDocId;
  rev: number;
  title: string;
  pages: HandoutPage[];
  /** When it was saved, for the library's order, newest first. */
  createdAt: string;
};

// RoomState
handoutDocs: Record<HandoutDocId, HandoutDoc>;
```

- **Why the state holds them, not the asset rows.** The pages are separate rows, so something must say that they make one document and what it is called, before it is shown and after it closes. In the state that is one entity, which undo, replay, the projection, cleanup's references and the export's remap already handle, and whose title passes the name rules like any other. Tagging asset rows instead would need new columns, a listing change, an export format change and a delete path outside undo.
- **Why a document is not a handout.** A handout is a showing: it exists while shown, to an audience, and closing it removes it. A document stays in the library whether shown or not. Showing one copies its pages into a new handout (3.3), so a handout never depends on a document that may be deleted later, and players never need the document.
- Like saved encounters, documents are the DM's alone. A player's and a display's projection hold none (3.4).
- No field links a handout to the document it came from, so no id of a DM-only entity reaches players. The library tells a document is showing by comparing whole page sequences (8.1).

### 3.3 Ops and validation

| Op | Who | What |
| --- | --- | --- |
| `handout.show { handout: { id, assetId, title, to } }` | DM | As today: one image. Stored ops replay unchanged. |
| `handout.show { handout: { id, pages, title, to } }` | DM | New: the pages in order. The reducer writes `assetId` from the first. |
| `handoutDoc.create { doc: { id, title, pages } }` | DM | Saves a document under the id the client chose. An id already in use is refused as invalid, so a create sent twice cannot make two. |
| `handoutDoc.delete { docId }` | DM | Deletes a document, `gone` when it is not there. Its images stay until the client deletes them (3.5). Accepted at the storage quota. |

- **Schemas** (`shared/protocol.ts:741`). `handoutPage` is `z.strictObject({ assetId: id, width, height })`, each size an integer from 1 to 8192 (the map cap, so a later change to the handout pipeline needs no schema change). `pages` is `z.array(handoutPage).min(1).max(LIMITS.handoutPages)`. The show op's `handout` becomes a union of two strict objects, the old one with `assetId` and the new one with `pages`, so an op with both or neither is refused. A document's `title` is the protocol's `name` (`:96`): 1 to 80 characters, with no control or text direction characters, as a handout's is. zod 4 counts code points once a string runs past its maximum, so 80 dragon emoji pass and 81 are refused. The title cleaner's 80 UTF-16 units (4.1.3) always fit inside that.
- **The reducer.** `handoutShow` writes `assetId: pages[0].assetId` and `pages` for the new shape. Shown again as one image under the same id, a handout drops `pages`, so a re-show never keeps stale pages. `handoutDocCreate` and `handoutDocDelete` live beside it in `shared/reducer/misc.ts`. Create sets `createdAt` from `tx.env.at`.
- **Permissions** (`shared/permissions.ts`). Both document ops join the DM-only list beside `handout.show`. `handout.show` and `handoutDoc.create` check every page with `c.asset(page.assetId, "handout")`, so a map, a token image or another room's image among the pages answers `gone`, as one image does today. An undo that puts a document or a handout back is checked through `restoreAddedAssets`, which knows their pages (3.5).
- **The storage quota.** `handoutDoc.delete` joins the actor's deletion list (`server/rooms/actor.ts:176`), beside `handout.close`, so a room at its quota can delete documents and then free their images through the delete route, which already works there.
- **Reads** (`shared/reads.ts`). As the saved encounter ops do (`:150-154`), `handoutDoc.create` reads nothing and `handoutDoc.delete` reads its document's key. `handout.show` reads nothing, as today.
- **Keys** (`shared/keys.ts`): a `handoutDoc` kind, `handoutDoc:<id>`, in the collection `handoutDocs`.
- **Undo phrases** (`server/rooms/undoLabels.ts`): "saving the handout Strange letter" and "deleting the handout Strange letter". A show keeps "showing the handout ...".
- **The log.** A show still logs "The DM shows a handout: Strange letter." Documents log nothing, as saved encounters log nothing.
- **State schema** (`server/rooms/stateSchema.ts:410`): `pages` optional on a handout, with the protocol's bounds, and `handoutDocs: record(handoutDoc)`.

### 3.4 Projection and the visible set

- `projectHandoutCtx` (`project.ts:888`) does not change. A player receives each handout addressed to them whole, every page with its size, and none during a blackout.
- `handoutDocs` is projected for the DM only, as `savedEncounters` is (`project.ts:910`). The projection's key list (`:1433`) and the DM projection's size estimate (`server/rooms/sizeGuard.ts:230`, `ROOM_LEVEL`) gain it.
- `visibleAssetIds` (`project.ts:1666`) adds every page of each projected handout, through `handoutPages`. So a player reads every page of a handout shown to them, and no page of one that is not shown to them, is closed, or is behind a blackout. A display reads the pages of handouts shown to everyone, through the same set (`server/http/display.ts`). A document's pages reach a player only by being shown.
- Once a handout closes, its pages answer 404 to a player, as one image does today, though the browser's cache may still hold the pages already seen.

### 3.5 Cleanup and deletion

- `entityAssetRefs` (`shared/referencedAssets.ts:58`) returns every page of a handout and of a document, kind `handout`, and `IMAGE_COLLECTIONS` gains `["handoutDocs", "handoutDoc"]`. Cleanup, the DM library's `inUse`, the delete route's `asset_in_use` check and `restoreAddedAssets` then all see them, with no other change. The file's own test fails until both are listed.
- A document's pages are therefore in use while it exists. "Delete N not in use" never takes them, and automatic cleanup never takes handouts at all. A document is kept for later until the DM deletes it, which only the DM can judge, as docs/design-v1-dm-tools.md 3.19 says of images.
- **Asset use protects images, nothing else.** Whether a document is showing (8.1) and whether its images may be deleted are separate questions. The delete route answers the second from the whole state, so an image another document or a showing handout names is always kept.
- **Deleting a document** (8.1) dispatches `handoutDoc.delete`. Once it is `taken`, the client runs the existing `deleteImages(roomId, pageIds)` (`images/library.ts`), which keeps any page the route refuses as in use. If the op is refused, nothing is deleted. An `unknown` answer is settled by the checking rule of 4.1.5: the note says "Checking whether the handout was deleted…" until the current connection's snapshot is in, and only then does the document's absence mean deleted, so the images go, and its presence mean not deleted, which the note says with Try again. If the image delete fails (offline), the note keeps the page ids and offers Try again, and until then the pages are loose images marked "Not in use".
- Undoing `handoutDoc.delete` after its pages are gone is refused ("that is not here"), the library's existing promise: "A deleted image is gone for good, from undo too." Undoing `handoutDoc.create` removes the document and leaves its pages loose. If a handout still shows those pages, they are "In use", and the Library names each "Strange letter, page 3" (8.1).
- **A room that is not loaded** is checked as text for any appearance of an image id (`server/assets/cleanup.ts`), which pages in a document or a handout already satisfy.

### 3.6 Export and import

- An export already carries every asset row (design 16.4), so every page travels.
- `remap.ts` maps each page of a handout and of a document with `asset(id, "handout")`. A page that did not come through, or came as another kind, is dropped, and the rest keep their order. A document or a handout left with no page is dropped. A handout's `assetId` is its first page after that. A document gets a new id, as a handout does.
- An old export has no `handoutDocs`. The snapshot migration adds it empty (3.8), and the import schema reads it after migrating.
- **The import's caps.** An import takes at most 2,000 zip entries and 2,000 manifest assets (`IMPORT_LIMITS.entries`, `server/rooms/importRoom.ts:52`), and an export writes every variant as an entry, two for each handout page. So a room near its 2,000 handout pages (3.7) could not come back. The entry cap rises to 10,000, the manifest's assets to 5,000 and its bytes from 1 MiB to 2 MiB. What bounds an import stays as it is: the body cap, the 1 GiB inflated total, and reading one entry at a time. An entry costs a few hundred bytes in the entries map, so 10,000 cost a few MB.
- A room with many documents may export past the web import's 95 MB, as a room with many maps can today. The admin import already restores larger files (design 16.4), and nothing changes there.

### 3.7 Limits

- **Pages per handout and per document: 100** (`LIMITS.handoutPages`). A handout pack is a few pages, and a player's guide a few dozen. A longer PDF uploads a range of up to 100 of its pages (4.1.3).
- **A PDF file: 100 MB** (`PDF_MAX_BYTES`, client only). This bounds the input, not the tab's memory, which 4.2.3 bounds. The server never sees the PDF.
- **Handout pages in a room: 2,000** (`LIMITS.handoutPagesPerRoom`), counting every page of every document and of every handout showing, one image as one page. A document shown counts its pages again while it shows. It keeps the documents in every DM snapshot to about 200 KB at most (a page entry is about 90 bytes), and what a player receives far less. `checkLimits` refuses the op that would pass it. A save says "The room holds at most 2,000 handout pages. Delete a document or close a handout, then try again." A show adds: "Showing a document counts its pages again while it shows." The job checks the limit before uploading anything (4.1.3), so the save's refusal is rare. The existing 200 handouts showing per room stays.
- **Storage.** Every page is an asset row and counts against the room's quota (`ROOM_QUOTA_MB`, 1 GiB by default). A text page at 2048 px is often a few hundred KB as WebP, so 100 pages take tens of MB. The job stops plainly at the quota and goes on once the DM frees space (4.1.6).
- **Hourly uploads.** Handout uploads get a budget of their own, per session and per room, as scene thumbnails have (`service.ts:57-67`): `HANDOUT_HOURLY`, large enough for two documents at the page cap within an hour, for example 250 each. A handout is DM only and every page still counts against the room's storage, so a generous count is enough. Without it, a 30-page PDF spends the DM's whole hourly budget and refuses the DM's next map.
- **Op size.** The rule: the largest op a client can send must fit the 64 KiB frame (`server/rooms/ws.ts:55`) with room to spare. The worst case is a show of 100 pages with 64-character ids, an 80-character title and 50 recipients: about 14 KB with its message envelope, under a quarter of the frame. A test serializes that whole message (11.1). The event a player receives carries the same handout.

### 3.8 Old rooms, old ops, rollout and rollback

- **Stored handouts and old events.** A handout without `pages` is one page. `handout.show` with `assetId` keeps its schema branch and replays unchanged. Nothing tightens, so `OP_VERSION` stays 5.
- **Snapshots.** `SNAPSHOT_VERSION` goes from 8 to 9 (`shared/migrate.ts:13`), with a step that adds `handoutDocs: {}`, as the journal's step did in wave 5.
- **Pages open across the deploy.** State arrives as `z.unknown()`, so an old page drops `pages` and shows the first page only. An old DM page cannot make documents. The deploy notes say to reload every open page, table displays included.
- **Rollback is a restore.** An older build cannot load a version 9 snapshot: `runMigrations` refuses to migrate down (`shared/migrate.ts:247`), and a clean shutdown guarantees every loaded room has one. So going back to an older build means restoring, on the older build, the backup taken just before the update, which the README's Updating section already takes first. Rooms changed after the update lose those changes. The README's Updating section says so for this update, and the build rehearses the restore once before it merges (11.4).
- An export from this build is refused by an older build's import, whose schema is strict, as earlier waves noted.

### 3.9 Who made an image

The upload answer gains `created`: true when this request inserted the asset row, false when it reused a row the room already had, whether from an earlier upload or from a concurrent one that won the insert (`ingest`, `service.ts:209`, and `insertRow`'s `lostRace`, `store.ts:276`). It is sent only on a `handout` upload. Only a DM can make one, and a DM's library already lists every handout image, so it reveals nothing the DM cannot see. Token uploads keep today's answer, which never reveals reuse (design 11.1). The upload job deletes only rows it made (4.1.2).

## 4. Upload (DM)

All of it is client code, in `client/features/handouts/pdf/` (new), except `created` (3.9). The server sees only images.

### 4.1 The upload job

One model answers how the job is seen, owned, saved, cancelled and resumed. Section 15 lists the findings it answers.

#### 4.1.1 Where it lives and what it shows

- **One job per device,** in a room-scoped store, `pdfJobSlot` (through `scopeSlot`, `client/state/scope.ts:28`, as `closedSlot` does). It holds the file, the page range, the title, the document id, every page uploaded with its id, size and ownership, and the phase. Nothing of it lives in the form.
- **Its block.** While a job exists, the DM panel's Handouts section shows it in a block of its own, above Showing now: the file's name, the range or the progress, the title field, and the job's buttons. The block is outside the Show a handout form, so the form keeps working: From the library, Upload a file for an image, Title, Show to and Show all work during a job. The block is a `role="group"` named "PDF upload, Strange letter.pdf", so its Title field is told apart from the form's, which sits in a group named "Show a handout" (`HandoutsSection.tsx:149-150`).
- **The form's own draft** (pick, title, audience, chosen players) moves to a room-scoped slot as well, so closing the DM panel or switching panels keeps it. The form's Cancel only closes the form. Only the job's Cancel upload stops the job.
- **Seen from anywhere.** Every pause, every stop and the end is a toast (`notify`), such as "The PDF upload paused at page 7. Open Handouts in the DM panel to go on." or "Strange letter is saved, 12 pages.", unless the job's block is on screen, where its polite status line already says it and a toast would say it twice. So is a PDF that could not be opened ("The PDF could not be opened. Open Handouts in the DM panel.") and one opened to its range ("The PDF is open. Open Handouts in the DM panel to choose its pages."), since a DM may close the panel while the reader loads. A page is named by its number in the PDF, in the toast and the block alike. While the job waits on the DM (paused or stopped, refused, or at its range), the DM panel carries a badge of 1 in the panel list and its tab, through the existing `badges` record (`pages/Room.tsx:364`). `Badge` today speaks "N unread" (`pages/RoomChrome.tsx:340-371`), so it gains a label, and this one says "1 upload waiting". On a phone the record shows only inside the panel list, so the Panels button's count (`pages/Room.tsx:783`, today unread messages and journal pages) adds the waiting job, and its spoken label names it.
- **On touch devices** the block says "Keep this page open until it finishes."
- **One PDF at a time.** A PDF picked while a job exists is refused in words: "One PDF at a time. Cancel Strange letter, or wait for it." The button stays enabled, since images still upload. A ledger whose cleanup failed (4.1.6) holds the slot too: the next PDF picked brings back its recovery instead, with "One PDF at a time. Remove or keep the pages of Strange letter first." The ledger holds one upload's pages, and the next upload's first page would overwrite it, so this is how those pages are never forgotten. Offline, Keep them frees the slot. A ledger that names only a page that may be there, with no ids, holds nothing: its recovery offers only Done, which clears it, and a new PDF goes ahead and replaces it.

#### 4.1.2 Ownership and the ledger

- **The job owns only what it made.** Each page's upload answer says `created` (3.9). A page with `created: true` is the job's own. A page with `created: false` reused an image the room already had, perhaps a loose image the DM kept, or one another upload is making. Every cleanup the job does (Cancel upload, recovery) deletes only its own pages, through `deleteImages`, which also keeps any page the state names by then. Anything else, or anything the job cannot be sure of, stays loose.
- **The ledger.** As each owned page lands, before the next upload starts, the job writes its id to a ledger in localStorage, `rvtt.pdfUpload.<roomId>.<memberId>`, with the document id and title. The ledger is cleared when the save is confirmed or a cancel's cleanup finishes. Storage that refuses writes costs only the recovery below.
- **Recovery.** When this device opens the room with a ledger and no job: if the confirmed state holds the ledger's document, the save happened, and the ledger is cleared quietly. Otherwise the job's block says "A PDF upload did not finish: Strange letter, 6 pages are in the library." with Remove them, which deletes exactly the ledger's ids, and Keep them, which clears the ledger and leaves them loose. A page the ledger holds as uncertain (4.1.6) is named too, with its size, since it has no id to delete: "Page 7 may also be there, a loose handout image of 1583 × 2048 px." Remove them shows "Removing the pages…" with no Cancel upload, since nothing uploads. Either button leaves the block with its summary and Done (4.1.7). Clean up is never the advice: it would also take every handout image the DM kept on purpose.
- **A running job's pages are not loose** on its device. The Library tags them "Uploading" and leaves them out of "Not in use", Clean up skips them, and From the library leaves them out, owned and reused alike. On another DM device they show as loose images, and deleting them there is the `gone` answer of 4.1.5.

#### 4.1.3 Opening and the page range

- **Picking.** "Upload an image" becomes "Upload a file", with `accept="image/*,application/pdf,.pdf"`, and the form's "Image" label becomes "Image or PDF". A file of type `application/pdf`, or with no type or `application/octet-stream` and a name ending in `.pdf` (some Android pickers send no type), starts a job. A file with an image type takes today's image path whatever its name. A PDF over 100 MB is refused before it is read: "PDFs up to 100 MB can be used."
- **Loading pdf.js** as 4.2.5 says, with "Loading the PDF reader…" in the block.
- **Refusals,** each with nothing uploaded:

| Case | What the DM reads |
| --- | --- |
| The worker does not start, or the decoders do not load (4.2.1) | "The PDF reader could not start here. Check your connection, then try again. If it keeps failing, update the browser or use a computer." |
| A password is needed (`PasswordException`) | "This PDF has a password. Save a copy without one, then upload that." |
| Not a PDF, or damaged past reading (`InvalidPDFException`, or any other error while opening) | "This PDF could not be read. It may be damaged." |
| A dynamic XFA form: `getMetadata()` reports `IsXFAPresent` without `IsAcroFormPresent`. With XFA off its pages are only a "Please wait" notice. | "This PDF is an XFA form, which cannot be shown here. Print it to a new PDF, then upload that." |

A PDF with only an owner password (no password to open it) opens, as in every reader, and pdf.js ignores its permission flags. A hybrid form, with both XFA and AcroForm, opens and draws its AcroForm.

- **The range.** Once open, the block says "Strange letter.pdf, 12 pages." with two number fields, From page and To page, and "Upload 12 pages". By default they hold every page. A PDF of more than 100 pages starts at 1 to 100 and says "This PDF has 140 pages. A handout holds up to 100, so choose which." The fields take whole numbers, From at least 1, To at most the PDF's pages, From no more than To, and at most 100 pages, and each rule that breaks says so in words beside the fields. The job draws only those pages, in order. A range picks a module's handout pages ("pages 87 to 89").
- **The room's page limit** is checked here, against the DM's state: "The room holds 1,950 of its 2,000 handout pages. Choose at most 50, or delete a document." The save checks it again (4.1.5), since the state may change meanwhile.
- **The title,** in the block's Title field, starts as the PDF's own title: its XMP `dc:title`, else its Info `Title`. A title that is empty after cleaning, reads "Untitled" or "untitled document" in any case, or looks like a file path (it holds `/` or `\`) gives way to the file name, through `titleFromFileName`, and then to "Handout". Every source goes through one cleaner, `cleanTitle`: it removes what the `name` schema refuses (control characters, line and paragraph separators, and text direction characters), collapses whitespace, drops a leading "Microsoft Word - " (or PowerPoint, Excel) and a trailing file extension (`.doc`, `.docx`, `.pdf`, `.odt`, `.pages`), and cuts the result to 80 UTF-16 units without splitting a surrogate pair. So a generated title always passes the schema. What the DM types is checked against the same schema as they type, with its reason beside the field, and the save waits for a valid one (4.1.5).

#### 4.1.4 Drawing and uploading

For each page of the range in order:

1. **Draw** on the job's one canvas, as 4.2.2 says.
2. **Encode** with `canvas.toBlob("image/webp", 0.9)`. A browser that hands back another type (Safari cannot encode WebP) is asked for `image/jpeg` at 0.92. PNG is never used, since a page with art would take several MB. A blob over the 10 MiB upload cap is encoded again at lower quality (for example 0.8, then 0.7), then at a smaller size (for example 1600 px, then 1200 px on the long side), until it fits.
3. **Reset the canvas** once the encode finishes (`width` and `height` to 0), before the next page draws. From then on the job holds only the encoded blob.
4. **Upload** with the existing `api.uploadAsset(roomId, "handout", blob, { signal, background: true })`, its 503 retries and "Waiting for the server…". The server checks the page like any image. The answer's id, size and `created` go into the job, and an owned id into the ledger, before the next upload starts.

Page `n + 1` draws while page `n` uploads. The canvas is free for it, since page `n` released it at step 3.

**Sharing the upload slot.** The server gives an IP one intake slot (design 11.1, `server/assets/slots.ts:13`), and every phone at a table shares one IP. A second upload gets `503` and retries about every 2 s (`client/lib/api.ts:211`), so a job that uploads back to back would win nearly every time and starve the others. So:

- **One queue per device.** `api.uploadAsset` runs every upload from this device through one queue, one at a time. An upload marked `background`, which only the job's pages are, waits behind any other: an image picked in the form or a token image goes before the job's next page.
- **A pause for other devices.** While another member of the room is online (`online`, `client/state/types.ts:282`), the job waits a little longer than those retries, 2.5 s (`SHARE_PAUSE_MS`), so their uploads find the slot free. It waits before a page once about 20 s have passed since its last pause (`SHARE_EVERY_MS`), not after a count of pages, so on a slow link, where a few pages take longer than another device's minute of retries, time still bounds that device's wait. On a fast link it costs about an eighth of the time. Alone in the room it does not wait, and the progress says nothing new while it lasts.

**Progress.** The block shows "Preparing page 3 of 12…", where 3 is the first page not yet uploaded, and a progress bar of the pages uploaded (`role="progressbar"`, with `aria-valuetext` the same words). A polite status line speaks the start, each pause or stop, and the end, never every page. The progress line itself is not a live region (`Loading`'s `live={false}`), and neither are the popup's download progress and the viewer's "Loading page N…". The popup says "Preparing the PDF." as a download starts and "The PDF is ready." once it is built. While the save is checked offline, the block says "Waiting for the connection to check whether the handout saved." A phone often takes from a fraction of a second to a few seconds a page to draw and encode, and about as long again to upload on a fair link, so a long PDF can take minutes. Those are examples, not bounds.

**A hidden page.** The job starts no new draw and no new upload while the page is hidden (`document.visibilityState`). Work already under way settles as the browser allows. When the page shows again the job goes on, and an upload that failed while hidden is tried once more at once, before it counts as offline.

#### 4.1.5 Saving under a stable id

- **The id first.** The job chooses the document's id when it starts (`newId`), and keeps it in the job and the ledger.
- **The save.** When the last page is in, the job validates the op with the client's schema, title included, before dispatching `handoutDoc.create` with that id, the title and the pages with their sizes. It never sends a create with no pages: a range whose every page was left out ends as 4.1.6 says. An invalid title pauses the job with "Fix the title to save." and its reason beside the field. Pressing Save then saves. If `dispatch` still returns `null`, the job says "The handout could not be sent." with Try again.
- **The answer:**
  - `taken`: saved. The ledger is cleared.
  - `refused`: the job keeps every page and says why, with Try again and Cancel upload. A refusal the room's page limit caused names it. On `gone`, which means pages were deleted meanwhile (by Clean up on another device), Try again first uploads again each page the room's listing no longer has, then saves.
  - `unknown`: the job enters a checking state, "Checking whether the handout saved…", and compares nothing yet. An `unknown` can arrive before the reconnect's snapshot: the store reports an op too old to resend as `unknown` while it prepares its hello (`client/state/store.ts:509`), when the confirmed state is still from before the disconnection and may lack a create that did commit. So the store marks each `unknown` with how it was settled: `snapshot` when `applySnapshot` settled it after installing the snapshot (`store.ts:556`), `expired` when `prepareHello` dropped it. A `snapshot` answer is checked at once. An `expired` one waits until the current connection installs its snapshot. Only then is the document looked for by its stable id: present means saved. Absent means the create never applied, and the job sends it again under the same id, once, before it asks with Try again. A create that had applied after all is refused as an id in use, and the job checks again. No retry and no compensating delete starts before that snapshot.
- **The checking rule** settles every `unknown` answer for a create or a delete of a document the same way: the job's create, the compensating delete of 4.1.6, and the Library's Delete (3.5).
- **Offline while saving:** the op waits in the outbox, and the block says "Waiting for the connection to save."
- **Saved,** the block says "Saved as Strange letter, 12 pages." (and "Page 7 was left out." when one was), with Show it, View and Done. Show it opens the form with the document picked, in place of any other pick, keeping a title the DM typed. A title the form filled in itself from an earlier pick gives way to the document's (the project owner, 2026-10-16). If the form is open with nothing picked, the document is picked there at once.

#### 4.1.6 Cancelling, pausing and stopping

Cancel upload is in the job's block, in red text, and takes one tap. It works from every phase:

- **Before the create is sent:** the drawing in progress is cancelled (`renderTask.cancel()`), and a 503 retry wait stops at once, since no request is in flight then and a busy answer made nothing. An upload already sending gets a short grace to answer, `CANCEL_GRACE_MS`, for example 10 s. `uploadAsset` has no timeout of its own (`client/lib/api.ts:409`), its 60 s budget counts only retries after a 503, and the server's intake deadline ends once the body has arrived (`server/assets/upload.ts:104`), so without the grace a stalled answer could hold Cancel forever. An upload that answers in time is known like any other page. One that does not is aborted, and the ledger records its page as uncertain, by number and pixel size, with no id. Then the job deletes its own known pages and clears the ledger's ids, keeping only an uncertain page. Pages reused from the library stay.
- **After the create is sent:** `dispatch` cannot take it back, so the job says "Cancelling…" and waits for its answer, through the checking state of 4.1.5 when it is `unknown`. If the document was saved, the job sends `handoutDoc.delete` for it, then deletes its own pages once that is taken, or once the checking rule finds the document gone. If it was not saved, the job deletes its own pages.
- **What stays.** The block keeps a summary, with Done, until the DM dismisses it: "Removed 6 pages." When a page was uncertain, it adds "Page 7 was uploading and may remain in the library as a loose handout image, 1583 × 2048 px.", so the DM can find it, since the job has no id to delete. A failed delete (offline) keeps the ledger, and the recovery of 4.1.2 offers it next time, naming the uncertain page the same way.

Every other stop has a way on:

| What happens | What the job says and offers |
| --- | --- |
| Offline, or a network error on an upload | Pauses: "The upload stopped at page 7 of 30. Check your connection." Try again goes on from page 7. Cancel upload. |
| 503 past the 60 s of retries | Pauses: "The server is busy." Try again. Cancel upload. |
| 429, an hourly budget spent | Pauses with the server's wait: "Too many uploads this hour. Try again in 12 minutes." Try again. Cancel upload. |
| 413 `quota_exceeded` | Stops: "The room's storage is full, after 6 of 30 pages. Free space in the Library, then try again." Try again. Cancel upload. |
| A page that cannot draw, or whose image could not be decoded (4.2.1) | Pauses: "Page 7 could not be drawn." Try again starts a fresh worker (4.2.1). Leave this page out goes on without it. Cancel upload. |
| A page still over 10 MiB at the smallest size | Pauses: "Page 7 is too large to upload." Leave this page out. Cancel upload. |
| Every page of the range left out | Ends: "No pages were uploaded." Try again goes back to the range, with the file still open. Dismiss ends the job. No create is sent, since a document needs at least one page. |
| The save refused, or its answer lost | 4.1.5 |
| The DM grant is gone | Stops: "You are no longer a DM here." The pages stay. The ledger stays, so this device can remove them once it is a DM again. |
| The room is read-only (its replay failed) | Stops with the route's words. Nothing can be deleted until the room is repaired. The ledger stays. |
| Leaving the room | Leave room (`client/panels/MenuPanel.tsx:79-88`) asks once while a job exists: "A PDF is still uploading. Leave anyway? This device offers to remove its pages next time." The job ends. Nothing is awaited. Back at the room's root, in the browser or on Android, leaves without asking, as it does today: asking there would need a history entry of the job's own beside the ones `lib/backClose.ts` keeps for sheets and handouts. The ledger's recovery covers it. |
| Reload, or closing the tab | `beforeunload` warns while a job exists. iPhone Safari often skips it. The ledger's recovery covers every browser. |

#### 4.1.7 Focus

- Picking a PDF moves focus to the job block's heading (`tabIndex={-1}`), which names the file.
- A button that leaves when pressed (Upload 12 pages, Try again, Leave this page out, Save, Cancel upload) hands focus to the block's heading.
- When the progress gives way to "Saved as …", focus in the block moves to that line. A cancel's summary, "No pages were uploaded" and a recovery's summary keep focus on the block's heading.
- Done or Dismiss, or the block leaving any other way, hands focus to Show a handout, or to the form when it is open.
- The Library's viewer closing because its document was deleted hands focus by 8.4's rule: the next tile in that section, else the one before, else the section's heading, else the panel's first control (5.9).

### 4.2 Rendering safety

One model answers the worker, the decoders, memory and the tests that prove them. Section 15 lists the findings it answers.

#### 4.2.1 The worker and its decoders

- **The job's own worker.** The job starts a module worker from `client/features/handouts/pdf/worker.ts` (new, built by Vite). Before pdf.js runs, the worker checks the two decoders (4.2.4): it imports each from the version folder and builds one instance, which shows the module loads and initializes here, then discards that instance. Then it wraps `console.warn` (below), imports pdf.js's worker module, and posts that it is ready. If any step fails, it posts which.
- **No main-thread fallback.** The job waits for that ready message, or the worker's `error` event, for about 15 s. Only after ready does it give the worker to pdf.js as its port (`new PDFWorker({ port })`, passed to `getDocument` as `worker`). pdf.js then never starts a worker of its own, so its main-thread fallback never applies. `GlobalWorkerOptions.workerSrc` stays unset. A worker that errors, times out or reports a failed decoder ends the job with the reader's refusal (4.1.3).
- **Decoders checked before any page.** A decoder that cannot load or initialize stops the job at open, not on page 40. pdf.js later imports a decoder by the same URL, so the module comes from the worker's module map with no second request, and calls its factory to build its own instance (`#getJsModule` in `src/core/wasm_image.js`). The check proves only that the file loads and initializes here. If pdf.js's own instance fails later, out of memory say, the next rule catches it.
- **A page whose image fails, fails.** pdf.js's `warn()` writes "Warning: …" through `console.warn` at its default verbosity, warnings (`src/shared/util.js`), and offers no event to listen to. So the worker wraps `console.warn` before it imports pdf.js's worker module, and while a page draws it forwards to the job each line that matches `IMAGE_FAILURES`. A line saying an image could not be decoded, that a decoder failed, or that an image was dropped for its size fails that page (4.1.6), and the page is never uploaded. `IMAGE_FAILURES` is one constant, pinned by tests that make each line happen (11.1, 11.3), and `PDF_OPTIONS` pins `verbosity` at warnings.
- **Who ends it.** The job owns the worker. It calls `destroy()` on the document and `terminate()` on the worker when the job saves, is cancelled, stops, or the room unmounts. Try again on a page failure ends both, starts a fresh worker (fresh decoder state, since pdf.js caches a failed decoder per worker), opens the file again and goes on from that page. A reader whose page failed is closed whatever stops the job first, an upload's failure included. Before Try again or Leave this page out starts drawing, any draw and encode still under way settles, so two never share the canvas. The job owns the worker from its start: Cancel while the file opens ends it at once. pdf.js's own `destroy()` waits for the worker to answer, so it gets `DESTROY_GRACE_MS`, 2 s, and the worker is terminated after that whatever it did. A cache cleanup gets the same time, after which its reader is replaced. Try again and Leave this page out claim the job at once, as preparing, so a second press does nothing and Cancel works from there. They wait at most `QUIET_MS`, 15 s, for the last run to settle, then end its reader and go on in a fresh one, and they start a run only if Cancel or Done has not come meanwhile. A run let go that way keeps its own canvas and reader, so whatever it does when it settles touches only them: the next run draws on a fresh canvas, and a late failure closes only the reader that failed. A reader replaced after a stuck cleanup opens only if Cancel, Done or the room going away has not come while the old one closed. A run that throws pauses the job with Try again, and the next run still goes.

#### 4.2.2 Drawing a page

- `page.getViewport({ scale: 1 })` gives the page's size in points with its own rotation applied. The scale is `2048 / max(width, height)`, so the long side is 2048 px: a small page draws larger with crisper text, and a poster smaller. A poster's small print is lost at that size, and no zoom brings it back. Each side is at least 1 px.
- `render` gets `background: "white"`, so a page with no background of its own reads as paper on the dark viewer, and `annotationMode: AnnotationMode.ENABLE`, which draws form fields and stamps as they look in a reader. No text layer or annotation layer is built.
- Optional content (layers) draws as the PDF's default view says. There is no layer picker, and the DM checks in View what players will see (10.4).

#### 4.2.3 Memory

What a job holds at its peak, on a phone:

- **The file,** once, in the worker (pdf.js transfers typed arrays rather than copying them). The 100 MB cap bounds this input. It is not a bound on the tab.
- **One canvas,** at most 2048 x 2048 px, about 16 MiB, reset after each page's encode (4.1.4).
- **The current page's decoded images.** One image may be up to `maxImageSize`, about 40 million pixels, enough for a 600 dpi scan of a Letter or A4 page (about 35 million) and about 150 MiB as pixels. `canvasMaxAreaInBytes` is set to the canvas's own area, so pdf.js shrinks a larger image in the worker before it reaches the page.
- **The document's shared caches:** fonts, and images that several pages use. `page.cleanup()` after each page frees only that page's objects, so the job also calls the document's `cleanup()` between pages, never while a page draws: every few pages (for example 5), and after any page that took long to draw (for example over 3 s), which large images cause.
- **Encoded pages:** at most two, one uploading and one waiting.

If the phone still runs out, the browser kills the tab and reloads it, and the ledger's recovery applies. A large scanned document on real phones is part of the build's checks (11.4).

#### 4.2.4 Security

- **Version.** `pdfjs-dist` pinned to exactly 6.3.289 (released 2026-08-29), the newest release at least two weeks old, by the repository's rule. CVE-2024-4367 was fixed in 4.2.67. Since then pdf.js has removed the code paths that compiled fonts and functions with `eval` or `new Function`, and with them the `isEvalSupported` option that switched them. So 6.3.289 has no such option to set and no such call in `pdf.min.mjs` or `pdf.worker.min.mjs`, which a test checks on the installed files (11.1). The CSP has no `'unsafe-eval'`, and the worker's script is served under the same header (`server/http/security.ts`, which sets it on every response), so an eval would be refused there too.
- **No WebAssembly.** `useWasm: false`. pdf.js 6 can compile a PDF's PostScript functions to WebAssembly while it runs. With it off, pdf.js runs them in its own JavaScript interpreter, so no code generated from a PDF runs, and the CSP needs no `'wasm-unsafe-eval'`.
- **No scripting, no XFA.** `enableXfa: false`. PDF scripting needs pdf.js's viewer and its sandbox (`pdf.sandbox.mjs`), which the app never imports. No annotation layer or text layer is built, so a PDF's links and fields are only pictures.
- **Nothing fetched for the document.** The bytes come from the file (`data`), never a URL. `cMapUrl`, `standardFontDataUrl` and `iccUrl` stay unset, so pdf.js fetches no character maps, fonts or color profiles. A standard font the PDF does not embed falls back to a system font (`useSystemFonts`, its default), and Chinese, Japanese or Korean text in a font without its character map draws nothing (10.4). No URL inside a PDF is ever followed.
- **The image decoders.** Scanned PDFs keep their pages as JBIG2 or CCITT fax images, and some as JPEG 2000, which pdf.js 6 decodes only with a module it loads from `wasmUrl`. The build copies the two plain JavaScript decoders, `jbig2_nowasm_fallback.js` and `openjpeg_nowasm_fallback.js` (about 45 and 117 KB gzipped), into a folder named by the pinned version, `pdfjs/6.3.289/`, and `wasmUrl` points there. The worker loads them from the app's own origin, which `script-src 'self'` allows (decision 3). Neither holds an eval, and the fetch helper each carries from its compiler is never called.
- **One place.** The options are one exported constant, `PDF_OPTIONS`, and a test pins each value (11.1).
- **Licenses.** pdf.js is Apache-2.0, and the decoders are BSD licensed (PDFium's JBIG2 and OpenJPEG). The decoder files carry no license header, and a bundler may drop pdf.js's, so the build copies pdf.js's `LICENSE` and the four `wasm/LICENSE_*` files into `pdfjs/6.3.289/` beside the decoders. CREDITS.md lists shipped art and content, not libraries, so it gains nothing.
- **What is kept.** Every page reaches the server as an image, which it checks and re-encodes like any other (design 11.1). Of the PDF, only its pixels and its title, through the name rules, are kept.
- **What is left.** A bug in pdf.js's parser would run in the app's origin, in the worker. Only a DM runs pdf.js, on a file the DM chose, so a hostile PDF must first reach a DM who opens it. Keeping the pin current is the defense, and the deploy notes list pdfjs-dist among the dependencies to update.
- **Considered and left out:** running pdf.js in a sandboxed iframe with an opaque origin, so a parser bug could not use the DM's session. A document with an opaque origin cannot start a worker from the app's URL, so its source would come in as a blob under a second CSP, and the frame needs an exception to `frame-ancestors 'none'`. That is a lot of machinery against a file the DM chose.

#### 4.2.5 Loading pdf.js

- `pdfjs-dist` loads by `import()` on the PDF path only, into a chunk of its own (about 130 KB gzipped, 460 KB minified, under the build's 600 KB chunk warning). The worker bundles pdf.js's worker module (about 375 KB gzipped). Both come from the app's own origin and are served like every built file, so a second PDF finds them in the browser's cache. The static server sends `.mjs` as `application/javascript`, which a module worker accepts.
- Players and table displays never load it. Download has its own writer (6).

## 5. The viewer

The handout viewer as built (docs/design-v1-layout-hierarchy.md section 5), given every page. It stays one component, `HandoutViewer.tsx`, with its states in `zoom.ts`. Sections 5.2 to 5.7 apply to two or more pages. One page is 5.8.

### 5.1 Controls and identity

One model answers how the viewer is moved without a gesture, where its controls are drawn, and which showing it shows. Section 15 lists the findings it answers.

- **Every function has a button and a key.** Paging has Previous page and Next page buttons (5.3) and keys (5.6). Zoom has its buttons and keys, as built. No function needs a drag, a fling or a pinch, so screen reader, Voice Control and switch users reach every page.
- **Two layers.** The page layer, under the CSS transform, holds only page fills and images. Everything a person reads or presses draws in an overlay in stage pixels, untransformed: each page's border, loading indicator, failure text and Try again, placed from the page's box times the current scale and the view's offset, only for pages that meet the stage. So a control is the same size at any zoom.
- **Controls take their own presses.** Every control over the stage stops `pointerdown`, as the zoom buttons do (`HandoutViewer.tsx:375`), so the stage's pointer capture never swallows its tap. Focus moved onto a control in the stage uses `preventScroll`, so the `overflow: hidden` stage never scrolls under the drawn view. A control that leaves while focused (a page scrolled out of the overlay, a button that disables) hands focus on through `handsOnFocus` and `act`, as built.
- **Identity.** The viewer takes an explicit `showing` key: the popup's `showingKey`, the display's the same, and the Library's `doc:<id>` or `image:<id>`. A change of key resets the page, the zoom, any gesture and any fling. The same key arriving again, as a reconnect's resync, keeps them all. This replaces the joined-URL key (`HandoutViewer.tsx:134`), which a new showing of the same document would not change.
- **The remembered page** is written whenever the current page changes, per showing key, in the room scope while the room is open on this device, never stored. It is read every time a showing starts in the viewer: when the popup opens, when it moves to another handout, and when the Library opens one again.

### 5.2 The page stack

- **Layout.** The pages in one column, each centered across the widest, as `layoutPages` does today. The gap between pages becomes about 2% of the widest page's width: about 8 px on a phone at its width fit and about 14 px on a card, the same look on every screen, growing with the zoom as the pages do. Today's fixed 16 page px is 3 px on a phone.
- **Room at the end.** The column's end is padded by the height of the bottom controls row (5.3), in stage pixels, so the last page's bottom scrolls clear of them.
- **Every PDF page is drawn with its long side at 2048 px** (4.2.2), so pages of different paper sizes show at about the same size when they face the same way. A landscape page among portrait ones sets the column's width, and the portrait pages show narrower and centered, as in a PDF reader.
- **Two fits** (decision 6). The width fit, as built, fits the widest page's width to the stage. The page fit shows the tallest page whole in the stage. Zoom runs from the page fit to 6 times the width fit. Where the page fit is not below the width fit (every page already shows whole), the width fit is the floor, as built.
- **With the three states** on a card layout (card, window, magnified, as built), the steps out are: magnified, then the window's width fit, then the card's width fit, then the card's page fit, which is the floor. Where the window is the floor (a whole-screen layout, or Expand pressed), the window's page fit is the floor. A pinch or the wheel below the width fit stays in the state it is in, so a card never grows from a zoom out. Zoom out is disabled at the floor. Reset zoom shows only while the view is off the resting state's width fit, above it or below it, and goes to that width fit, keeping the place. So at rest, at the width fit, it is hidden though Zoom out is enabled, where as built the two showed together (`HandoutViewer.tsx:380`, `zoom.ts:191-195`). Each step out is 1.5 times, as built, stopping at the next fit.
- **The place is kept.** Every step that changes the fit or the stage keeps the document's point at the stage's center there: Zoom out or Reset zoom to a fit, Expand pressed or released, the card growing to the window or shrinking back, a double tap back to the width fit, a window resize, a phone turning. Today those steps go to `FIT`, the top-left of the column, which is right for one image but would jump 30 pages back to page 1. `zoom.ts` keeps this anchor in page pixels in the viewer's state, beside `keep`, and applies it once the new stage is measured. A pinch's end keeps the box under the fingers as built.

### 5.3 Page indicator and page buttons

- **The row.** At the stage's bottom left, while there are two or more pages: Previous page (an icon button, ‹), the indicator "3 of 12", and Next page (›). The buttons are 44 px on the `overlay` fill like the zoom buttons. The indicator takes no tap and is hidden from screen readers, who hear the page from the buttons and the status line (5.7).
- **Previous page and Next page step by where the view is, not by the indicator.** Next page brings to the stage's top edge the top of the first page whose top lies more than 1 px below that edge, clamped at the end of the stack. Previous page brings there the top of the last page whose top lies more than 1 px above that edge. Both keep the zoom and the horizontal place. Next page is disabled when the stack is at its end, and Previous page when it is at its start. So every press moves the view, whatever the pages' heights. Stepping from the indicator's page would not: on mixed heights the page with the most height showing can stay the same after a press (four pages about 390, 301, 390 and 390 px tall in a stage 700 px tall), and the same press would repeat the same move.
- **After a press** the indicator shows the page the button brought to the top, or the last page when Next page clamped at the end, until the view moves any other way. The status line speaks that page. A button disabled under focus hands focus to the other, else to a zoom button (`handsOnFocus`). `pageStep(state, ±1)` in `zoom.ts` is pure and tested, and returns the view and that page.
- **The current page,** otherwise, is the page with the most height showing in the stage, the earlier one on a tie, except that at the very top it is page 1 and scrolled to the very end it is the last page, however short. `currentPage(state)` in `zoom.ts` is pure.
- **When every page shows whole** (two short pages, or a short document at the page fit), the indicator reads "All 2 pages", both page buttons are disabled, and the page keys do nothing.
- **Room.** The page row and the zoom buttons share the stage's bottom edge. Where they do not fit side by side, as on a 320 px phone while magnified with Reset zoom showing, the page row moves to its own line above, at the left. They never overlap.

### 5.4 Loading pages

- **Sizes first.** A handout with `pages` knows every page's size, so the viewer lays out the whole column at once, with no "Loading the image…" over the stage. The `ready` gate (`HandoutViewer.tsx:138`) stays for one image without a size.
- **Near the screen only.** A page's image mounts when its box comes within about one stage height of the visible area, above or below, and unmounts once it is more than about three stage heights away. These are distances, not page counts: on a phone held sideways one page can be several stage heights tall. While a fling moves faster than about a stage height in a third of a second, no new image mounts. Mounting resumes as it slows, starting from the pages in view, so the page the reader lands on is not queued behind pages flown past. `visiblePages(state, ahead)` in `zoom.ts` is pure and tested.
- **Placeholder.** A page not yet loaded is its fill in the page layer, at its exact size. Its border and the shared loading indicator draw in the overlay (5.1), the indicator once it has waited 200 ms. The image takes the fill's place with no change of layout, so the scroll never jumps.
- **A low-resolution copy first** (decision 8). If a page's `full` image has not arrived after a short wait (for example 400 ms), the page also loads its `thumb`, the whole page at 512 px on its long side, and shows it stretched to the box until `full` replaces it. On a fast link `full` wins and the `thumb` is never asked for.
- **Cache.** Asset responses are immutable and cached (design 11.2), so a page that mounts again comes from the browser's cache. Unmounting lets the browser drop the decoded pixels, which matters on a phone, where 30 decoded pages would take over 300 MB.
- Each page's image has `decoding="async"`, so decoding never holds up a scroll.
- **A page that fails** says "Page 7 could not be loaded." with "Try page 7 again", in the overlay, in screen pixels, a sibling of the page's `role="img"` element, never inside it. The button mounts the image again. The other pages go on working. One image keeps today's message over the whole stage.

### 5.5 Zoom, pan and scroll

- **Touch.** One finger drags the document: up and down at the width fit, and every way once zoomed wider than the stage. A drag that ends while moving goes on and slows to a stop, a fling, as a PDF reader's scroll does. A fling stops at the document's ends, and on any key, wheel step or zoom. A touch during a fling only stops it: it never counts as a tap, so it cannot start a double tap. Two fingers pinch about their midpoint and pan, as built. A double tap at the width fit zooms to 2.5 times about the tap, and above the width fit goes back to it, keeping the place. Below the width fit, a double tap goes to the width fit of the state it is in, about the tap, where as built it would multiply the current scale by 2.5 (`zoom.ts:325-327`).
- **The fling** starts at the finger's speed over its last moves (about the last 100 ms) and slows by a decay in elapsed time, not per frame, so it travels as far at 60 and at 120 frames a second. It ends under a small speed. It draws frames only while it moves, never at rest. `flingStep(velocity, elapsedMs)` in `zoom.ts` is pure, and the component calls it from `requestAnimationFrame`. It runs under reduced motion too, as a phone's own scrolling does, since it follows the finger rather than playing an animation.
- **Mouse and trackpad.** The wheel scrolls. A wheel that reports lines (Firefox, `deltaMode` 1) moves about 40 px a line, and one that reports pages moves a stage height, so every wheel scrolls at a reading pace. Today `deltaY` alone moves 3 px a notch there. Sideways wheel motion (`deltaX`, from a trackpad, or Shift with a plain wheel) pans across once zoomed wider than the stage. Ctrl with the wheel, which a trackpad's pinch also sends, zooms about the pointer, as built, down to the page fit. A left-button drag pans like a finger, with no fling. A double click zooms as a double tap does.
- **Zoom covers the whole document.** Every zoom scales the whole column about its anchor (the pointer, the fingers, or the stage's center for the buttons and keys), so the line being read stays put.

### 5.6 Keys

While focus is anywhere in the viewer, as built (`viewerKey`, `zoom.ts:224`):

| Key | With two or more pages |
| --- | --- |
| PageDown, PageUp | Down or up one stage height, less about a tenth so a line at the edge stays in view, as a browser scrolls |
| Space, Shift+Space | The same, but only while focus is on the dialog itself, as it is when the viewer opens. On a button, Space presses the button. |
| Home, End | The top of page 1, the bottom of the last page |
| ArrowUp, ArrowDown | A tenth of the stage, whenever the column is taller than the stage |
| ArrowLeft, ArrowRight | A tenth of the stage across, once zoomed wider than it |
| + or =, −, 0 | Zoom in, Zoom out (down to the page fit) and Reset zoom (to the width fit), keeping the place |

Each key handled is kept from the page under the dialog. These keys move by the view's position, as the page buttons do, so every press makes progress whatever the pages' heights, and Home and End set the indicator to page 1 and to the last page. When every page shows whole, the page keys do nothing (5.3). Escape and Android's Back close the viewer, as built.

### 5.7 Focus and screen readers

- **Focus** is as built: the viewer opens with focus on the dialog, and the keys work from any control in it. The pages take no focus, so scrolling never moves it. The overlay's controls follow 5.1.
- **Names.** The dialog is named by the handout's title, as built. Each page has exactly one name, "Strange letter, page 2 of 5": its image's `alt` once mounted, and until then its fill's, as `role="img"` with that `aria-label`. A fill whose image is mounted is `aria-hidden`. So a screen reader finds every page, in order, whether loaded or not.
- **Where you are.** After a page button, PageUp, PageDown, Space, Home or End, a visually hidden polite status line in the dialog says "Page 3 of 12" when the indicator's page changed, the page a button brought to the top after a button. Scrolling by touch, wheel or arrows says nothing, which would be chatty.
- **Close and Escape** as built: the header's Close, Escape, Android's Back (`backClose`), and focus back to the opener.

### 5.8 One page

A handout without `pages`, which is every handout from before and every one image shown from now on, behaves exactly as today: it waits for its image's size, the wheel zooms, there is no page row, the loading and failure messages are today's, and Download saves the image. A document of one page differs only in that its size is known ahead, so it lays out at once.

### 5.9 Where it opens

- **The popup**, for players: every page from `handoutPages` with its size, the title, Download and "The DM shows you", as built, with `showing` set to the handout's `showingKey`.
- **A Library tile**, for the DM: a tap opens a document with all its pages (8.1, 8.4), with no Download, as built, since the DM holds the pages. The DM panel's Showing now thumbnail, the saved upload's View and the form's View open the same viewer with the same pages and thumbs, read from the room as it is, and each closes when its item is closed or deleted elsewhere, focus going back to its opener or on in the section. If the document is deleted meanwhile, on this device or another, the viewer closes and focus moves by 8.4's rule (the next tile, the one before, the section's heading, the panel's first control).
- **A player's Library** lists the handout under Handouts from the DM as today, its row saying "12 pages" under the title. Open opens the popup at the remembered page. Its thumbnail, "View Strange letter", does what Open does: the popup, with Download, at the remembered page (the project owner, 2026-10-16). The popup opens over the Library, which stays open under it, so closing it comes back to the Library with focus on what opened it, on a phone's sheet as on a computer's side panel. Every viewer the Library and the DM panel open does the same (the project owner, after deploy).
- **The DM's "view as a player"** renders the player's page, popup included, so it shows every page as that player gets them.

## 6. Download

Today Download saves `<title>.webp`, or opens the share sheet on a phone that can share files.

- **One page:** unchanged, the existing prefetch, share and per-showing states included.
- **Two or more: a PDF built in the browser** (decision 2). A PDF can hold a JPEG as it is (the `DCTDecode` filter), so a PDF of image pages is a header, one page object, one content stream and one image object per page, a cross-reference table and a trailer: about 120 lines in `client/features/handouts/pdfWrite.ts`, with no new dependency.
- **How.** For each page in order: fetch its `full` WebP (from the cache when seen), decode it (`createImageBitmap`), draw it on a canvas, encode a JPEG at 0.92, keep the blob and free the rest. The writer takes the blobs with their pixel sizes and returns a `Blob` made of its text parts and the JPEG blobs, with every offset worked out from their sizes, so the JPEGs are never copied into one buffer. The JPEGs of a long handout take tens of MB until the file is saved.
- **The file.** Each page keeps its shape, with its long side 11 inches (792 points), a Letter page's, so it prints at a sensible size. The PDF's Title is the handout's title, written as a hex string in UTF-16, so every character survives and nothing needs escaping. The file is `<title>.pdf`, made safe as today (`handoutFileName`, `download.ts:43`, whose extensions gain `application/pdf`).

**Its lifecycle,** one model:

- **One build at a time** on a device. A build belongs to the showing in the popup and the press that started it.
- **Progress and Cancel** sit in the popup's lead line, where today's failure line sits: "Preparing the PDF: page 3 of 12" with Cancel. The header's Download says "Preparing…", busy, refusing a second tap. Closing the popup, or the popup moving to another showing, cancels a build that has not finished and frees its JPEGs.
- **The prepared file.** A computer saves it through a link at once and drops it. On a phone that shares files, the share sheet must open inside a tap, and building takes longer than a tap lasts, so the button becomes Share and the next tap opens the sheet (`downloadAction` "fetch", then "share"). The device keeps at most one prepared PDF, for the showing it was built for, and drops it when the popup closes or moves to another showing, when that handout closes, after a few minutes unused, or when the room is left. The Share state goes with it, back to Download.
- No PDF is prepared as the popup opens: it would fetch every page for every player, most of whom never download.
- **Failures** use today's words: "The handout could not be downloaded. Check your connection." with Try again.

## 7. Table display

- **One page at a time,** fitted whole, as one image is today. Under the title a line in the display's body size says "Page 2 of 5". Each showing starts at page 1, and the display remembers the page while that showing stays open. The display passes `showing` as the popup does, so a resync keeps the page and a new showing starts again.
- **Keys** (a remote or a keyboard): ArrowRight, ArrowDown and PageDown show the next page, and ArrowLeft, ArrowUp and PageUp the one before, stopping at the ends. Escape closes the handout on the display. Any other key, a tap or a click shows the handout's bar.
- **The handout's bar** lies over the page's bottom and never resizes it. It shows for 5 s after its last use, like the display's menu (`MENU_MS`, `logic.ts:123`): Previous page, Next page and Close, in the menu's TV-sized buttons (`TV_BUTTON_HEIGHT`). Its buttons wrap onto a second row where the screen is too narrow for one row, as on a phone or tablet used as a display, or with text at 130%. Opened by a key, it puts focus on Next page, or on Close on the last page, since `useMenu`'s first-button focus (`DisplayRoom.tsx:293`) would land on a disabled Previous page. While it shows, the arrows move between its buttons and Enter presses one, as in the menu. PageUp and PageDown still step pages. Escape hides the bar first, and a second Escape closes the handout. A tap outside the bar hides it. Previous page is disabled on page 1, and Next page on the last.
- **Loading.** The page showing and the next one load, so Next page is usually instant. A page that fails says so in its place, as one image does today ("The picture could not be loaded.").
- **One page** is unchanged: a tap or any key closes it.
- `displayPress` (`logic.ts:116`) gains the handout's bar as a state, with tests of its own. The X-card still shows over a handout, and a tap closes the card first.
- The DM does not steer the display's page (decision 4). Whoever stands by the TV steps it with its own keys and bar.

## 8. DM side

### 8.1 The Library

- **The Handouts section** (`LibraryGrid.tsx`, `ManagedLibrary` and `SECTIONS`) lists documents first, newest first, then the loose handout images as today. An image that any document names is not listed loose. A running job's pages are tagged "Uploading" on its device (4.1.2).
- **Documents need no listing.** They come from the DM's state, so they show while the asset listing loads or after it fails (today `ManagedLibrary` waits for the listing, `LibraryGrid.tsx:102`). A document's size in bytes shows once the listing arrives.
- **A document is showing** when a handout showing has exactly its pages, the same asset ids in the same order. One shared page, such as a blank page two documents both hold, does not count. This is only how the library describes a document. Which images may be deleted is the server's question (3.5).
- **A document's tile** is its first page's thumbnail, with a "12 pages" tag where an image's "Not in use" tag sits. Its name is "Strange letter, handout, 12 pages", with ", showing now" while it shows.
- **A tap opens it** in the viewer at its first page (8.4). Its details, "12 pages, 4.1 MB." (the pages' bytes, each image counted once) and "Showing now." when it is, show in the viewer's header, with Delete for the DM unless it is showing.
- **Delete** asks on a second tap, "Delete all 12 pages?", then runs 3.5. The note under the grid says "Deleted Strange letter and its 12 pages.", or names the pages kept because another handout uses them, or keeps a failed image delete's ids with Try again. A document never counts as "Not in use", so Clean up never offers it: deleting one is a choice the DM makes on that document.
- **While it shows** it has no Delete, as an image in use has none, and the viewer's header says "Showing now. Close it in the DM panel to delete it."
- **A loose image a showing handout names** is titled by that handout and page, "Strange letter, page 3" (`viewTitle` matches every page, not only `assetId`).

### 8.2 Show a handout

- **From the library** lists documents first, from the DM's state with no request, then the loose images from the listing as today. A document's tile has its tag and the name "Use Strange letter, 12 pages".
- Picking one shows its thumbnail, "12 pages", View and Change, and fills an empty Title with the document's title. This showing may use another title. The document keeps its own. A picked image has View too, which opens it as the Library does (the project owner, 2026-10-16).
- A title counts code points, as the protocol's `name` does (3.3), wherever it is typed, saved or shown, and the Title field holds 160 UTF-16 units, as the job's does, so a document saved under 80 emoji shows under its own title.
- Show sends `handout.show` with the document's pages and a new handout id, so the whole document shows. Picking one image sends `assetId`, as today.
- If the document picked is deleted meanwhile, on another device, the form lets it go and says "That handout was deleted."
- **Showing now** rows (`HandoutsSection`): the first page's thumbnail, the title, and "To Everyone, 12 pages". Close as today.

### 8.3 No per-page controls

The DM needs none to run the table. Players page on their own, the display steps its own pages, View shows the DM every page, and the upload's range picks the pages that make the handout. Showing one page of a saved document alone, renaming a document, reordering pages and making a document from several images are left out (decision 5).

### 8.4 Tiles open what they show

The project owner asked for this on 2026-10-16, for the DM and players alike: "rather than opening the view menu below the handout/image in library it should also just open it for players and the DM. We can entirely get rid of this view menu/expansion as it doesn't really do anything. Details of the file can be shown in the top bar when opened, and the 'in use' can be small text in the bottom right of the image. In general the library's DM and player views can be unified to be more like the player view." Also: tapping a handout's icon in the DM panel's Showing now opens it for the DM.

- **One tile, one tap.** In the Library panel every tile (a token image, a map, a handout image, a document) opens the viewer at once. The card under the grid (`Detail`, `LibraryGrid.tsx:244-293`) and the selected state that opened it are gone. A tile is a button named as today (with ", showing now" or ", not in use" where they apply), and Enter or Space opens it. The image picker's Library tab is unchanged: there a tap picks.
- **One look for the DM and players.** Both get the same tiles and the same viewer. The DM's panel keeps its sections (Handouts, Maps, Token images), since only the DM has the three kinds, and its Clean up at the foot. A player's panel stays one section of token images. Nothing a player may not see reaches them: a player's tiles are the images the server lists for them, as today.
- **A small status in the tile's bottom right corner**, for the DM: "In use", "Not in use", or for a document "Showing now". Small text on a solid fill, legible on any image, hidden from screen readers since the tile's name says it. It replaces the "Not in use" tag at the bottom left. A document's "12 pages" tag keeps the bottom left. Players' tiles have no status, as today.
- **The viewer's header carries the details** under the title, in small muted text: "280 x 280 px, 20 KB." for an image (the size once the listing has it), "12 pages, 4.1 MB." for a document, then "In use.", "Not in use." or "Showing now." for the DM. A credit line, when the image has one, follows in the header as the detail card showed it (`CreditLine`), so an openly licensed image keeps its attribution one tap away.
- **Delete moves into the viewer's header** for the DM, left of Close, on what the card offered it for: an image not in use, or a document not showing. It asks on a second tap as before ("Delete it?", "Delete all 12 pages?"). After a delete the viewer closes, the note under the grid reports it as today, and focus goes to the next tile in that section, else the one before, else the section's heading, else the panel's first control.
- **The viewer's identity** is the Library's `image:<id>` or `doc:<id>` key (5.1), so the remembered page and the reset rules hold.
- **Showing now in the DM panel** (`HandoutsSection.tsx`): a showing's thumbnail is a button named "View Strange letter", which opens the same viewer for the DM at that showing's own key, the one the players' popup uses, so the DM sees what the players see. Close stays where it is. Focus returns to the thumbnail when the viewer closes.
- **Tests.** e2e: the DM taps a library handout, the viewer opens with its details and credit, Delete in the header on a not-in-use image deletes it and focus lands on the next tile. A player taps one of their token images and the viewer opens, with no status and no Delete. The DM taps a Showing now thumbnail and the viewer opens at that showing. The reach sweep finds no card under the grid. Unit: the tile's name with each status, and the focus target after a delete.

## 9. Mockups

A player's phone, a document at its width fit, page 2 still loading:

```
+------------------------------+
| Strange letter  [Download][X]|
| The DM shows you             |
|+----------------------------+|
||                            ||
||          page 1            ||
||                            ||
|+----------------------------+|
|+----------------------------+|
||     (o) Loading page 2     ||
||                            ||
||[<] 1 of 3 [>]       [-][+] ||
+------------------------------+
```

The same at 320 px, magnified, where the page row takes its own line:

```
+--------------------------+
| Strange letter [Dl]  [X] |
| The DM shows you         |
|   zoomed page 1          |
|                          |
| [<] 1 of 3 [>]           |
|     [-][+] [Reset zoom]  |
+--------------------------+
```

The DM panel's Handouts section during a job, with the form open below it:

```
| HANDOUTS                                    |
| +-----------------------------------------+ |
| | Strange letter.pdf                      | |
| | Preparing page 3 of 12…                 | |
| | [######------------------]              | |
| | Keep this page open until it finishes.  | |
| | Title [Strange letter              ]    | |
| | [Cancel upload]                         | |
| +-----------------------------------------+ |
| Showing now ...                             |
| Show a handout (form, working as usual)     |
```

The block before uploading, then paused, then saved:

```
| Strange letter.pdf, 140 pages.                  |
| This PDF has 140 pages. A handout holds up to   |
| 100, so choose which.                           |
| From page [87 ]  To page [89 ]                  |
| Title [Strange letter                ]          |
| [Upload 3 pages]  [Cancel upload]               |

| The upload stopped at page 7 of 30.             |
| Check your connection.                          |
| [Try again]  [Cancel upload]                    |

| Saved as Strange letter, 12 pages.              |
| [Show it]  [View]  [Done]                       |
```

The DM's Library with a document open:

```
| HANDOUTS                                   |
| [page 1 ] [img] [img]                      |
| [12 pages]  Showing now   Not in use       |
+--------------------------------------------+

After a tap on the document's tile, the viewer:

+--------------------------------------------+
| Strange letter          [Delete] [X]       |
| 12 pages, 4.1 MB.                          |
|   page 1 at the width fit                  |
| [<] 1 of 12 [>]                   [-][+]   |
```

The table display, after a tap:

```
+----------------------------------------------------+
|                   Strange letter                   |
|                    Page 2 of 5                     |
|            +--------------------------+            |
|            |          page 2          |            |
|            |                          |            |
|            |[Previous page][Next page][Close]      |
|            +--------------------------+            |
+----------------------------------------------------+
```

## 10. Edge cases and states

Re-swept after round 1's changes.

### 10.1 By role

| Role | Gets | Notes |
| --- | --- | --- |
| DM | The job's block, the library's documents, Show a handout, View, Showing now. No popup, as today. | A job runs on the device that started it, and its ledger is that device's. |
| A second DM device | Documents and Showing now through the state. Its own job if it starts one. A running job elsewhere shows there as loose images. | A delete there closes this device's View of that document (5.9) and drops it from this form (8.2). Its Clean up during this device's upload is the `gone` answer of 4.1.5. |
| A player shown the handout | The popup with every page, the page buttons and keys, Download as a PDF, the Library's Open at the kept page | Pages are in their visible set from the moment it shows. |
| A player not shown it | Nothing. Every page URL answers 404. | Documents never reach any player. |
| A player removed from the room | As today: dropped from `to`, and a handout left with no one is closed | |
| The table display | Handouts shown to everyone, one page at a time (7) | Reads pages through its own route, by the same visible set. |
| "View as a player" | The previewed player's popup, every page | Writes nothing, as built. |

### 10.2 By size

The viewer keeps 100% at every interface size (`zoom={false}`, as built), so 130% changes the DM panel and the Library, never the viewer.

| Size | Viewer | Page row and zoom buttons | Job block, form and Library |
| --- | --- | --- | --- |
| 320 x 480 | Whole screen. A Letter page at the width fit is a little taller than the stage. The page fit shows it whole. | One row at the width fit, where Reset zoom is hidden. Magnified, or zoomed out to the page fit, Reset zoom shows and the page row moves above. | The block's progress line wraps to two lines, and its buttons wrap. |
| 320 x 480 at 130% (246 x 369) | As at 100% | As at 100% | The block and the form at 246 px: every line wraps, the range fields stack, nothing scrolls sideways. |
| 390 x 844 | Whole screen. A little more than one page per screen at the width fit. | One row | As today |
| 844 x 390 | Whole screen from the start (a short layout). A page at the width fit is about three stages tall, so the page buttons, PageDown and the page fit matter most here. | One row | The sideways sheet, or the very short mode, as built |
| 820 x 1180 | A card that grows to the window when a pinch ends past the card's width fit, as built | One row | As today |
| 1280 x 800 at 100% and at 130% | A card. Zoom out reaches the card's page fit, which shows a whole page. Zoom in, the wheel with Ctrl, or Expand grow it to the window, keeping the place. | One row | As today |
| Turning a phone while reading page 14 | The stage changes size and page 14 stays at the stage's center (5.2). | Move with the stage | |
| A phone or tablet used as a display | The page fitted whole under the title | On a phone the bar's buttons wrap onto two rows over the page. The display's text size does not scale the bar (`TV_TEXT`), so at 130% text it keeps one row | |

### 10.3 By page count and shape

- **1 page:** an image, or a one-page document. As today (5.8). Download saves the image.
- **2 pages:** page row, scrolling, keys and the PDF download. Whether page 2 loads at once depends on its distance from the screen, not its number (5.4). Two short pages that fit the stage together read "All 2 pages" (5.3).
- **30 pages:** only the pages near the screen load. End or Next page reaches page 30, and page 1 unmounts once it is far away. A fast fling defers loading until it slows. A phone takes a while to prepare it, often a few minutes at most.
- **100 pages, the cap:** the column is about 210,000 page pixels tall before its scale, far under every browser's layout limit. Several minutes to prepare on a phone is possible. The room's 2,000 pages hold 20 such documents, or 10 while each one shows. An export of such a room fits the raised import caps (3.6).
- **More than 100 pages:** the range picks up to 100 (4.1.3). A range that would pass the room's page limit is refused at the fields.
- **Mixed shapes:** a landscape page among portrait ones sets the column's width (5.2). A rotated page (`/Rotate 90`) draws upright, as a reader shows it.
- **A huge page,** such as a 200 inch poster: drawn with its long side at 2048 px like any page, so its small print is lost at that size, and the zoom only enlarges what was drawn (4.2.2). A huge image inside a page is the `maxImageSize` rule of 4.2.3.
- **A tiny page,** such as a business card: drawn with its long side at 2048 px, crisp, and about as large as the other pages that face its way.
- **An extreme strip,** such as a 1 by 50 inch scroll: about 41 x 2048 px, a thin column. Fine in the stack, and alone it fits whole as one page does.
- **Blank or repeated pages:** one asset, listed once per page (3.1). Two documents sharing only a blank page stay independent: showing one does not mark the other, and each keeps its Delete (8.1).
- **A page with transparency:** drawn on white (4.2.2).

### 10.4 By PDF

- **Password to open:** refused. **Owner password only:** opens.
- **Broken, or not a PDF:** refused. **Some damage:** pdf.js draws what it can (`stopAtErrors` stays false). **A page that cannot draw, or whose image cannot be decoded:** the job pauses on it, with Leave this page out (4.1.6).
- **Dynamic XFA form:** refused. **Hybrid form:** its AcroForm draws.
- **JavaScript inside:** never runs (4.2.4). **Links:** pictures only. **Filled form fields:** drawn as a reader shows them.
- **Optional content (layers):** drawn as the PDF's default view says, which may include a layer meant for the DM. There is no layer picker, and the DM checks in View before showing.
- **Scanned pages** (JBIG2, CCITT fax, JPEG 2000): drawn through the decoders, which the worker checks before any page (4.2.1). A decoder that does not load stops the job at open. A scanned image that fails to decode fails its page. Neither is ever uploaded blank.
- **Fonts not embedded:** standard fonts fall back to system fonts. Chinese, Japanese or Korean text in a font without its character map draws nothing, which the DM sees in View. Bundling the character maps (about 1.6 MB) is not proposed.
- **A portfolio** (a PDF of embedded files): only its cover pages show.
- **Large scans and many embedded fonts or images:** the document's caches are cleaned between pages (4.2.3).
- **A title that is junk, missing, or full of emoji or text direction characters:** cleaned, cut to 80 UTF-16 units without splitting a character, and never empty (4.1.3).
- **Over 100 MB:** refused before reading.

### 10.5 By upload, network and lifecycle

| Case | Outcome |
| --- | --- |
| Offline mid-upload | Pauses at the page, badged, and toasted while the block is out of sight. Try again goes on from there. |
| Cancel after a page reused a loose image the DM kept | The kept image stays: the job deletes only pages with `created: true` (4.1.2). |
| Two uploads of the same bytes at once, then one cancels | The other upload's reused pages may go with the canceller's own. Its save then finds them gone, uploads them again and saves (4.1.5). Library images from before either upload are never touched. |
| Cancel while an upload is sending | Retries stop at once. The upload gets `CANCEL_GRACE_MS`, about 10 s, to answer, then is aborted. A page that answered is removed if the job made it. A page that never answered is recorded as uncertain and named, with its size, in the summary and in the device's recovery (4.1.6). |
| An upload whose answer never settles, then Cancel | The same: Cancel ends within the grace, and another PDF can start. |
| Cancel offline | The cleanup fails, the ledger stays, and the device's recovery offers Remove them next time. |
| Cancel while "Saving the handout…" | The job waits for the create's answer, deletes the document if it was saved, then its own pages (4.1.6). |
| The create's answer lost, then a reconnect | "Checking whether the handout saved…" until the current connection's snapshot is in, even when the store reported the op as too old before its hello. Then the document is there, or the create is sent again under the same id (4.1.5). Never two documents, never stuck, and no retry before that snapshot. |
| The create expired before the reconnect, having committed, or never applied, and Cancel pressed during the check | The check finishes first. If the document is there, it is deleted, then the job's pages. If not, only the pages. Nothing is decided from the stale state before the snapshot. |
| A document delete's answer lost, from Cancel or the Library | "Checking whether the handout was deleted…" until the snapshot. Gone: its images are deleted. Still there: "The handout was not deleted." with Try again (3.5). |
| Every page of the range left out | "No pages were uploaded." with Try again, back to the range, and Dismiss. No create is sent (4.1.6). |
| An image picked in the form, or a player's token image, during a job | This device's queue sends a waiting image before the job's next page. While other members are online, the job pauses after each page so their uploads on the same IP find the slot (4.1.4). |
| Offline when the create is sent | It waits in the outbox. The block says "Waiting for the connection to save." |
| An invalid title, generated or typed | Never generated (4.1.3). A typed one is refused beside the field, and the save waits for a valid one. |
| Clean up on this device during an upload | The job's pages are not listed as loose there, so Clean up cannot take them (4.1.2). |
| Clean up on another device during an upload | The save is refused `gone`, and Try again uploads the missing pages again (4.1.5). |
| The previous page's upload finishes while the next page draws | No conflict: the canvas was reset after the previous encode, and an upload holds only its blob (4.1.4). |
| The native worker cannot start | The reader's refusal. pdf.js's main-thread fallback never runs (4.2.1). |
| A decoder request fails | The job stops at open. A page is never uploaded blank (4.2.1). |
| The room's storage quota is full | The job stops with Try again after the DM frees space. Documents can still be deleted to free it (3.3). |
| The page is hidden during drawing, upload or save | No new work starts. What is under way settles. The job resumes when the page shows, trying a failed upload once more (4.1.4). |
| Closing the DM panel mid-upload | The job goes on, its block returns with the panel, and its pauses are toasted and badged. The form's draft is kept. |
| A reload mid-upload | A warning first where the browser gives one. Then the device's recovery: "A PDF upload did not finish", with Remove them and Keep them. |
| Leaving the room mid-upload | Leave room asks once. Back at the room's root leaves without asking. Either way, then as a reload. |
| A player offline while reading | Pages already loaded stay. A page not yet loaded fails in its own box with "Try page 7 again", under the connection banner. Back online, the resync sends the same showing, so the viewer keeps its page and zoom (5.1). |
| A player reloads while reading | The popup does not reopen a handout closed on this device (as built). Opened again, it starts at page 1, since the remembered page is not stored. |
| A player's 100-page download on a phone | Progress and Cancel in the lead line. Closing the popup cancels it. The JPEGs are held only until the file is saved (6). |
| A download for handout A while the popup moves to B | Moving to B cancels A's build. B starts clean (6). |
| Download offline | Today's error and Try again. |

### 10.6 By room state

- **Blackout:** players get no handouts at all (3.4). Lifting it shows the popup again, at the page remembered for that showing on this device.
- **The X-card:** the popup waits, and on the display the card shows over the handout, as built.
- **The DM closes it while a player reads:** the popup moves to the next handout or closes, as today.
- **The DM shows another while a player reads page 14:** the popup moves to the newer one, at its own remembered page or page 1. Opened again from the Library, the first returns to page 14.
- **The same document shown anew:** a new showing key, so the viewer starts again at page 1 and the width fit. A resync of the same showing keeps the page and zoom.
- **Undo:** of a show, the handout leaves. Of `handoutDoc.create`, the document goes and its pages are loose, "In use" and titled by page while a handout still shows them (8.1). Of `handoutDoc.delete`, the document comes back while its pages still exist, and is refused once they are gone (3.5).
- **Two DM devices race Delete against Show:** if the show is applied first, it shows, and the delete's image cleanup keeps every page the showing names. If the images are deleted first, the show is refused "that is not here", and the showing device's form says "That handout was deleted."
- **Export and import:** every page travels and every reference is remapped (3.6).
- **The room's page limit:** checked at the range, and refused in words at save or show, the show's words saying why showing counts again (3.7).
- **Rollback:** a restore of the backup taken before the update (3.8).

### 10.7 Self-review against this matrix

Each row above has a rule, checked against the settled points at the top, the decisions of section 14, and the code at `e4ec8696` before commit. The first draft's seven checks still hold: the hourly budget, the kept place, the wheel's line mode, XFA detection, the decoders, the eval test and the import caps. Draft 2 re-swept every row after the three root models and the decisions, and added the rows round 1 named, in 10.2, 10.3, 10.4 and 10.5. Draft 3 swept again after round 2's three classes: every place the doc settles an `unknown` answer now goes through the one checking rule of 4.1.5 (3.5, 4.1.5, 4.1.6, 10.5), every way of paging moves by the view's position (5.3, 5.6, 5.7), and every wait on an upload during Cancel is bounded by the grace (4.1.6, 10.5). The 320 px row of 10.2 follows the new Reset zoom rule.

## 11. Tests

### 11.1 Unit (`node:test`)

- `shared/protocol.test.ts`: both shapes of `handout.show`, one with both `assetId` and `pages` refused, `pages` of 1 and of 100 accepted, 101 refused, sizes of 0 and of 8193 refused, `handoutDoc.create` and `handoutDoc.delete` bounds, a title of 80 code points accepted (80 dragon emoji included) and 81 refused. The whole client message for a show of 100 pages with 64-character ids, an 80-character title and 50 recipients serializes under a quarter of `MAX_FRAME_BYTES`.
- `shared/reducer.test.ts`: a show with pages writes `assetId` from the first page, a re-show as one image drops `pages`, `handoutDoc.create` sets `createdAt` and refuses an id in use, and `handoutDoc.delete` of a missing document is `gone`.
- `shared/permissions.test.ts`: both document ops are the DM's. A show or a create with a map, a token image or another room's image among its pages is `gone`. Restoring a deleted document whose page is gone is refused.
- `shared/project.test.ts`: a player shown a handout gets every page and size, and a player not shown it, a blacked-out player and a display for a handout to chosen players get nothing. `handoutDocs` is empty for players and the display and whole for the DM. `visibleAssetIds` holds every page for a player shown the handout and none for the rest.
- `shared/referencedAssets.test.ts`: the pages of documents and handouts, kind `handout`. `restoreAddedAssets` for a document put back.
- `shared/limits.test.ts`: the room's handout pages counted across documents and showings, a document shown counted again, and the save's and the show's words.
- `shared/migrate.test.ts`: version 8 to 9 adds `handoutDocs`, a state that has it is left alone, and version 9 refuses to migrate to 8.
- `shared/reads.test.ts`: `handoutDoc.create` reads nothing and `handoutDoc.delete` reads its key.
- `shared/handouts.test.ts` (new): `handoutPages` with and without `pages`.
- `server/rooms/stateSchema.test.ts`: a stored handout without `pages` loads, one with pages loads, a document loads, 101 pages are refused.
- `server/rooms/remap.test.ts`: pages of documents and handouts remapped in order, a page that did not come through or came as another kind dropped, a document or a handout with none left dropped, a handout's `assetId` following its first remaining page.
- `server/rooms/undoLabels.test.ts`: the two new phrases.
- `server/rooms/actor.test.ts`: `withAssetSizes` gives each page its row's size in a show and in a create, and a page with no row keeps the client's numbers for authorization to refuse. A room at its storage quota accepts `handoutDoc.delete` and refuses `handoutDoc.create`.
- `server/assets/limits.test.ts` (new): `hourlyChecks`, moved out of `AssetService` as a plain function of the kind, session, IP and room so it is tested without a pool. A handout uses the handout budget, per session and per room, and a token keeps the shared one.
- `server/rooms/importRoom.test.ts`: `IMPORT_LIMITS` leaves room for the room's handout pages at two entries each, plus `room.json` and `assets.json`, and the manifest's byte cap holds that many handout pages as an export writes them.
- `client/features/handouts/zoom.test.ts`: the gap at about 2% of the widest page. The page fit and the width fit, the floor in each state, the step order out of magnified on a card and with Expand, Reset zoom to the width fit, and a column that fits whole. `currentPage` at the top, mid-page, on a tie, and at the end with a short last page. `pageStep` both ways, at the ends, keeping the zoom. `visiblePages` with its two margins, on tall and on wide pages. PageDown, PageUp, Space, Home and End. Scrolling by pixels, lines and pages, and sideways once zoomed. The end's padding. `flingStep` stopping at the ends, and traveling the same distance in the same time at 60 and at 120 frames a second. A touch during a fling counted as no tap. The anchor kept across Zoom out to a fit, Reset zoom, Expand, the card growing and shrinking, and a resize from 390 x 844 to 844 x 390 on page 14. A start at a remembered page. One page unchanged in every step. Round 2's cases: Previous page and Next page pressed again and again across mixed heights (a 390 x 700 stage with pages about 390, 301, 390 and 390 px tall) reach both ends with every press moving the view, at the width fit and zoomed out below it, Next page clamped at the end, and the indicator holding the aligned page until the view moves another way. Reset zoom hidden at the width fit and shown above and below it. A double tap below the width fit going to the width fit about the tap.
- `client/features/handouts/pdf/title.test.ts`: XMP before Info, the cleaning rules, 41 emoji and 80 dragon emoji cut to 80 UTF-16 units without a split pair, a file name with text direction characters, an empty stem falling back to "Handout", each rejected form falling back to the file name, and every result passing the `name` schema.
- `client/features/handouts/pdf/job.test.ts`: the job's pure step function through loading the reader, opening, each refusal, the range and its rules, the room's page limit at the range, preparing, each pause and its Try again from the right page, Leave this page out, the hidden page, Cancel upload from every phase (before the create, while it is queued, after it is taken, after it is refused, after `unknown`), the save's `taken`, `refused`, `gone`, `unknown` both ways and a `null` dispatch, and done. The checking rule: an `expired` create that committed and one that never applied, each with and without Cancel pressed during the wait, checked only after the current connection's snapshot, and the same four cases for a document delete. An upload whose answer never settles, then Cancel: retries stop, the job aborts it after `CANCEL_GRACE_MS`, records the page as uncertain, removes its known pages and ends. Every page left out: "No pages were uploaded", no create dispatched. The upload queue: a waiting image goes before the job's next page, and the job pauses `SHARE_PAUSE_MS` after each page while another member is online and not when alone. Ownership: only `created: true` pages are deleted, and a reused page never is. The ledger written per owned page, cleared on save and on a finished cancel, and its recovery cleared quietly when the document exists.
- `client/features/handouts/pdf/options.test.ts`: `PDF_OPTIONS` pinned: `useWasm` false, `enableXfa` false, `verbosity` warnings, no `cMapUrl`, `standardFontDataUrl` or `iccUrl`, `wasmUrl` the version folder, `maxImageSize` and `canvasMaxAreaInBytes`. `IMAGE_FAILURES` against the warning texts in the pinned pdf.js. The render scale for portrait, landscape, tiny, huge and strip pages. The encoder's fallback from WebP to JPEG, and its steps down in quality then size until a page fits.
- A test that reads the installed `pdfjs-dist/build/pdf.min.mjs`, `pdf.worker.min.mjs` and the two decoders and finds no `eval(` and no `new Function`, so an upgrade that brought one back fails the run.
- `client/features/handouts/pdfWrite.test.ts`: a written PDF read back with pdfjs-dist's legacy build, which pdf.js documents for Node: its page count, each page's size with its long side 792 points, the title with non-ASCII characters, every cross-reference offset pointing at its object, and each page's operator list painting one image of that page's pixel size.
- `client/features/handouts/download.test.ts`: `<title>.pdf` from `handoutFileName`. The build's lifecycle as a pure state: one at a time, cancelled by Cancel, by the popup closing and by moving to another showing, the prepared file kept for one showing, dropped on each listed event, and Share cleared with it.
- `client/features/handouts/handouts.test.ts`: the page names, "Strange letter, page 2 of 5". The show op from a document.
- `client/state/store.test.ts`: an op too old to resend answers `unknown` marked `expired` from `prepareHello`, and one a reconnect's snapshot settles answers `unknown` marked `snapshot`.
- `client/features/handouts/pdf/worker.test.ts`: the `console.warn` filter, a pure function, forwards only lines matching `IMAGE_FAILURES`, and only while a page draws.
- `client/features/images/library.test.ts`: documents and loose images grouped, an image a document names left out of the loose list, a running job's pages tagged and left out of "Not in use" and Clean up, a document "showing" only when a showing handout has exactly its page sequence (two documents sharing only a blank page among the cases), the bytes counted once per image.
- `client/features/images/LibraryGrid.test.ts`, where `viewTitle` lives: `viewTitle` naming a later page.
- `client/features/display/display.test.ts`: `displayPress` with the handout's bar: a tap on a document opens the bar, the page keys step and stop at the ends, PageUp and PageDown still step with the bar open, the bar's arrows move between its buttons, first focus on Next page or on Close on the last page, Escape hides the bar then closes, and one page is unchanged.

### 11.2 Integration (`*.itest.ts`, Postgres)

- `server/http/assets.itest.ts`: a player shown a three-page handout reads every page's `full` and `thumb`. A player not shown it gets 404 for each. After close, 404. A document's pages are never readable by a player. The display reads the pages of a handout to everyone and not of one to chosen players. A handout upload answers `created: true` for new bytes and `false` for bytes the room has, two concurrent identical uploads get exactly one `true`, and a token upload has no `created`.
- `server/assets/cleanup.itest.ts`: a document's pages are `inUse` in the DM's listing, and deleting them answers `asset_in_use`. After `handoutDoc.delete` they are not in use and delete. A page two documents share stays after one is deleted. At the storage quota, `handoutDoc.delete` and then the image delete free the room.
- `server/http/export.itest.ts`: a room with a document and a showing three-page handout exports and imports with every page row, every reference remapped, the kinds kept and the page order kept.
- `server/rooms/projection.itest.ts`: the event a player receives for a 100-page show, and a reconnect's snapshot, carry every page.

### 11.3 End to end

A new `e2e/pdf.e2e.ts` on `E2E_PORT` plus 12, run after the other files. A helper, `e2e/pdfFixture.ts` (new), writes small vector PDFs: pages of given sizes, each with a band of its own color in its top-left corner and "Page N" in Helvetica, and an Info Title. Pixels are checked on what the server stored: the test reads a page's `full` WebP with sharp in Node and finds the band's color at the band's place, so a blank, misordered or rotated page fails. Fixtures committed in `e2e/fixtures/`, with a note on how each was made and its license: `password.pdf` (one page from the helper, encrypted with qpdf), `embedded-font.pdf` (one page in an embedded subset of an OFL font, such as Liberation Sans, with a reference image of its text box), and `jbig2.pdf`, `ccitt.pdf` and `jpx.pdf` (one page each, a black shape at a known place, made with jbig2enc, libtiff's tiff2pdf, and OpenJPEG with img2pdf).

1. **Upload.** The DM at 1280 x 800 uploads a three-page PDF (Letter portrait, Letter landscape, A5) titled "Strange letter" with "Upload a file": "Loading the PDF reader…", the range showing pages 1 to 3, Upload 3 pages, "Preparing page N of 3", and "Saved as Strange letter, 3 pages". Every request during the job goes to the app's origin and is one of the pdf.js chunk, the job's worker, the two decoders, the asset uploads and the room's socket. No `securitypolicyviolation` event fires. The state holds one document whose pages have the sizes the uploads answered, and each stored page's band has its color in place.
2. **The range.** A generated 140-page PDF starts at 1 to 100 with its sentence. Pages 87 to 89 upload three pages whose bands are pages 87, 88 and 89's.
3. **Refusals.** `password.pdf` and random bytes named `.pdf` show their sentences with no upload request. A worker whose script the test's route blocks gives the reader's refusal, and no PDF is parsed on the page's thread. A blocked decoder request stops the job at open.
4. **Decoders and fonts.** `jbig2.pdf`, `ccitt.pdf` and `jpx.pdf` each store a page with its black shape in place. `embedded-font.pdf` stores a page whose text box matches its reference image within a tolerance.
5. **Ownership and Cancel.** A page whose bytes already sit in the library as a kept loose image is reused (`created: false`). Cancel upload after page 3 removes the job's own pages and keeps that image. In a second run the test's route never answers page 4's upload: Cancel ends within about the grace, and the summary names page 4 as possibly left over.
6. **The job outside the form.** During a generated 30-page upload: the DM closes the DM panel and reopens it on the same progress, From the library and Show still show another handout, the 4th upload aborted by the test's route pauses the job with a toast and the DM panel's badge, and Try again finishes all 30. An image uploaded in the form meanwhile is sent before the job's next page. At 390 x 844 the Panels button counts the waiting job and its badge says "1 upload waiting". A reload mid-upload gives the recovery line, and Remove them deletes exactly the ledger's pages.
7. **The player's popup** at 390 x 844 after Show: the page row reads "1 of 3". Page 2's `full` is held back by the test, its box is laid out at its aspect before the image arrives, and its `thumb` appears after the wait. A tap on Next page shows page 2, and the status line says "Page 2 of 3". A drag up and a fling move the indicator. Each page is named "Strange letter, page 2 of 3". At 320 x 480, magnified, the page row and the zoom buttons do not intersect. A failed page's "Try page 2 again" is at least 44 px at the width fit and takes a tap. With focus on it, scrolling its page out of the overlay hands focus to a page button, and the stage has not scrolled under the view.
8. **Keys and zoom** as a desktop player: PageDown, Space with focus on the dialog, End, Home and the status line's words. Next page pressed until disabled, then Previous page until disabled, crosses every page of the mixed-height fixture. At rest Reset zoom is hidden. Zoom out from the card's width fit reaches the page fit, where a whole page shows, and stops there. Reset zoom returns to the width fit on the same page. **Wheel:** a line-mode wheel event scrolls at least 100 px. **Turning:** from 390 x 844 on page 2 to 844 x 390, page 2 is current.
9. **Identity and the kept page.** The player closes the popup on page 2 and opens it again from Handouts from the DM: it opens at page 2. The DM closes and shows the same document again: the player's popup starts at page 1. A forced reconnect on page 2 keeps page 2.
10. **Thirty pages:** on opening, only the pages near the screen have been requested. After End, page 30 is loaded and page 1's image is unmounted.
11. **Download** as a desktop player: the file starts with `%PDF-`. The DM uploads that file again, and the stored pages' bands are in order, upright and colored as the originals. On a phone-sized player, Cancel in the lead line stops a build, and closing the popup mid-build leaves no Share.
12. **The Library:** the document's tile with "3 pages" and "Showing now", a tap opening the viewer with "3 pages" and "Showing now." in its header and no Delete while it shows. After Close, two taps on the header's Delete remove the document and its pages from the listing (8.4). A second document sharing only a blank page with a showing one keeps its Delete.
13. **View as a player:** the popup with three pages.

In `e2e/display.e2e.ts`: three PNG pages uploaded and shown to everyone with `pages` through the op socket. The TV shows page 1 and "Page 1 of 3". ArrowRight shows page 2's image. A key opens the bar with focus on Next page, the bar overlays the page without resizing it, Next page shows page 3, Escape hides the bar, and a second Escape closes the handout. A one-page handout still closes on a tap.

In `e2e/size.e2e.ts`'s sweep of every dialog at every size and at 130%: a three-page handout's popup, and the DM panel's job block at 246 px wide.

Screenshots at the steps that change what is on screen, through the harness's numbered shots.

### 11.4 On real devices

- An iPhone and an Android phone each prepare a 100-page scanned PDF of large images, with the page hidden once mid-job. The build records the time taken and that the tab survived. iOS Safari is checked by hand, as the e2e runs in Chrome only. The project owner waived these before merge on 2026-10-16: the owner tries a PDF upload on an iPhone after the deploy, and a phone problem found then is fixed in a follow-up.
- A rollback rehearsal on a scratch setup: back up with the older build, update, upload a PDF, restore the backup on the older build, and load a room. It loads, without the document.

## 12. FEATURES.md

In "Log, chat and handouts", the Handouts line gains, after its first sentence: "A handout can also be a PDF: Upload a file in Show a handout takes an image or a PDF. The DM chooses which pages, up to 100, and the DM's browser turns them into pages, showing its progress in the DM panel, and names the handout after the PDF's title or file name. Players scroll it like a PDF, page with the Previous page and Next page buttons or Page Up, Page Down, Space, Home and End, and zoom over the whole document, down to a whole page. Download saves a handout of several pages as a PDF. A PDF with a password or an XFA form is refused, and nothing inside a PDF runs."

In "Images and art", after the library's line on opening an image: "The DM's library shows a PDF handout as one item with its page count. A tap opens it with every page, and Delete removes it with its pages."

In the table display section:

- New: "A handout of several pages shows one page at a time, with its page number. The arrow and page keys step through it, and a tap shows Previous page, Next page and Close."
- The menu line's last sentence becomes: "While the X-card or a one-page handout is open, a tap closes it instead."

## 13. Build plan

One build, in six parts, each its own commits, in this order: parts 2 to 6 read the model of part 1, and parts 4 and 5 need part 3's dependency.

1. **The model, the ops and the server** (section 3).
   - `shared/model.ts`, `shared/handouts.ts` (new), `shared/protocol.ts`, `shared/reducer.ts`, `shared/reducer/misc.ts`, `shared/permissions.ts`, `shared/reads.ts`, `shared/keys.ts`, `shared/project.ts`, `shared/referencedAssets.ts`, `shared/limits.ts`, `shared/migrate.ts`, `shared/initial.ts`.
   - `server/rooms/stateSchema.ts`, `remap.ts`, `sizeGuard.ts`, `undoLabels.ts`, `actor.ts` (`withAssetSizes`, and `handoutDoc.delete` in `DELETIONS`), `importRoom.ts` (`IMPORT_LIMITS`, 3.6).
   - `server/assets/service.ts` and `store.ts` (`HANDOUT_HOURLY`, `created`, and `hourlyChecks` moved to `server/assets/limits.ts`), `server/http/assets.ts` (the answer's `created` on a handout upload), `client/lib/api.ts` (`AssetRow.created`).
   - Commits: `feat(handouts): a handout holds its pages in order`, `feat(handouts): documents of pages in the dm's library`, `feat(assets): handout uploads say whether they made the image, and get an hourly budget of their own`.
2. **The viewer** (section 5).
   - `client/features/handouts/zoom.ts`, `HandoutViewer.tsx` (the overlay, the page row, `showing`), `HandoutPopup.tsx`, `pageMemory.ts` (new, the remembered page), `handouts.ts`.
   - Commit: `feat(handouts): the viewer pages through a handout like a pdf`.
3. **Rendering** (section 4.2).
   - `package.json` and `pnpm-lock.yaml`: `pdfjs-dist` exactly `6.3.289`. This part's task must say it may edit them.
   - `vite.config.ts`: a small plugin that copies the two decoders and the license files to `pdfjs/6.3.289/` in the build and serves the same path in development.
   - `client/features/handouts/pdf/` (new): `worker.ts`, `options.ts` (`PDF_OPTIONS`, `IMAGE_FAILURES`, the lazy load), `render.ts`, with their tests.
   - Commits: `build: pdfjs-dist 6.3.289 for pdf handouts`, `feat(handouts): draw pdf pages in a worker that checks its decoders`.
4. **The upload job** (section 4.1).
   - `client/features/handouts/pdf/`: `title.ts`, `job.ts` (the step function and `pdfJobSlot`), `ledger.ts`, `run.ts` (drives a job), with their tests.
   - `client/features/handouts/HandoutsSection.tsx`: the job's block, the recovery line, the form's draft in the room scope, Upload a file, documents in From the library, and Showing now's page count.
   - `client/lib/api.ts`: the device's upload queue in `uploadAsset`, and its `background` option. `client/state/types.ts` and `store.ts`: each `unknown` answer marked `snapshot` or `expired`, with its test.
   - `client/pages/Room.tsx`: the DM panel's badge, the Panels button's count, and `beforeunload`. `client/pages/RoomChrome.tsx`: `Badge` takes a spoken label. `client/panels/MenuPanel.tsx`: Leave room asks while a job exists.
   - Commit: `feat(handouts): upload a pdf as one handout of pages`.
5. **The library and download** (sections 6 and 8).
   - `client/features/images/LibraryGrid.tsx`, `library.ts`, `client/panels/LibraryPanel.tsx`.
   - `client/features/handouts/pdfWrite.ts` (new), `download.ts`, `HandoutPopup.tsx`.
   - Commits: `feat(library): a pdf handout as one item with its pages`, `feat(handouts): download a handout of pages as a pdf`.
6. **The table display** (section 7).
   - `client/features/display/DisplayRoom.tsx`, `logic.ts`.
   - Commit: `feat(display): step through a handout's pages on the table display`.

Then:

- `e2e/pdf.e2e.ts`, `e2e/pdfFixture.ts`, `e2e/fixtures/` with its note, the display steps in `e2e/display.e2e.ts`, and the `size.e2e.ts` cases: `test(e2e): pdf handouts from upload to the table display`.
- The device checks and the rollback rehearsal of 11.4, recorded in the build's report.
- Docs: `FEATURES.md` (section 12), `docs/features.md` section 16 and its table display line, `docs/design-v1-layout-hierarchy.md` 5.4 pointing here, and `docs/design.md` sections 6 (the model, near `:350`), 7.3 (handouts, `:567`), 8.1 (the ops catalog, `:729`), 10.5 (the limits table, `:1142`), 11.1 (the hourly budgets, `created`, and pages as ordinary handout uploads), 11.2 (the visible set, `:1288`) and 16.4 (the remap and the import caps, `:2043`): `docs: pdf handouts in the feature lists and the design`.
- README, Updating: this update changes the snapshot version, so going back to the older build means restoring the backup taken just before it, and rooms changed since lose those changes. Reload every open page, table displays included.
- Deploy notes: back up first, as the README says. The snapshot step runs on load.

## 14. Decided

The project owner settled these. Decisions 1 to 5 were the first draft's questions, accepted as recommended. Decisions 6 to 8 came from the design review's round 1.

1. **The page cap.** 100 pages per handout and document, a 100 MB file, and 2,000 handout pages per room (3.7).
2. **Download of several pages:** a PDF built in the browser by our own writer, with no new dependency (6). pdf-lib, the current page only, and a zip were the alternatives.
3. **Scanned PDFs:** the two plain JavaScript image decoders ship with the app and load from its own origin (4.2.4). Without them, the images scanners write would fail to draw.
4. **The table display's page:** the display steps its own pages with its keys and bar, and the DM's device does not steer it (7).
5. **Later, not now:** showing one page of a saved document alone, renaming a document, reordering pages, and making one handout from several images (8.3).
6. **Zoom out to a whole page:** for two or more pages, readers zoom out below the width fit, down to the page fit, and Reset zoom returns to the width fit, keeping the place (5.2).
7. **A page range:** the upload offers From page and To page for any PDF. Over 100 pages, choosing a range replaces the refusal (4.1.3).
8. **A low-resolution copy while slow:** a page whose full image is slow shows its 512 px thumb first, only after a short wait (5.4).

## 15. Review findings and the rules that answer them

Reviewers: sol (SOL), astra (PDF-ASTRA) and Opus (PDF-P). Every finding of both rounds was adopted.

### 15.1 Round 1

| Finding | Answered by |
| --- | --- |
| SOL-01 | 3.8: rollback is a restore of the pre-update backup, rooms changed since lose those changes, the README says so, and 11.4 rehearses it. |
| SOL-02 | 3.3: `handoutDoc.delete` joins the quota deletion list, tested in 11.1 and 11.2. 4.1.6 splits grant loss from read-only. |
| SOL-03 | Upload job, 3.9 and 4.1.2: the job deletes only rows whose answer said `created`. |
| SOL-04 | Upload job, 4.1.5 and 4.1.6: a stable document id, `unknown` reconciled against confirmed state, and Cancel defined before, during and after the create. Document deletion follows the same answers (3.5). Round 2 checks only against a fresh snapshot (15.2). |
| SOL-05 | Upload job, 4.1.3: one cleaner for every title source, 80 UTF-16 units without a split pair, never empty. 4.1.5 validates before saving and handles a `null` dispatch. |
| SOL-06 | 8.1: showing means the whole ordered page sequence, kept apart from asset protection (3.5). |
| SOL-07 | 3.7: the frame rule stated, the worst case about 14 KB with its envelope, and the whole message tested (11.1). |
| SOL-08 | Section 14 records the decisions, and the text no longer asks. |
| PDF-ASTRA-01 | Upload job, 3.9 and 4.1.2: ownership by `created`, so a kept loose image is never deleted (11.3 step 5). |
| PDF-ASTRA-02 | Upload job, 4.1.5 and 4.1.6: `unknown` reconciled, Cancel waits for and compensates a create, an upload is let answer, and an unseen leftover is reported. Round 2 adds the fresh snapshot and the bounded grace (15.2). |
| PDF-ASTRA-03 | Upload job, 4.1.3 and 4.1.5: schema-compatible titles from every source, typed titles validated, `null` dispatch handled. |
| PDF-ASTRA-04 | Upload job, 4.1.4: the canvas is reset after each encode, and an upload holds only its blob. |
| PDF-ASTRA-05 | Rendering safety, 4.2.1: the job's own native worker, handed to pdf.js as its port, with no main-thread fallback and a defined owner that terminates it. |
| PDF-ASTRA-06 | Rendering safety, 4.2.1: decoders loaded and built before any page, image failures forwarded as page failures, and Try again in a fresh worker. Real decoder fixtures checked by pixels (11.3). |
| PDF-ASTRA-07 | Rendering safety, 4.2.3: the document cleaned between pages, decoded images bounded and shrunk in the worker, and the file cap called an input bound. Phone check in 11.4. |
| PDF-ASTRA-08 | Download lifecycle, 6: one build at a time, owned by showing and press, one prepared file kept under a bounded rule, Share cleared with it. |
| PDF-ASTRA-09 | Viewer controls model, 5.1 and 5.4: failure and loading controls in a screen-pixel overlay, outside image semantics, stopping `pointerdown`, with focus handed on. |
| PDF-ASTRA-10 | Viewer identity model, 5.1: an explicit `showing` key resets on a new showing and keeps state on a resync. |
| PDF-ASTRA-11 | Rendering safety tests, 11.1 and 11.3: stored pixels checked per page, the download re-uploaded and checked in order and orientation, decoder and font fixtures checked by pixels. |
| PDF-ASTRA-12 | As SOL-06, 8.1. |
| PDF-ASTRA-13 | As SOL-08, section 14. |
| PDF-ASTRA-14 | Upload job, 4.1.4: no new work while hidden, in-flight work settles, and a failed upload is retried once on return. |
| PDF-ASTRA-15 | 5.4 loads by distance, not page count. Timings are examples (4.1.4, 10.3). 4.2.2 and 10.3 say a poster's detail is lost. 5.5 decays the fling by elapsed time. 7 says "usually instant". |
| PDF-P-1 | Viewer controls model, 5.1 and 5.3: Previous page and Next page buttons, `pageStep`, announced and tested. |
| PDF-P-2 | Viewer controls model, 5.1: the page layer holds only fills and images, and everything else draws in stage pixels. |
| PDF-P-3 | Decision 6, 5.2: zoom down to the page fit, Reset to the width fit. |
| PDF-P-4 | Upload job, 4.1.1: its block outside the form, toasts for every pause and stop, and the DM panel's badge. |
| PDF-P-5 | Upload job, 4.1.1: the job and the form's draft in the room scope, the form's Cancel only closes it, and the form keeps working during a job. |
| PDF-P-6 | Upload job, 4.1.2: the ledger and its exact recovery, never Clean up. 3.5 keeps a failed delete's ids with Try again. |
| PDF-P-7 | Upload job, 4.1.2: a running job's pages are tagged and left out of loose lists and Clean up on its device. |
| PDF-P-8 | Upload job, 4.1.3 and 4.1.6: the page limit checked at the range, Try again on a save refusal and at the quota, size steps for a large page, and Leave this page out. |
| PDF-P-9 | Download lifecycle, 6: progress and Cancel in the lead line, cancelled by closing, and a shorter busy label. Rows in 10.5. |
| PDF-P-10 | As SOL-05, 4.1.3. |
| PDF-P-11 | 5.3 and 5.6: "All 2 pages", the buttons disabled and the keys doing nothing when every page shows whole. Row in 10.3. |
| PDF-P-12 | Viewer identity model, 5.1: the page written on every change and read on every start of a showing. |
| PDF-P-13 | 7: the bar overlays the page, wraps, focuses Next page or Close, keeps the page keys, and Escape hides it first. |
| PDF-P-14 | Upload job, 4.1.7: a named focus target for each control that leaves. 5.9 for the Library's View. |
| PDF-P-15 | Upload job, 4.1.5: "Saved as Strange letter, 12 pages". |
| PDF-P-16 | Upload job, 4.1.1, 4.1.4 and 4.1.6: "Keep this page open", the retry on return, and a question before leaving the room. |
| PDF-P-17 | 5.6: Space and Shift+Space page while focus is on the dialog. |
| PDF-P-18 | 5.5: a touch during a fling only stops it. |
| PDF-P-19 | 5.2: the column's end padded by the controls row. |
| PDF-P-20 | 5.4: no new mounts during a fast fling, the thumb described as the whole page, and decision 8. |
| PDF-P-21 | 3.7: the show's refusal says showing counts the pages again. |
| PDF-P-22 | Section 10: optional content (10.4), the Library while its listing loads or fails (8.1), the display on a phone and at 130% (10.2), Delete racing Show (10.6), and the other named rows (10.3, 10.5, 10.6). |
| PDF-P-23 | 11.3: the `size.e2e.ts` sweep, the block at 246 px, the panel closed mid-upload, the kept page, the bar's first focus and the page buttons. |
| PDF-P-24 | 12: the page keys and buttons in FEATURES.md. |
| PDF-P-25 | 3.3: `handoutDoc.create` reads nothing, as `savedEncounter.create` does, and the citation says so. |

### 15.2 Round 2

Three P2s, each fixed as a class everywhere it occurred, and ten P3s. No decision in section 14 changed.

| Finding | Answered by |
| --- | --- |
| PDF-ASTRA-02 (round 2) and SOL-04 | 4.1.5's checking rule: the store marks each `unknown` as `snapshot` or `expired`, and an `expired` answer waits for the current connection's snapshot before the stable id is looked for. No retry or compensating delete runs before it. Applied to the save, Cancel's compensating delete and the Library's Delete (3.5, 4.1.6, 10.5), with tests in 11.1. |
| PDF-ASTRA-16 | 5.3: the page buttons step by the view's position, so every press moves the view. The indicator holds the aligned page until the view moves another way. The keys of 5.6 move by position too. Mixed-height tests in 11.1 and 11.3. |
| PDF-ASTRA-17 and SOL-09 | 4.1.6: Cancel stops retries at once, gives a sending upload `CANCEL_GRACE_MS` (about 10 s), then aborts it. The page is recorded as uncertain and named in the summary and the recovery (4.1.2). Rows in 10.5, tests in 11.1 and 11.3. |
| SOL-10 and PDF-ASTRA-19 | 4.1.5 and 4.1.6: "No pages were uploaded" with Try again and Dismiss, and never an empty create. Row in 10.5, test in 11.1. |
| PDF-ASTRA-18 | 4.2.1: the decoder check proves the module loads and initializes, then discards its instance. pdf.js builds its own, whose failure the warning rule catches. |
| PDF-P-26 | 4.1.4: one upload queue per device, with the job's pages behind any other upload, and a pause after each page while other members are online. Row in 10.5, test in 11.1. |
| PDF-P-27 | 5.2: Reset zoom shows only off the width fit. 5.5: a double tap below the width fit goes to it. 10.2's 320 px row follows. |
| PDF-P-28 | 4.1.1: `Badge` speaks "1 upload waiting", the Panels button counts the waiting job on a phone, and a toast is skipped while the block is on screen. |
| PDF-P-29 | 4.1.1: the block is a group named "PDF upload, Strange letter.pdf". |
| PDF-P-30 | 4.1.6, 4.1.2 and 4.1.7: the block keeps its summary with Done after a cancel or a recovery, and Done or the block leaving hands focus to Show a handout. |
| PDF-P-31 | 4.1.6: Leave room asks. Back at the room's root leaves without asking, and the ledger's recovery covers it. |
| PDF-P-32 | 11.3 step 9: the kept page, closed on page 2 and opened again from Handouts from the DM. |
| PDF-P-33 | 4.2.1: the worker wraps `console.warn`, where pdf.js's `warn()` writes, before it imports pdf.js's worker module, and forwards lines matching `IMAGE_FAILURES`. Test in 11.1. |
