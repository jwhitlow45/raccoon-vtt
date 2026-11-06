# raccoon-vtt: animated maps that turn or stretch

Status: built (2026-11-05). Draft 5, after design review rounds 1 to 3 (dispositions at the end). Decisions D-261102-850 to 859 and 890 to 899. Builds on docs/design/design-v1-animated-maps.md (the AM note), and amends its D-261102-441, D-261102-514 and section 7. The "As built" section at the end says where the build went its own way.

The owner, uploading an MP4 as a map: "i got the error "That video's file turns or stretches its picture, as phone videos often do. Export it again without rotation." when uploading an mp4 as a map background. is there not a way we can just auto fix this in the app?"

## 1. Summary

- **Fixed at upload, losslessly** (D-261102-850). The check accepts a video track whose `tkhd` matrix is one of the eight square turns (0, 90, 180 or 270 degrees, each with or without a left-right mirror), and non-square pixels from `pasp`, the `tkhd` width or WebM's DisplayWidth and DisplayHeight, between 1:2 and 2:1. It rewrites those header fields in place so the stored file is plain (square pixels, unturned, at its coded size). It returns the turn, the mirror and the stretched width as facts. Nothing is re-encoded.
- **The app draws the turn.** `map.video` and each phase's video carry the facts. Top-down's map image (so the table display and View as a player too), the Library viewer and the still maker share one placement. Isometric and the setup tools show the still, as today.
- **The still** comes from the DM's local frame only when that frame exists and the facts are plain. Otherwise it is read from the stored plain copy after the upload (D-261102-853, 898).
- **iPhone MOV** (4.5, D-261102-890 to 895). A QuickTime MOV holding what MP4 takes goes through the MP4 check and is stored as an MP4. So a Most Compatible iPhone video uploads, up to the 64 MB cap. iPhones' timed metadata tracks are dropped and their samples zeroed under a disjointness guard. HEVC, the iPhone default, stays refused, with words that say how to get a file that works.
- **Still refused**, with new words: a real `clap` crop, crops, any other matrix, a turned `mvhd`, odd translations, DisplayUnit other than 0, a WebM Projection with a pose, pixel shapes past 2:1.
- **Data:** the next free op and snapshot versions as identity steps. A stored video without the fields reads as plain. Backups carry the facts in the manifest, and an imported non-plain video gets its own row key (D-261102-896).

## 2. What phone files carry

From writer source and docs only, never a downloaded video:

- **Android cameras** write MP4 through MediaMuxer, whose `setOrientationHint` takes only 0, 90, 180 and 270. MPEG4Writer.cpp `writeCompositionMatrix` writes (a, b, c, d) as (0, 1, -1, 0) for 90, (-1, 0, 0, -1) for 180 and (0, -1, 1, 0) for 270, with zero translation, an identity `mvhd` and the pre-rotation `tkhd` size. So a portrait Android video is a 1920 x 1080 frame with the 90 matrix. That is the likeliest file behind the owner's refusal, not a confirmed one (17).
- **Android's screen recorder** writes an identity matrix. Already accepted.
- **iPhone cameras** write MOV with a track transform, not turned pixels (Apple QA1744). Public exiftool reports show `0 1 0 -1 0 0 1080 0 1` for portrait: the 90 row with tx = H (unconfirmed). The video is HEVC by default and H.264 under Most Compatible, with AAC sound as a QuickTime version 1 sound entry in a `wave` (XDRemux PR 48), and two or three `mebx` timed metadata tracks. iOS screen recordings are MP4. How Photos stores a rotate edit is not documented (QA1744 gives both ways), and both now pass.
- **FFmpeg** `-display_rotation` is counter-clockwise with zero translation, `-display_hflip` negates (a, c, tx), and a stream copy keeps the source matrix verbatim. In MP4 mode `tkhd`'s width is the coded width times the pixel aspect, rounded in 16.16, beside a `pasp`. In MOV mode `tkhd` keeps the coded width.
- **Non-square pixels** come from camcorder and broadcast exports (1440 x 1080 at 4:3, 720 x 480 at 10:11), not phones. Mirrors come only from editors.

## 3. Why the server makes the file plain

By the engines' own source:

- **Gecko** recognizes only the three pure turns (mp4parse_capi) and drops a mirror. It ignores `mvhd` and `pasp`, sizes from `tkhd`, then overwrites the size from the H.264 SPS (MediaChangeMonitor). Its `drawImage` turns only since Firefox 100.
- **Chromium** (FFmpeg's mov.c) multiplies `tkhd` by `mvhd` and recognizes turns and mirrors. It ignores translation and takes the pixel aspect from `pasp`, then the `tkhd` ratio, then the SPS. Its `drawImage` turns and mirrors.
- **WebKit** turns frames through AVFoundation's preferredTransform, flips included. Bug 205611 (a 180-degree video's `drawImage` failing after the first frame) is open.
- **The specs** are silent on rotation in `videoWidth` and `drawImage`, and whatwg/html#13106 (October 2026) records the engines disagreeing on declared sizes. WebCodecs defines rotation as clockwise with the flip after it, which is this note's convention.

Keeping the matrix for each browser to apply would mirror a file in Chrome and not in Firefox, risk a blank 180 in Safari, and size a `pasp` file two ways. Rewritten plain, the file reads the same everywhere, and the turn is the app's own canvas transform. This confirms the coordinator's direction, except the phone cap (6.3).

## 4. The accepted set and the refusals

### 4.1 MP4 (mp4.ts)

- **The matrix.** The video track's `tkhd` matrix is a, b, u, c, d, v, tx, ty, w. u and v must be 0 and w 0x40000000. (a, b, c, d), in units of 0x10000, must be a row below. W and H are `tkhd`'s own width and height in 16.16. (tx, ty) must be (0, 0) or the row's pair exactly. Anything else is `video_geometry`, checked in parseMoov after the codec, as today.

| a b c d | turn | mirror | (tx, ty) other than (0, 0) |
| --- | --- | --- | --- |
| 1 0 0 1 | none | no | none |
| 0 1 -1 0 | 90 | no | (H, 0) |
| -1 0 0 -1 | 180 | no | (W, H) |
| 0 -1 1 0 | 270 | no | (0, W) |
| -1 0 0 1 | none | yes | (W, 0) |
| 0 1 1 0 | 90 | yes | none |
| 1 0 0 -1 | 180 | yes | (0, H) |
| 0 -1 -1 0 | 270 | yes | (H, W) |

  A display point is (a·x + c·y + tx, b·x + d·y + ty) (ISO 14496-12 8.3.2). The turn is clockwise, and the mirror flips left to right after it. Mirrored when ad − bc is −1, and the turn read from (mirrored ? −a : a, b). The table lives in shared/videoGeometry.ts, which the parser and the client's tests import.
- **`mvhd`** stays the identity, as today.
- **The size.** `tkhd`'s height must equal the coded height exactly. `tkhd`'s size is before the matrix (ISO 14496-12 8.3.2), so a turned size there is `video_geometry`.
  - A `pasp` h:v with h ≠ v: each 1 to 65535. `tkhd`'s width is the coded width or within 1 px of coded width × h / v (FFmpeg's MOV and MP4 modes). The aspect is h / v.
  - A square `pasp` (N:N, 0:0 included, as today): `tkhd`'s width must equal the coded width. Chromium would show such a file square and Gecko stretched.
  - No `pasp`: the aspect is `tkhd`'s width over the coded width.
  - With `tkhd`'s size-as-aspect-ratio flag (0x8) set, any stretch is `video_geometry`.
  - The aspect must lie in [1/2, 2], else `video_geometry`. The tests and the stretched width (the coded width times the aspect, rounded half up) are computed in integers. A result equal to the coded width is square.
- **`clap`** (D-261102-895). A `clap` exactly the coded size (width and height N/D equal to the coded size, both offsets 0) is a no-op, and is renamed `free`. AVAssetWriter writes `clap` from the format's extensions (Apple forum thread 87966). Any real crop stays `video_geometry`, checked in parseMoov.

### 4.2 WebM (webm.ts)

- DisplayUnit must be 0, and every PixelCrop 0, as today.
- DisplayWidth and DisplayHeight, where present, are 1 to 65535, else `video_geometry`. Absent ones take the pixel size. With DW, DH, PW and PH for the display and pixel sizes:
  - In range when 2·DW·PH ≥ DH·PW and DW·PH ≤ 2·DH·PW (integers under 2^53).
  - Square when DW·PH = DH·PW, so a pure scale such as 5120 x 2880 for 2560 x 1440 is square.
  - The stretched width is DW·PH / DH, rounded half up.
- **A Projection** (D-261102-858). Chromium's WebM parser and FFmpeg read ProjectionPoseRoll and PoseYaw as a turn and mirror, while the check voids the element unread. So a Projection with a non-zero PoseYaw, PosePitch or PoseRoll is now `video_geometry`. An all-zero one is voided as today.

### 4.3 The caps

`video_size`'s caps (256 to 4096 a side, 8,294,400 pixels) apply to both the coded and the drawn size (6.2).

### 4.4 The words

`video_geometry` becomes: "That video's file crops or reshapes its picture in a way this app can't show. Export it again as a plain MP4 or WebM." Today's words name the cases now accepted.

### 4.5 QuickTime MOV (D-261102-890 to 895)

MOV is the parent of the ISO format, so the MP4 parser reads it with 4.1's rules and AM 10's, and the same rewrite.

- **The sniff.** file-type's `mov` (major brand `qt  `) joins `mp4`, and `qt  ` joins the kept brands. A file without `ftyp` stays `video_type`. The output is stored, named and served as an MP4 (`container: "mp4"`, `.mp4`, `video/mp4`). Chromium's demuxer is one for MOV and MP4, AVFoundation reads both, and Media Capabilities takes no QuickTime type.
- **Only under `qt  `** (D-261102-894). FFmpeg and CoreMedia read QuickTime's sound fields by the brand, so an ISO-branded file with these boxes would read differently to the check and to a browser. These rules apply only when the major brand is `qt  `, and an ISO-branded file keeps today's rules exactly. So no output the check accepted before changes, and VIDEO_PIPELINE stays 1.
  - Kept, checked exactly: an `alis` data reference with the self-reference flag and no payload (QuickTime's "this file"). A `colr` of type `nclc`, checked as nclx is (PQ and HLG `video_hdr`). A version 1 sound entry whose samples per packet is 1024 or 2048 and whose other three counts are each under 2^16, with AAC's `esds` in the entry or in a `wave` of exactly `frma` (`mp4a`), `mp4a`, `esds` and a terminator.
  - A `tapt` whose clean, production and encoded sizes all equal `tkhd`'s size, either way round (unconfirmed which way iPhones write it), is renamed `free`. One that differs is `video_geometry`, checked in parseMoov, so an HEVC file still meets `video_hevc` first.
  - A version 2 sound entry is `video_sound`.
- **Zeroed in both brands** (renamed `free`, as every unlisted box): the movie's `meta` with its `keys` and `ilst` (make, model, software, creation date, location, the Live Photo identifier), `udta`, the data handler `hdlr` in `minf`, `chan`, `clip`, `matt`, `load`, `imap` and `tref`.
- **Timed metadata tracks, in both brands** (D-261102-893). Handler `meta` with one `mebx` entry, at most 8 tracks. Public reports list per-frame detected-face boxes and IDs, video orientation, Live Photo data and the still-image time, and Apple's timed metadata spec allows GPS. Each such `trak` is renamed `free`, and its samples are zeroed:
  - Its `stsc`, `stsz` or `stz2` and `stco` or `co64` are read with the existing bounded functions, at most 60,000 samples in all dropped tracks.
  - Its ranges are coalesced per chunk. Each must lie inside one `mdat` payload and be disjoint from every kept track's sample ranges, by a sorted sweep. Otherwise the file is `bad_video`.
  - The ranges are zeroed by a new `scrub` edit kind (5).
  - Its presentation (its edits' segments, an initial empty edit allowed, at most 4 at normal rate, else its media's length) must end by the video's end within the tolerance, else `video_layout`. iPhone's still-image-time track starts with an empty edit (Tika PR 2936).
  - `mvhd`'s duration is compared with the kept tracks, as today.
- **HEVC** (`hvc1`, `hev1`, `dvh1`, `dvhe`) gets a new code, `video_hevc` (422). ProRes and other codecs stay `video_codec`, and a track of any other kind stays `video_tracks`.
- **Words** (4.5 and the client's copies):
  - `video_type`, and `unsupported_type` (which words.test requires to match): "That video isn't WebM, MP4 or MOV."
  - `video_hevc`: "That video is HEVC (High Efficiency), which most browsers can't play. Export it as H.264, for example with QuickTime Player's Export As and Greater Compatibility on a Mac. For new iPhone videos, set Settings > Camera > Formats to Most Compatible."
  - `VIDEO_PICK_HELP`: "A WebM, MP4 or MOV video makes an animated map, up to 64 MB. H.264 plays on the most devices."
- **What an iPhone file meets.**
  - High Efficiency, the default: `video_hevc`. The sample entry is read inside the video trak, before tracks are counted or `tapt` judged.
  - Most Compatible: accepted and drawn upright. H.264 runs about 130 MB a minute at 1080p30 and 350 MB at 4K30 (public figures), so 64 MB is about 30 s and 11 s. Past that it gets today's `too_large`.
  - Safari's Photo Library picker may hand over the original or a converted copy, depending on the iOS version (Apple forum thread 658708). The live review tries both pickers.
- **The client.** The pickers take `video/quicktime` and `.mov`. firstFrame.ts `videoContainer` maps `video/quicktime`, and `.mov` with no type, to `mp4`, so `fileRefusal` passes it. upload.ts sends it as `video/mp4`, so the route does not change.

## 5. The rewrite

- **MP4:** the video `tkhd`'s matrix becomes the identity and its size the coded size, through `putAt`. A non-square `pasp` becomes 1:1, as a square one does today. A no-op `clap` and an even `tapt` become `free`.
- **WebM:** a DisplayWidth or DisplayHeight unlike the pixel size makes both elements Void, zeroed. They may be too short to hold the pixel size in place.
- **The scrub** (D-261102-893). `Edits` gains `scrub(start, end)`, used only for dropped metadata samples. At write time its guard asserts that the span lies inside one `mdat` payload and outside every kept sample range, recorded by a new `keep(start, end)`. Any `zero` or `put` reaching into `mdat` stays an `EditIntoMediaError`, as today. Writes go out a window at a time, inside the 5 s budget (about 64 MB of windowed writes at most).
- No byte moves, and the length and every offset stay. No write touches a kept track's samples.
- **Idempotent.** An output checks again to the same bytes. A turned file's output equals, byte for byte, that of the same file built plain (identity, coded size, 1:1 `pasp`).

## 6. The model

### 6.1 Facts

```ts
// shared/model.ts, beside VideoFacts
export type VideoTurn = 90 | 180 | 270;
export type VideoFacts = {
  /** The coded size, which the stored file now plays at in every browser. */
  widthPx: number;
  heightPx: number;
  /* ...as today... */
  /** How the file showed its picture (D-261102-850): turned clockwise, then mirrored left to right. The stored file no longer says so. */
  turn?: VideoTurn;
  mirror?: true;
  /** The picture's width once its pixel shape applies, before the turn, when its pixels are not square. */
  displayWidthPx?: number;
};
```

- The row's `width` and `height` stay the coded size, and the new fields ride in its `video` jsonb.
- store.ts `storedVideoSchema`, a strict object that `videoFactsOf` and `toView` read every row through, gains the three fields. Without them the upload answer and the Library would lose `video`.
- The protocol's `mapVideo` takes `turn` (one of the three), `mirror` (true only) and `displayWidthPx` (a whole number).
- The cross-field rule lives in a function, `videoGeometryProblem(facts)`: `displayWidthPx` between half and twice `widthPx` and not equal to it, and the drawn size inside 4.3. A zod `.refine` would break `mapVideo.omit` and `VIDEO_FACT_FIELDS`. `checkedVideoFacts`, stateSchema's map and phase checks and the import call it.

Rejected: the drawn size in `widthPx` (Media Capabilities and the phone cap would read a size no decoder handles), and a ratio pair.

### 6.2 The drawn size

`drawnSize(facts)` in shared/videoGeometry.ts is (displayWidthPx ?? widthPx, heightPx), swapped for 90 and 270. `stillFitsVideo` reads it, so `VIDEO_SHAPE`, the DM's still pick, the import's refill and `phasesFitTheirGrid` compare the still with the picture as shown. upload.ts's `shapeRefusalText` takes `drawnSize(video)`, so a portrait video's refusal says "(9:16)".

### 6.3 The phone cap reads the coded size

The coordinator proposed the drawn size. The coded size is right. The cap guards decoder memory and heat (D-261102-444), and the decoder works on coded frames. The cap takes 1920 x 1080 either way round, so a turn never changes its answer. A stretch changes only the drawn width, and drawing into the still's rectangle costs the same. Reading the drawn size would pass a 3840 x 1080 file at 1:2 on Phone size. So `phoneSizeAllows` and `decodingInfo` keep reading `widthPx` and `heightPx`.

**The runtime check** (D-261102-897, draft 4). playback.ts `sizeProblem` judges the decoded size, and a reported size equal to the declared stretched size is never taken on trust alone. A WebM coded 1280 x 720 that declares 2560 x 720 and really decodes at 2560 x 720 would otherwise pass.
- **With frame callbacks running**, board.ts reads each frame's `width` and `height` from `requestVideoFrameCallback`'s metadata. The spec defines them as media pixels: the visible decoded pixels, without pixel aspect adjustment. The board's size is those, so a real size change mid-stream (VP9) is judged on its first frame. Once a frame callback has run, a later `resize` does not replace that size: `#sized` waits for the next frame's `width` and `height`.
- **Before the first frame**, the element's reported size is judged as today, with one hold: when callbacks are expected, a size equal to the coded size, or within 1 px in width of (displayWidthPx, heightPx) (Gecko's own rounding, as 4.1 allows for `tkhd`), waits for the first frame instead of failing. Playback keeps going for that one frame.
- **Without callbacks** (the method missing, or `CALLBACK_WAIT_MS` passing with none), the reported size is judged as reported. A stretched video there may show the still on Phone size, a documented exception.
- An H.264 file stretched only by its SPS has plain facts and no `displayWidthPx`, so the hold does not cover it. board.ts judges playback before it hands the video over and starts callbacks only after, so a stretched report past the cap shows the still on Phone size even with callbacks. It stays the documented exception.

## 7. Drawing

- **One placement.** client/features/animmap/turn.ts `videoPlacement(rect, facts)` gives the Konva attributes that draw the plain frame into the still's world rectangle:
  - x and y at the rectangle's center.
  - `width` and `height` the box before the turn (swapped for 90 and 270), with offsets at its center.
  - `rotation` the turn.
  - The mirror as `scaleX` −1 at none and 180, or `scaleY` −1 at 90 and 270, since Konva scales before it rotates.

  `placementTransform` gives the same as a canvas matrix and a CSS `transform`. A plain video gives today's attributes exactly.
- **Top-down** (MapLayer.tsx `MapImage`): the `KImage` holding the element spreads the placement. The table display and View as a player draw through it. The still, phase-swap keep, grid and cover are unchanged.
- **The Library viewer** (HandoutViewer.tsx `PageVideo`): the page box is the drawn size (LibraryGrid.tsx `videoView`). The `<video>` takes the box before the turn, centered, with `objectFit: "fill"` and the placement's CSS transform, so its box on screen is the page box. The header line reads the drawn size.
- **Isometric, the setup tools, thumbnails, Export as image and the grid search** read the still. No change.
- **Words:** the Map image row's help ("A 1080 × 1920 px video, 0:42, looping.") and the Library line read the drawn size.
- **Cost:** a canvas transform per draw. scripts/bench-animmap.ts adds a run of its 1080p fixture with `turn: 90` in the facts, against AM 6.1's targets.

## 8. The still (D-261102-853, 898)

1. **The local probe** runs on the picked file as today, with two changes. A size past the caps no longer refuses, since a WebM may declare a display size the server normalizes (5120 x 2880 for 2560 x 1440): it skips the frame and makes no canvas. A read failure or timeout no longer stops the form, as a MOV in Firefox may fail where its stored MP4 plays. A length past the caps still refuses at once, and a Low Power refusal still shows Try again.
2. **The video uploads.**
3. If the probe made a frame and the facts are plain, that frame is the still, as today.
4. **Otherwise the probe reads the stored copy** from its asset URL. The DM reads any asset, and the CSP has `media-src 'self'`. The busy button reads "Reading the first frame…" again. It uses today's steps and 20 s limit, and draws the frame with `placementTransform` into a canvas of the drawn size. The frame is plain in every engine, and filling the canvas makes the browser's own width irrelevant.
5. **If that fails**, the form says today's "This device can't read that video's first frame. Pick a still image for it, such as the one that came with the map." The video stays held (`HeldVideo`) so it never goes up twice. A Low Power refusal shows Try again. Cancel, another file or leaving the form deletes a video this upload made.

A picked still is checked against the drawn size. The probe keeps its lease exemption (AM 5.2): at most 20 s, its `src` cleared before the still uploads.

Rejected: the local frame for a non-plain video (Gecko leaves it unmirrored, Gecko before 100 left it unturned, WebKit may fail at 180), shape detection (blind to 180 and mirrors), a client-side writer for a plain local copy, a bitmap held through the upload, and refusing by the browser's reported size.

## 9. Data

- **Versions** (D-261102-857): the next free op and snapshot versions (47 and 37 today), identity steps as D-261102-453. An older build's strict schema would fail on the fields, so it refuses the room cleanly. Nothing stored changes, and a video without the fields is plain, as every stored video is.
- **Players** receive `map.video` of the phase showing, now with how to draw it. Phases stay DM only.
- **Backups** (D-261102-856, 896). The stored file is plain, so the turn lives only in the row.
  - exportRoom.ts writes each video's `geometry: { turn?, mirror?, displayWidthPx? }` from its row into its manifest entry.
  - On import, in two stages. The manifest's sizes are not trusted (importRoom.ts strips them), so only the parsed coded size can check the aspect and the drawn caps.
    1. Before the entry is read, a present geometry's shape is checked: `turn` one of the three, `mirror` true only, `displayWidthPx` a whole number in 1 to 65535. If that fails, the entry is skipped unread, whatever its bytes hold.
    2. After the check parses the bytes, bytes that check non-plain keep their own facts (the bytes win). Plain bytes take the manifest's geometry, and the whole result is checked by `videoGeometryProblem` and the caps against the parsed coded size, before the key, the reuse or the insert. If that fails, the entry is skipped.
  - A skipped entry's references refill to nothing, and each still stays a plain map. Leaving it to the shape rule would let a mirror, a 180 or a square video through.
  - **Identity.** An imported video with non-plain geometry is keyed by SHA-256 over "raccoon-vtt video geometry 1", the entry's digest and its geometry in a fixed order, not by the digest alone. The file is placed under that key. Two videos whose plain bytes are equal but whose turns differ (an original and a header-only rotate edit) are then two rows, through `#ingestVideo`'s reuse and the `(room_id, sha256, kind)` index alike. A plain video keeps the digest key, and live uploads keep the upload's hash, as today.
  - The manifest stays version 2, and an older build ignores the field. An old backup has no turned video.
- **The nightly backup** dumps the rows and copies the files unchanged.
- **A deploy:** a DM tab loaded before it uploads a turned video the old way. A reload fixes it.

## 10. Security

- **Exact values only.** 8 matrix rows with 2 translations each. `tkhd`'s width in 4.1's forms, its height one. Integer bounds and integer arithmetic for every aspect. A `clap` and a `tapt` only as no-ops. QuickTime's boxes only under `qt  `. Fixed DisplayUnit, crops and Projection pose. Anything else is refused, never clamped.
- **Writes.** The rewrite uses the existing kinds in `moov` and Tracks. The scrub writes only dropped metadata samples, under its own guard, after the disjointness sweep, and never a kept sample. This amends D-261102-514 ("never writes at offsets the file's tables give") and D-261102-441's rejection of zeroing extra tracks' samples, for timed metadata tracks only. AM section 7 changes to match.
- **Bounded facts** on upload, in every op and on import, where the manifest is untrusted and checked the same way.
- **No new route or CSP.** The reread uses the DM's asset access. A player gets only how to draw the video already sent.
- docs/assurance-case.md: header turns and pixel shapes rewritten in place, metadata tracks dropped and their samples zeroed, and the CWE-434 row's "only as WebM or MP4" gains MOV.

## 11. The alternative: re-encode on the DM's device

Decode with WebCodecs, turn each frame on a canvas, encode H.264 and mux a new MP4. Rejected (D-261102-850):
- **Time.** A 10-minute 4K file is 18,000 frames at 30 fps. By rough, unverified published encode rates, that is about 12 minutes on a 2018 MacBook Pro (25 fps at 4K), about 6 on an M4 MacBook Pro or a Galaxy S25, and about 1.7 hours in Safari on an iPhone 16 Pro (12 fps at 1080p). Decoding and the canvas copy come on top, with the page kept open and awake.
- **Quality and size.** A second lossy encode at under 1 Mbit/s (64 MiB over 10 minutes).
- **Dependencies and support.** A demuxer and a muxer in the client (mediabunny, or mp4box.js with mp4-muxer). No VideoEncoder in Firefox for Android.

It is not kept as a fallback. Every phone case is now accepted, and the refused cases are editor output. The phone copy in AM section 15 stays Later.

## 12. UI checklist

- **Loading:** the reread shows "Reading the first frame…" on the busy button through the shared indicator. Cancel stops it. It ends in a still, Pick a still image or Try again.
- **Keys, focus, screen readers:** none new. The row's help reads the drawn size.
- **Large interface sizes:** no layout change. The viewer's turned element keeps the page box, so no new alignment root is needed. turn.test checks the box.
- **Exact words:** 4.4, 4.5's, the drawn sizes in 7, and AM 4.1's words for the reread.

## 13. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Android portrait: the 90 row, zero translation | Accepted, turn 90, stored identity, drawn 360 × 640 upright | mp4 test, amr-1 |
| Apple 90 with (H, 0), 180 with (W, H), each mirror row | The table's turn and mirror | mp4 test, property test |
| Scale 2, a skew, 45 degrees, u or w off, (W, 0) on the 90 row, a turned `mvhd`, `tkhd` holding the turned size | `video_geometry`, 4.4's words | mp4 test, property test |
| `pasp` 4:3 with `tkhd` coded or FFmpeg's rounded 16.16, a `tkhd`-only stretch | Stretched width 853, `pasp` 1:1 and `tkhd` coded in the bytes | mp4 test, amr-4 |
| `pasp` 3:1, 0:3, 70000:1, `tkhd` 2 px off the `pasp`, a square `pasp` with a stretched `tkhd`, flag 0x8 with any stretch | `video_geometry` | mp4 test |
| A no-op `clap`, a `clap` cropping 8 px | Accepted with it renamed `free`, `video_geometry` | mp4 test |
| WebM DisplayWidth 853, a DisplayHeight stretch, 5120 x 2880 for 2560 x 1440, DisplayWidth 70000 | Accepted (Void), accepted, square, `video_geometry` | webm test |
| WebM DisplayUnit 3, a crop, a Projection with PoseRoll 90, an all-zero Projection | Refused three times, then voided and accepted | webm test |
| Turned past the area cap, stretched past 4096 | `video_size` | mp4 test |
| Any accepted file checked twice, and a turned file against its plain twin | The same bytes | property test |
| Each fixture, Still then Moving | The same colors at three spots. amr-1 and amr-3 also match the upright colors expected there | amr-1 to amr-5 |
| The local probe reads 5120 x 2880, or cannot read a MOV | No canvas, the video uploads, the still comes from the stored copy | upload test, upload random test |
| Reread fails, a Low Power refusal, cancel mid-reread | Pick a still image with the video held, Try again, the video deleted | upload tests, upload random test |
| Picked still for a portrait video | Checked against, and refused with, 9:16 | upload test |
| Phone size: 1920 × 1080 turned 90, and Gecko reporting 2560 × 1080 (or 2559) for a 4:3 file whose frames are 1920 × 1080 | Both play | playback test, board test |
| A WebM declaring 2560 × 720 for coded 1280 × 720 whose frames really are 2560 × 720, on Phone size | The still after the first frame | playback test, board test |
| The 4:3 file reported at 2560 × 1080 with no frame callbacks, or with none in `CALLBACK_WAIT_MS` | Judged as reported: the still on Phone size | board test, controller random test |
| Library viewer of the 90 fixture | Turned, box equal to the page box | turn test, amr-1 |
| Export and import a turned and a stretched video | Facts kept, maps keep their videos | animmap.itest |
| Two videos with equal plain bytes, turned 90 and 270, in both manifest orders | Two rows, each with its turn | animmap.itest |
| Invalid manifest geometry on a mirrored, a 180 and a square video, and bytes with their own turn | Each skipped, its still a plain map, and the bytes win | animmap.itest |
| A malformed geometry (turn 45, `displayWidthPx` 0), and a well-formed one whose manifest sizes would fit but whose parsed coded size breaks the aspect | Skipped unread, and skipped after the parse | animmap.itest |
| Plain facts with an SPS-stretched report of 2560 × 1080 for coded 1920 × 1080 on Phone size, and a frame of 1920 × 1080 followed by a `resize` reporting 2560 × 1080 | The still, and it keeps playing | board test |
| A stored video without the fields, an older build on the new snapshot | Plain, refused cleanly | migrate test, stateSchema test |
| The clap fixture uploaded | 4.4's words | amr-6 |
| iPhone-shaped MOV: `qt  `, `alis`, `nclc`, a version 1 sound entry in `wave`, a `tapt` at the turned size, two `mebx` tracks holding face and location strings (one starting with an empty edit), `meta` with a location, the 90 row with (H, 0) | Accepted as mp4 and upright. No location, face or device string in the bytes, the dropped samples zero, every kept sample unchanged | mp4 test, animmap.itest, amr-7 |
| A metadata range overlapping a video sample, spanning two `mdat`s, or past the 60,000 samples, and a metadata track ending 2 s after the video | `bad_video` three times, then `video_layout` | mp4 test, property test |
| MOV with `hvc1`, `dvh1` (and an uneven `tapt`), ProRes, a version 2 sound entry, an uneven `tapt`, no `ftyp`, a `meta` track with another entry, 9 metadata tracks | `video_hevc` twice, `video_codec`, `video_sound`, `video_geometry`, `video_type`, `video_tracks`, `video_tracks` | mp4 test, animmap.itest |
| An ISO-branded MP4 with `nclc`, or a version 1 sound entry | `nclc` renamed `free` as today, and refused as today | mp4 test |

## 14. Tests

- **Unit** (`node:test`):
  - shared/videoGeometry.test.ts: the table both ways, `drawnSize`, the integer aspect rules, `videoGeometryProblem`, and `stillFitsVideo` and `VIDEO_SHAPE` with turned facts.
  - mp4.test.ts and webm.test.ts: a case per rule of 4.1, 4.2 and 4.5, on files from videoTestutil.ts. It gains raw 16.16 sizes, any matrix and translation, `clap`, `tapt`, Projection, the QuickTime boxes, and `mebx` tracks with given samples and edits.
  - store.test (the schema keeps the fields), protocol bounds, playback.test.ts (the coded-size cap and the runtime rule), and firstFrame.test.ts (`videoContainer` takes MOV, flipping today's case at line 287).
- **Property** (video.random.test.ts, fast-check):
  - Any nine matrix values, `tkhd` size, `pasp` and `clap` are accepted exactly when 4.1 says. Then the bytes hold the plain values and the facts the table's, and the output equals the plain twin's.
  - The same for WebM display values and poses.
  - Random `mebx` sample layouts: accepted only when every range is inside one `mdat` and disjoint from kept samples. Then every dropped sample is zero and every kept byte unchanged.
  - Any output checks again to the same bytes.
- **Drawing** (turn.test.ts): for the 8 rows and random rectangles, the placement maps the frame's corners onto the rectangle's in the order the table's matrix does, applied directly. The Konva attributes, canvas matrix and CSS transform agree.
- **Upload flow:**
  - firstFrame.test.ts covers a URL source drawn at the drawn size, and the size and failure deferrals.
  - upload.test.ts covers when the reread runs, its failure, the held video, and the 9:16 words.
  - upload.random.test.ts runs random cancels, failures, timeouts and late answers. Its invariants: the still never goes up before the video's answer, or twice for one pick. Every exit but success and a hold deletes a video this upload made. A hold is deleted on cancel or leave. Every probe clears its `src`. Nothing runs after a cancel.
- **Fixtures** (scripts/video-fixtures.ts, no downloaded video). The test writer rebuilds them from the map-loop recordings, changing headers only. The MP4s and the MOV come from map-loop.mp4's frames, and the WebM from map-loop.webm's:
  - map-turn-90.mp4, map-turn-180.mp4 (Apple translation), map-turn-270-mirror.mp4 (FFmpeg hflip)
  - map-wide.mp4 (`pasp` 4:3), map-wide.webm (DisplayWidth 853), map-clap.mp4 (an 8 px crop)
  - map-iphone.mov (13's iPhone row, made-up strings)

  The pattern's bars (top three quarters, colors in order) and dark strip tell all eight orientations apart.
- **e2e** (animmap.e2e.ts, `amr-1` to `amr-7`, with `reach`): the DM adds each fixture as a new scene's map, the MOV through the picker. The map layer is sampled at the first bar, the last bar and the strip, under Still and then Moving. amr-1 and amr-3 also check the colors expected upright at those spots, so a placement bug the board and still share cannot pass. amr-1 opens the Library viewer, and amr-6 checks the words.
- **Integration** (animmap.itest.ts): a turned upload's bytes hold the identity. The MOV is served as `video/mp4` with no planted string. HEVC answers `video_hevc`. The backup cases of 13.
- **Mutants**, each failing a named test:
  - the matrix rewrite, the translation check, the mirror's sign, 90 swapped with 270, `drawnSize`'s swap, `scaleY` at 90
  - the integer aspect bounds, the square-`pasp` rule, the drawn cap, the WebM Void, the Projection refusal
  - the reread rule and the size deferral, the runtime size rule
  - the manifest skip, the geometry key, the bytes-win rule, `storedVideoSchema`'s fields
  - the brand gate, `alis`, `nclc`, the `wave` shape, the v1 counts' bounds, the `clap` and `tapt` no-op rules, the deferred `tapt` refusal
  - the metadata drop, its cap, the disjointness sweep, the scrub guard, the metadata end rule, `video_hevc`

## 15. Lanes

**AR-0, contract (S), first:**
- shared/videoGeometry.ts (new) and its test, shared/model.ts, shared/limits.ts (`stillFitsVideo`, the bounds), shared/protocol.ts with its tests, shared/migrate.ts.
- shared/apiErrors.ts (`video_hevc`), shared/permissions.video.test.ts.
- client/features/animmap/words.ts with words.test.ts: 4.4, 4.5's words, `unsupported_type`, and the row's help at the drawn size.

**Then two lanes at once, disjoint:**
- **AR-A, server (L):**
  - server/assets/video/mp4.ts, webm.ts, check.ts (drawn caps, the `mov` sniff) and window.ts (`scrub` and `keep`).
  - videoTestutil.ts, mp4.test.ts, webm.test.ts and video.random.test.ts.
  - server/assets/store.ts (`storedVideoSchema`) and service.ts (the geometry key and `ingest`'s geometry).
  - server/rooms/exportRoom.ts, importRoom.ts and stateSchema.ts, with remap.video.test.ts and stateSchema.video.test.ts.
  - server/assets/animmap.itest.ts.
  - scripts/video-fixtures.ts and e2e/fixtures/ with its README, in the first commit.
- **AR-B, client (M):**
  - client/features/animmap/turn.ts (new) with turn.test.ts.
  - client/canvas/layers/MapLayer.tsx and client/features/handouts/HandoutViewer.tsx.
  - client/features/images/LibraryGrid.tsx with its test.
  - client/features/animmap/firstFrame.ts (`videoContainer`, the deferrals), upload.ts (`VIDEO_PICK_HELP`, the pickers, the reread, the shape words) and playback.ts, with their tests and upload.random.test.ts.
  - client/features/animmap/board.ts (the frame callback's `width` and `height` into the size, the first-frame hold), with its tests, controller.random.test.ts and videoSim.testutil.ts.
  - scripts/bench-animmap.ts.
  - e2e/animmap.e2e.ts `amr-1` to `amr-7`, after AR-A's fixture commit.

**The docs commit**, last, in AR-B:
- FEATURES.md: the Animated maps bullet at line 109 ("a WebM ... or MP4") gains MOV, turned, mirrored and stretched pictures, and "HEVC is refused".
- docs/dm-guide.md near line 696 ("A WebM or MP4 file works"): turned videos and the iPhone's Most Compatible setting, with the 30 s note, in guide prose.
- docs/design/design-v1-animated-maps.md: sections 1, 4.5, 7 (extra tracks and the SEI line), 9.1 and 10, and D-261102-441 and 514, pointing here.
- docs/assurance-case.md (10).
- This note as docs/design/design-v1-video-turns.md, indexed in docs/design/README.md.

## 16. Decisions

- **D-261102-850** Rewrite the header plain in place and draw the turn in the app. Rejected: the matrix left for browsers (section 3), a re-encode (section 11), refusing as today.
- **D-261102-851** 4.1's and 4.2's accepted set, mirrors included, exact translations, 4.4's words. Rejected: no mirrors, ignoring translation, decomposing any matrix, shapes past 2:1, today's words.
- **D-261102-852** `widthPx` and `heightPx` stay coded, beside `turn`, `mirror` and `displayWidthPx`, with the drawn size derived. Rejected: the drawn size in `widthPx`, a ratio pair.
- **D-261102-853** A non-plain video's still comes from the stored copy through the board's placement. Rejected: the local frame, shape detection, a client-side writer, a held bitmap.
- **D-261102-854** Caps on the coded and the drawn size, with the phone cap and Media Capabilities on the coded size. Rejected: the phone cap on the drawn size (the coordinator's proposal), caps on one size only.
- **D-261102-855** `tkhd` to the identity and the coded size, `pasp` to 1:1, WebM display elements Void, VIDEO_PIPELINE 1. Rejected: `pasp` renamed `free`, WebM values rewritten in place, the stretch kept.
- **D-261102-856** The manifest carries each video's geometry. Rejected: re-deriving from the bytes, writing the matrix back on export.
- **D-261102-857** The next free op and snapshot versions, identity steps. Rejected: no bump, a migration.
- **D-261102-858** A WebM Projection with a pose refused, an all-zero one voided. Rejected: reading the pose, voiding it unread.
- **D-261102-859** AR-0, then AR-A and AR-B at once, docs last. Rejected: one lane.
- **D-261102-890** A MOV with MP4's codecs goes through the MP4 check and is stored and served as an MP4. Rejected: refusing MOV (iPhone videos are MOV, and many players use iPhones), a third container (every file pattern and the backup script for no gain), rebranding `ftyp` (readers parse QuickTime's sound by the brand).
- **D-261102-891** QuickTime's boxes kept, zeroed or refused as 4.5 lists. Its first choice for metadata samples (left in `mdat`) is superseded by D-261102-893. Rejected: keeping `tapt`, refusing files with metadata tracks.
- **D-261102-892** HEVC stays refused, with its own code and words. Rejected: accepting HEVC (hardware-only in Chrome and Firefox), the generic `video_codec` words, converting on the device.
- **D-261102-893** (the coordinator's call) The dropped metadata tracks' samples are zeroed by a separate `scrub` edit kind, after a sweep proves every range lies inside one `mdat` and is disjoint from every kept sample. Their presentation must end by the video's end. This amends D-261102-441, D-261102-514 and AM section 7. Rejected: leaving them (detected faces, and GPS where Apple's spec allows it, would reach players), refusing iPhone files, the existing `zero` kind (one guard for both would weaken `mdat`'s protection), a dropped track unchecked for timing.
- **D-261102-894** QuickTime-only rules (`alis`, `nclc`, the version 1 sound entry and `wave`, `tapt`) apply only under `qt  `, and the metadata drop under both. Rejected: one set for both brands (a parser differential, and `nclc` would change accepted outputs), stepping VIDEO_PIPELINE.
- **D-261102-895** A no-op `clap` and a `tapt` equal to `tkhd`'s size either way round are renamed `free`. A real crop and an uneven `tapt` are refused, the latter in parseMoov. Rejected: refusing every `clap` (AVAssetWriter may write a no-op one into every iPhone file), one orientation for `tapt` (unconfirmed).
- **D-261102-896** An imported non-plain video is keyed by a domain-separated hash of its digest and geometry, and a present invalid geometry skips the video. Rejected: geometry passed to `ingest` alone (reuse and the unique index merge 90 with 270), skipping reuse (the index forbids a second row), relying on the shape rule (180, mirrors and squares pass).
- **D-261102-897** (draft 4) The runtime size check judges each frame's media pixels from the frame callback. Before the first frame it holds a reported coded or stretched size (width within 1 px). Without callbacks it judges the reported size. Rejected: the reported size as is (Gecko's SPS width fails Phone size), no runtime check (VP9 size changes), draft 3's equality rule (a real decode at the stretched size would pass).
- **D-261102-898** The local probe's size refusal and read failure defer to the stored copy after the upload. Rejected: refusing by the browser's size (refuses accepted WebM scales), asking for a still before the stored copy is tried.
- **D-261102-899** Integer bounds: `pasp` terms, DisplayWidth and DisplayHeight 1 to 65535, aspects in integers. Version 1 sound counts bounded (samples per packet 1024 or 2048, the others under 2^16). Rejected: floats (inexact at large values), unbounded counts (a 16-byte free channel), zeroing the counts (untested readers may use them).

## 17. Open risks and follow-ups

- The live review re-uploads the exact file the owner was refused. It may hold a refusal that stays, such as a `tkhd` height of 1088 against 1080.
- Firefox playing a MOV served as `video/mp4` is not checked in source. A device that cannot shows the still with "the video didn't load."
- A recent iPhone's spatial audio may add a second sound track (unconfirmed). It stays `video_tracks`. Dropping it like a metadata track is a follow-up.
- Follow-ups: the version 1 sound counts' exact values, and `tapt`'s orientation, once a real iPhone file is read. The H.264 SPS's own pixel aspect stays unread (6.3's exception).
- Chromium, Gecko and WebKit's frame metadata `width` and `height` are taken from the spec, not checked on each engine. The board test fakes them. The live review checks the 4:3 fixture on Phone size in Firefox.

## Design review round 1

**Changes in draft 3:**
- The dropped metadata samples are zeroed under a disjointness guard, by a new `scrub` edit kind, and D-441, D-514 and AM 7 are amended (D-893).
- QuickTime-only rules apply only under `qt  `, so accepted outputs keep their bytes (D-894).
- A no-op `clap` and an even `tapt` either way round are accepted, and the `tapt` refusal is deferred (D-895).
- An imported non-plain video gets its own key, and invalid geometry skips the video (D-896).
- The runtime size check counts a reported stretched size as coded (D-897).
- The local probe defers on size and on read failures (D-898).
- Integer bounds and arithmetic for aspects, and bounded version 1 sound counts (D-899).
- `storedVideoSchema`, `shapeRefusalText`, `videoContainer`, `unsupported_type` and `VIDEO_PICK_HELP` are named and assigned.
- A square `pasp` with a stretched `tkhd`, and flag 0x8 with any stretch, are refused.
- Metadata tracks' end rule. `dvh1` and `dvhe`. Corrected iPhone sizes. Absolute-color checks in amr-1 and amr-3. The WebM fixture's source. The cross-field function. The fuller docs list.

**Dispositions.** Every finding is adopted, and none is declined.
- AMR-O-01 and AMROT-ASTRA-01 in 4.5, 5 and 10 (D-893). AMR-O-02 in 6.1 and AR-A. AMR-O-03 in 6.2. AMR-O-04 and AMROT-ASTRA-02 in 9 (D-896). AMR-O-05 and AMROT-ASTRA-06 in 4.5 (D-894). AMR-O-06 in 4.1 and AMR-O-08 in 4.5 (D-895).
- AMR-O-07, 09, 12 and 13 in 4.5. AMR-O-10 in 15. AMR-O-11 in 4.1 and 13. AMR-O-14 in 4.1 and 4.2 (D-899). AMR-O-15 in 14. AMR-O-16 in 6.1. AMR-O-17 in 8 (D-898). The lesser note on the version 1 counts in D-899, exact values a follow-up.
- AMROT-ASTRA-03 in 9 (D-896). AMROT-ASTRA-04 in 6.3 (D-897). AMROT-ASTRA-05 in 8 (D-898).
- The question about the owner's refused file is a live review step (17).

## Design review round 2

**Changes in draft 4** (by the coordinator):
- The runtime size check judges the frame callback's media pixels, holds a coded or stretched report until the first frame, and judges the report without callbacks (D-897).
- The import checks a present manifest geometry before the bytes.
- server/rooms/stateSchema.ts joins AR-A, and board.ts with its tests joins AR-B.

**Dispositions.** Every finding is adopted.
- AMROT-ASTRA-07 in 6.3, 13, 15 and 17 (D-897). Media pixels per the frame callback spec, checked by the coordinator.
- AMR-O-R2-01 in 15. AMR-O-R2-02 in 9. AMR-O-R2-03 in 6.3 and 13 (the 1 px hold).


## Design review round 3

**Changes in draft 5** (by the coordinator):
- The import checks a present geometry's shape before reading the entry, and the whole facts against the parsed coded size after (9).
- An SPS-only stretch stays the exception with callbacks too. After a frame callback, a `resize` waits for the next frame (6.3).

**Dispositions.** Every finding is adopted.
- AMROT-ASTRA-08 in 9 and 13. AMROT-ASTRA-09 in 6.3 and 13 (the conservative option: the exception kept).
- AMR-O-R3-01 in 6.3 and 13. AMR-O-R3-02 in 9 (the refill sentence now follows both skips).

## As built

Where the build went its own way, by part.

**The contract.**
- The versions are OP_VERSION 47 and SNAPSHOT_VERSION 37, both identity steps.
- `videoGeometryProblem` lives in shared/limits.ts beside `videoSizeFits`, not in shared/videoGeometry.ts, so `stillFitsVideo` can read `drawnSize` without an import cycle (D-261102-900).
- The integer rules of 4.1 and 4.2 are shared pure functions (`mp4Orientation`, `mp4DrawnWidth`, `webmDrawnWidth`, `stretchedWidthPx`) that the parsers call (D-261102-903).
- With `tkhd`'s flag 0x8, `tkhd` must hold the coded width and any `pasp` must be square, even for a stretch that rounds to square (D-261102-901). A WebM stretch that rounds to the pixel width counts as square, as 4.1 says for MP4 (D-261102-904).
- `displayWidthPx` is bounded 256 to 4096 in the protocol, not only a whole number (D-261102-902), and `checkedVideoFacts` checks a plain video's area too.

**The server.**
- A manifest geometry's `displayWidthPx` is bounded 256 to 4096 at stage 1 of the import, the protocol's bound, and a present `null` skips the entry (D-261102-909).
- Every imported video is checked before the reuse, a plain `{}` geometry included, so its key follows the check (D-261102-908). The geometry key is SHA-256 over the domain string, a zero byte, the entry's digest, the turn as 16 bits, the mirror as 8 and the stretched width as 32.
- `qt  ` as a compatible brand is kept only in a MOV, and zeroed in an ISO file as before (D-261102-906). A version 1 sound entry keeps its version and its compression ID (0 or −2 only), and its packet size is zeroed (D-261102-905).
- A malformed `tapt`, or one with a size missing, counts as uneven and is refused after the codec, as an uneven one is (D-261102-907).
- A MOV goes up as `video/mp4`: the route still answers 415 to `video/quicktime`, and the server sniffs the bytes. scripts/editorconfig.test.ts lists `.mov` as a binary type.

**The client.**
- One placement, client/features/animmap/turn.ts: `videoPlacement` gives Konva's attributes and `placementTransform` the canvas matrix, the element's centered box and its CSS transform, written as the table row's `matrix(a, b, c, d, 0, 0)` about the element's center. The still keeps its rectangle with the turn and scale set back, since Konva reuses the one image node.
- The probe on the picked file returns no frame, rather than failing, for a size past the caps, a file it cannot read and its timeout (`readFirstFrame`). The stored copy has its own entry, `readStoredFrame`. The size refusal of AM 4.1 became `lengthRefusal` and `probeSizeFits`. Each probe carries `data-animmap-probe`, which the e2e steps use to tell it from the board's and the viewer's elements.
- The form's hold moved out of MapVideoRow.tsx's hook into upload.ts `VideoHold`, whose `run` the hook calls, so the random test drives the real rules. A cancel that races a hold wins: the held video is deleted and the run ends as cancelled. A failed read of the stored copy is the step `frame` of `AnimatedUploadError`, holding the video, and Try again of the same file reads the stored copy again without a second upload.
- The pickers take `video/quicktime` and `.mov`. A MOV goes up as `video/mp4`.
- A picked MP4 or MOV is scanned for an HEVC sample entry in its first and last MiB before the probe opens it, and refused in `video_hevc`'s words with nothing sent. A file the scan cannot decide goes up, and the server judges it (AMROT-O-06).
- The board judges the last frame callback's size once one gave it, and a new size is judged before that frame draws, so a frame past the rule is never drawn. A frame callback that gives no size ends the wait for one, and the reported size is judged as reported. `reportWaitsForFrame` in playback.ts holds a reported size only with the height exact. While a size waits for the first frame, Konva keeps the still and a frame callback runs with nothing drawn, so no frame reaches the map, by the board's draws or Konva's own, before it is judged. Each new source of a video is judged again on its own first frame (design review round 1, ANIMROT-ASTRA-03).
- The bench's turned run writes `turn: 90` into its video's row, since the server fills a map's facts from the row, and sets it on a portrait still. Its draw rows are gated as the others.
- e2e: am-9's file refused on the device is now an AVI, since a MOV goes on to the server. am-10 also checks a picked file this device cannot read whose stored copy it can, which makes its still with nothing asked. The amr steps run in a second DM session, signed in by the DM link, since their uploads would spend the 30 uploads an hour of the session am-12 uses.

