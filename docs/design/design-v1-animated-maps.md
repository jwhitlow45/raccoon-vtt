# raccoon-vtt: animated maps

Status: built (2026-11-02). Draft 3.3, revised after design review rounds 1 to 6, whose findings the "Design review" section at the end sums up. Decisions D-261102-440 to D-261102-459 (section 14), with the coordinator's D-261102-510 to 512 and 514. The "As built" section at the end says where the build went its own way, and the numbers in sections 9.4 and 13 are the design's, so read them with it.

Asked for in docs/design/mvp.md section 4, Later: "Animated maps (webm)." The project owner's order (D-261102-007, D-261102-008) puts it after the dungeon generator and snap off for a drag. It builds after weather (design-v1-weather.md), whose controller, settings and display files it shares (section 13).

## 1. Summary

- **Off unless the server owner turns it on** (D-261102-510). `ANIMATED_MAPS=1` in the server's environment turns it on. While it is off, the server refuses video uploads, serves no video bytes and refuses ops that add a video the room does not already name, and every map shows its still. Phase edits on an existing animated map still work. docs/self-hosting.md "6. If you use Cloudflare" explains Cloudflare's CDN terms on video and large files.
- **A video map is a still map with a video on the same rectangle** (D-261102-440). `map.assetId` stays a still image: the video's first frame, made on the DM's device, or an image the DM picks. It goes through today's image pipeline, and the video rides beside it as `map.video`. Everything that reads the map's pixels today reads the still and is unchanged: grid detection, the isometric side tints, thumbnails, Export as image, the builder over a map image and the phone-sized copy. Only the Top-down board draws the video.
- **WebM or MP4, one file per map** (D-261102-441). WebM takes VP8, VP9 or AV1, and MP4 takes H.264 or AV1. A file holds one video track, at most one sound track (Opus, or AAC in MP4), and in MP4 at most one timecode track, and nothing else (D-261102-514). The video must be solid and SDR, and HEVC and Vorbis sound are refused, as is a file that rotates or stretches its picture. The caps are 64 MiB, 1 second to 10 minutes and 60 frames a second (D-261102-443), and 8.3 megapixels with no side over 4096 (D-261102-512). A video counts toward the room's storage.
- **No transcoder** (D-261102-442). The server reads only container headers, with a small bounded parser of its own, and never decodes a frame. It refuses what it cannot vouch for, keeps an allowlist of what playback needs and zeroes everything else in place, padding included. It never writes inside the media data.
- **Phones get no smaller video** (D-261102-444). Phone size map detail is the default on most phones and small tablets, and Low power uses it. On Phone size a device plays a video only up to 1920 × 1080 (portrait the other way round), at up to 30 frames a second, and where the browser says it decodes the video power-efficiently. Otherwise it shows the still, which has a phone copy as today.
- **Each device decides** (D-261102-449). This device gains **Animated maps**: Moving (the default) or Still, and the table display's menu gets the same choice. Still downloads no video. Low power, reduced motion, a device that cannot play the file, a browser that will not start it and a device that falls behind (D-261102-450) all show the still too.
- **No sync across devices** (D-261102-448). Each device loops its own copy from its own start. No audio ever plays (D-261102-451).
- **Phases**: each of a map's up to 8 phases is a still or a video. Players receive only the phase showing, its video included (D-261102-452).
- **Versions:** the next free op version and the next free snapshot version, both identity steps (9.4).

## 2. The rules (SRD 5.2.1)

None apply. An animated map is a look. Torches or water in the art do not light the scene or make difficult terrain. The DM's lights, the builder and the scene's light level do that, as on a still map.

## 3. How other VTTs and map makers do it (ideas only)

- **Foundry VTT** takes a WebM or MP4 as a scene's background. Each client plays it muted on a loop from its own start. Foundry makes no phone copy, and players can lower the drawing quality on their own client.
- **Map makers** (Beneos, Moving Maps, Animated Battlemaps and others) commonly sell each loop as WebM for Foundry and MP4 for other tables, often at 1080p beside 4K, with a still image in the pack. Most loops run 10 seconds to a few minutes with no sound. Ambient tracks belong to the synced music item later in the list.

## 4. What the DM and players see and do

### 4.1 Adding an animated map

With the switch on, every place that brings in a map image today takes a video too: the New scene form's Map image, a scene's **Map image and grid** group, and **Add a phase**. Their pickers accept `image/*,video/webm,video/mp4`. The help under the ways to bring an image gains "A WebM or MP4 video makes an animated map, up to 64 MB. MP4 (H.264) plays on the most devices." With the switch off (`animatedMaps: false` from `/api/config`), the pickers take images only and the line does not show. Paste, starter packs, Link and Search the web take images only.

Picking a video runs four steps. Each step shows on the busy button with the shared loading indicator, and Cancel stops any step and keeps the form as it was.

1. **"Reading the first frame…"** (features/animmap/firstFrame.ts). A probe `<video>` in the form itself, 1 × 1 px, `aria-hidden`, muted and inline, opens the file from a `blob:` URL. So it works before any scene exists, when no board is mounted (Room.tsx mounts `MapStage` only once a scene is ready). It calls `play()` and then `pause()`, because iOS loads no media data until `play()`. It seeks to 0, and the wait ends at the first of `requestVideoFrameCallback`, `seeked` and `loadeddata`. It draws the frame at the video's own size and encodes it as WebP, else JPEG at 0.92, as `encodeThumb` does (client/features/scenes/thumbnail.ts). Then it clears its `src` and revokes the URL. It reads the length and size and refuses at once, in 4.5's words, anything the server would refuse.
2. **"Uploading the video… 42%"**, a real percent (D-261102-511). It comes from a new progress upload path in client/lib/api.ts: an XHR with `upload.onprogress` that keeps the upload queue and `retryOn503`.
3. **"Uploading the still… 80%"**. The frame goes up as a `map` image, with the video's file name as its name hint, so `crypt_30x20.webm` still sets the scale.
4. **"Looking for a grid…"**. The grid search runs on the still, as for an image.

Then the map is set with both, as one Setup history step (`scene.setMap`, `scene.create` or the phase list). On the players' scene the existing "players see it at once" confirmation comes first, as for an image.

**When step 1 fails**, the form says "This device can't read that video's first frame. Pick a still image for it, such as the one that came with the map." with **Pick a still image** beside it. This happens with a WebM on an iPhone before iOS 17.4, or after 20 seconds. If iOS Low Power Mode refused `play()`, the form says instead "Low Power Mode stopped the video from opening. Tap Try again, or pick a still image." **Try again** is a tap, so its `play()` is allowed. The video then uploads first. A file that failed before `loadedmetadata` gives the device no size, so the shape comes from the server's facts. The picked still matches when its height, scaled to the video's width, is within 1 px of the video's height (phaseProblem's rule). Otherwise the form says "That image isn't the video's shape (16:9). Pick one the same shape."

**When a later step fails or is cancelled**, the client deletes the video if this upload made its row (the answer's `created`, as a handout's carries). A video the room already held stays. Anything left behind shows as Not in use in the Library (4.6).

### 4.2 The Map image row of an animated map

The row's help, today "A 1920 × 1080 px image.", reads "A 1920 × 1080 px video, 0:42, looping. Its first frame is the still." Under it, one muted line shows this device's playback reason (5.3). It reads "Moving on this device." while the video plays. Otherwise it reads "Still on this device:" and then one of these:

- "Animated maps is set to Still." or "Low power is on." or "reduced motion is on."
- "Isometric and the Builder, Fog, Line up grid and Trap tools show the still."
- "this device can't play WebM (VP9)." or "this device can't play this video smoothly or without draining its battery."
- "Phone size map detail plays videos up to 1920 × 1080 at 30 frames a second."
- "the browser didn't start it. Tap the map to try again."
- "the video was slowing this device, so it stays still until you reload." or "the video didn't load."
- "animated maps are off on this server."

Below the row's buttons, **Use the still only** drops the video and keeps the still as a plain map, in one Setup history step. Replacing the map with an image does the same. The phase list shows "Video" after a video phase's name.

### 4.3 What players see

The map moves on the players' scene, under the board layer, tokens, darkness, fog and weather. Each device decides for itself (4.4). When the scene opens, the still shows as today, and "Loading <scene>…" waits for the still only. The video takes over once its first frame is ready, with no fade, since that frame is the still. A device that never plays the video shows the still for good, with no message, because the still is a whole map.

### 4.4 This device and the table display

**This device** gains **Animated maps** after Map detail, with two options sharing a row as Map detail's do:

- **Moving** (default): "Animated maps move. Downloads each map's video, up to 64 MB."
- **Still**: "Shows the first frame. Downloads no video."

When something else decides, a help line under the row uses 4.2's words, such as "Low power keeps animated maps still." The choice is kept as `rvtt.animatedMaps` ("moving" or "still", and anything else reads as moving) through `setting()` in features/device/settings.ts. Low power's help, as weather leaves it, gains "keeps weather and animated maps still". The row is hidden while the server's switch is off.

The table display's tap menu gains **Animated maps: Moving or Still**. It is kept with the display's other choices (features/display/remember.ts), apart from a member's setting in the same browser. A TV browser that cannot play the file shows the still.

### 4.5 The words for a refused video

The upload refusals are HTTP codes in shared/apiErrors.ts, with their words in client/features/animmap/words.ts:

- `video_type`: "That video isn't WebM or MP4. iPhone videos from Photos are MOV: save the map's MP4 to Files and pick it from there."
- `video_codec`: "That video's format doesn't play in most browsers. Save it as MP4 (H.264) or WebM (VP9)."
- `video_tracks`: "That video holds more than one picture or sound track, or a track of another kind. Export it again with one video and at most one sound track."
- `video_sound`: "That video's sound settings can't be checked. Export it again with AAC-LC or Opus sound."
- `video_vorbis`: "That video's sound is Vorbis, which can carry hidden text. Export it again with Opus sound, or with no sound."
- `video_alpha`: "That video has see-through parts. Animated maps must be solid."
- `video_hdr`: "That video is HDR, which looks washed out on the map. Export it in SDR."
- `video_size`: "Videos can be 256 to 4096 pixels on a side and 8.3 megapixels in all (3840 × 2160)."
- `video_geometry`: "That video's file turns or stretches its picture, as phone videos often do. Export it again without rotation."
- `video_length`: "Videos can be 1 second to 10 minutes long."
- `video_fps`: "Videos can be up to 60 frames a second."
- `video_unfinished`: "That video doesn't say how long it is, as screen recordings often don't. Save it again with a video editor."
- `video_fragmented`: "That MP4 is fragmented, as streaming exports are. Export it again as a regular MP4."
- `video_layout`: "That video's timeline is edited, or its sound runs longer than its picture. Export it again as a plain loop."
- `video_off`: "Animated maps are off on this server."
- `too_large` for a video: "That video is too large. Videos can be up to 64 MB."
- `quota_exceeded` for a video: today's words, which also cover a live upload that would leave the room under 32 MB free (6.3).
- `bad_video`: "That video could not be read."

A refused op uses the socket's existing `invalid` code (shared/protocol.ts) with a shared message from words.ts: `VIDEO_SHAPE` ("That still isn't the video's shape.") or `VIDEO_OFF`.

### 4.6 The Library

The DM's Library lists a video among the maps as a film-strip tile on the panel's tile color, with its length ("0:42") in the corner and "In use" or "Not in use". A video has no thumbnail of its own (D-261102-456). A tap opens it large in the viewer, since client/features/handouts/HandoutViewer.tsx gains a video page. The header shows the size, length and stored size, with Delete for a video not in use.

The viewer plays the video muted and looping, under the device's playback rule. Meanwhile the board's controller frees its own `src` as if covered, so only one element holds a video. Under Still, or where the device cannot play it, the viewer shows the still of the first scene or phase that names the video. If none does, it shows the film strip with "Still on this device" and the reason. "Delete N not in use" covers videos. "Or use a map already in this room" lists stills only, so picking an animated map's still makes a plain map.

## 5. Drawing

### 5.1 Where it sits

The video draws in the map layer, in the map image's place (client/canvas/layers/MapLayer.tsx `MapImage`), over the background and under the grid. There is no new Konva layer, because weather took the stage's last spare one (D-261102-446). So fog, darkness, weather and every token sit over the video as they sit over a still.

Only Top-down draws it, and Isometric shows the still (D-261102-447). Isometric's ground layer is the copy source of every raised top (relief/IsoBoard.tsx) and runs on the isometric scheduler, so a moving ground would recopy every top each frame. `MapContent` takes a `video` flag that only Top-down's map layer passes. So the isometric tree, and the side tints its `onDrawn` feeds, only ever get the still. The four tools that already show Top-down (Builder, Fog, Line up grid and Traps) show the still too, so the DM lines up and paints on the frame the grid search measured.

### 5.2 How it draws

- **One room-scoped controller.** `AnimMapController` (features/animmap/AnimMapController.tsx) joins `CONTROLLERS` (features/layers.ts) beside weather's. It owns the room's one `<video>`, which sits in the board's container at the board's size. The element is `aria-hidden`, with `pointer-events: none`, `muted` as both property and attribute (set before `src`), `playsInline`, `loop`, `disablePictureInPicture`, `disableRemotePlayback` and `preload="auto"`. It has no controls and no `autoplay` attribute, and it always starts by `play()`.
- **An opaque cover hides it** (D-261102-446). An opaque div sits between the element and the Konva container, painted in the board's ground from the light theme's board theme. That is the dark board ground, #16161a today, which the light theme keeps for the board. The canvas is transparent outside the scene's rectangle, and the Top-down stage is 0 wide in Isometric (Stage.tsx). So without the cover the raw, unfogged element would show there. Chrome's and WebKit's rules for pausing muted video test viewport intersection and CSS visibility, not occlusion. So the covered element keeps playing, and the build checks this on phones (section 15). The same holds on the table display and in View as a player.
- **Konva draws the element.** While the controller says it is playing, Top-down's `MapImage` hands the `<video>` to the `KImage` in the still's place, at the same world rectangle. The phase-swap keep (MapLayer.tsx `mapSwap`) only ever holds the still, never the element.
- **Draws are gated on the frame's media time** (D-261102-450). On each `requestVideoFrameCallback`, the controller draws the presented frame only when its `mediaTime` is at least 1/30 s minus 2 ms past the last drawn frame's. A loop's wrap, where `mediaTime` goes back, resets the gate. This needs neither the file's average rate nor rounded rate metadata: at 24, 25 or 30 fps every frame draws, at 50 to 60 fps every second frame does, and a variable-rate file draws its slow stretches whole and its fast ones at 30. Since media time runs at wall speed at normal rate, that bounds draws to about 32 a second. The media-time gate is the pacing. A wall-clock cap with one vsync of slack backs it whatever the refresh rate: it keeps the last 30 draw times and refuses a draw while the oldest is under 950 ms old. The guarantee both paths give is spacing: no two video draws are less than 1/30 s minus 2 ms apart, so no second holds more than 32 video draws, and none averages more than 32. Content at 30 fps or faster on a steady display draws 30 a second, and content at 31 or 32 fps draws every frame. A strict 1 s window would skip about one frame a second of a healthy 30 fps video on a display running slightly fast against the system clock, as 30 intervals at 60.05 Hz span 999.2 ms.
- **A draw's mechanics.** A video draw calls the map layer's `draw()` in that callback, never `batchDraw()`, and is skipped when the camera already drew the map layer in that frame. Camera draws and video draws are counted apart, as weather's are.
- **The fallback without frame callbacks.** Where `requestVideoFrameCallback` is missing (Firefox before 132), or has not fired within 1 s of `playing`, the controller draws on requestAnimationFrame, but only when at least 1/30 s minus 2 ms of wall time has passed since the last draw, with the 950 ms cap kept as the backstop. That paces it at every second vsync on a 60 Hz display, and every fourth or fifth at 120 or 144 Hz, with no gap over 50 ms while playing. `currentTime` advances between frames, so it cannot count frames there. Drawing an unchanged frame again costs a draw and shows nothing wrong.
- **The grid is built once per camera.** The map layer's grid shape caches its `Path2D`, keyed on the shape's absolute transform, the grid and the bounds, and a video draw strokes the cached path. Today a hex scene walks every hex in view on each draw (hexSpans.ts), which at 30 draws a second would be the main cost on a zoomed-out hex scene.
- **The still stays loaded** under the shared map loader, for the isometric tree, the setup tools and any return to Still. A video map's still is the video's size or the DM's picked image, no more than a still map holds today.
- **It stops when unseen**, by weather's signals: the page hidden, the map tree frozen, a panel over the whole screen, a scene still loading, the room closed, Isometric shown or a setup tool in use. Pausing stops decoding, and play resumes within one frame of the map showing.
- **It is freed when covered or left**: when View as a player covers the DM's room, when the Library viewer plays a video, on a scene or phase switch, on Still and when the video is removed. One commit stops handing the element to Konva. The next calls `removeAttribute("src")` and `load()`, which drops the decoder's frames. So Konva never draws a blank element.
- **One owner of the decoder.** The board's element and the Library viewer's take turns through one protocol in status.ts: a new owner waits until the previous one has cleared its `src` before it sets its own. So at most one of them per window holds a `src`, including when a DM replaces a map while another animated map plays. The first-frame probe (4.1) is exempt: it lives in the form, holds a local file for at most 20 seconds, and clears its `src` before step 2.
- **The real size is checked.** On `loadedmetadata` and every `resize` event, the controller compares `videoWidth` and `videoHeight` with the facts and with 5.3's rule 3. A stream can change size mid-file, as VP9 can, and one whose real size breaks the rule shows the still.
- **A failed load is retried once.** A network media error, such as a 503 while the room loads, gets one retry after 5 seconds. After that the device shows the still with "the video didn't load."

### 5.3 When a device plays it

`playback.ts` (features/animmap) is a pure function from what the device knows to `{ play: boolean; reason }`. The reason type is part of the AM-0 contract. The live status lives in features/animmap/status.ts, which AM-C writes and AM-D's row and viewer read. The device plays only when all four hold:

1. The server's switch is on, this device's Animated maps (or the display's) is Moving, Low power is off, and `prefers-reduced-motion: reduce` does not match. The motion setting is read live, through its change event.
2. The browser can play the file. `navigator.mediaCapabilities.decodingInfo({ type: "file", video: { contentType, width, height, bitrate, framerate } })` must answer supported and smooth, and on Phone size powerEfficient too (D-261102-514). Media Capabilities takes one codec per track, so `video.contentType` names the video codec alone, such as `video/webm; codecs="vp09.00.40.08"`. A file with sound adds a separate `audio: { contentType, channels, bitrate, samplerate }`, such as `audio/webm; codecs="opus"`, or `audio/mp4; codecs="mp4a.40.2"` for AAC. `framerate` is the file's peak rate (9.1). Without the API, `canPlayType` takes the multiplexed string, such as `video/webm; codecs="vp09.00.40.08,opus"`, and must answer "probably" or "maybe".
3. Map detail is Full size, or the video is at most 1920 × 1080 (1080 × 1920 in portrait) with a peak of at most 31 frames in any second, so a nominal 30 fps passes.
4. The controller has not stepped down (5.4), the real size check passed, and the browser has not refused to start it.

**Autoplay.** iOS Safari and Android Chrome start a muted, inline `play()` without a tap. iOS refuses even that in Low Power Mode, where `play()` rejects with `NotAllowedError`. Then the still stays and the reason says so. The next `pointerup` or `click` on the board's container calls `play()` again, because those events grant user activation and a touch's `pointerdown` does not. The tap still does whatever it does today, so no gesture is new.

### 5.4 The step-down

After a 2 s warm-up from each start, resume, scene load and remount, the controller reads each 10 s window. The 500 ms around a loop's wrap is left out, and a window holding a pause or a remount is dropped. Two counts can step it down, neither of which reads the file's rate (D-261102-450):

- **Decoder drops.** `getVideoPlaybackQuality()` gives `totalVideoFrames` (displayed and dropped) and `droppedVideoFrames`. The ratio is the window's change in dropped over its change in total, the same in every browser. More than a quarter dropped steps down, except in a window shaped like a 30 Hz render cap (callbacks at 25 to 35 a second, each rising by 1), where the frames the compositor skips show as drops. There the expected drops are (fps − 30) / fps, and only drops beyond that count toward the quarter, so a struggling Full size device still steps down.
- **Late callbacks.** rVFC's `presentedFrames` rises by 1 for each frame the compositor showed. A callback is late when it rose by 3 or more since the previous one, so two or more shown frames never reached the page. More than a quarter of a window's callbacks late steps down. A healthy variable-rate file rises by 1 per callback in slow and fast stretches alike. A 60 fps video under Chrome's Energy Saver, which renders at 30, rises by 1 per callback, its skipped frames counted as decoder drops, so it is not late. A device that falls further behind is. Should a browser still step down under Energy Saver, 4.2's slowing line reads "the video was slowing this device, or the browser is saving power, so it stays still until you reload."

In the requestAnimationFrame fallback only the decoder drops count. The step-down lasts until the page reloads and only goes one way. Safari and Firefox may count the covered element's frames differently, so the live check verifies each browser before it ships (section 15).

## 6. Performance

### 6.1 Budget

The risk is a mid-range phone held upright for a four-hour session, with fog, party vision and Heavy rain Moving over a 1080p loop. `scripts/bench-animmap.ts` follows bench-weather's page: 390 × 844 at 3x, with the processor slowed 4 times, a 1920 × 1080 30 fps VP9 fixture and Heavy rain. It runs on a square scene, and on a hex scene zoomed out until a hex is just over `HEX_LINES_MIN_PX`. Targets:

- A pan's and a drag's 95th percentile frame grows by at most 2 ms over the same scene with a still map.
- The main thread's time per video draw is at most 1.5 ms at the median and 4 ms at the 95th percentile, on both scenes.
- At most 32 video draws in any second, counted apart from camera draws, and none while paused or Still.
- Over a 10-minute run, the JS heap and the element count end within 5% of where they began.

A desktop Chrome slowed 4 times cannot show what a phone's GPU and battery pay. The live play review on a real phone checks that, and Still and the step-down are the way out.

### 6.2 Memory and battery

- **Decoding.** A 1080p frame is about 3 MB in the decoder's format, and a decoder holds a handful, so about 20 to 30 MB. 4K takes about four times that, so Phone size shows it still.
- **Canvas.** Nothing new: the map layer's canvas exists today. It is drawn up to 30 times a second instead of on change, each time from a frame the browser already decoded, plus the cached grid path.
- **Battery.** VP9 and H.264 decode in hardware on current phones. Software decoding can still answer smooth, as AV1 does on most phones. On Phone size the rule also asks for powerEfficient, so such a phone shows the still. Full size devices, mostly computers and large tablets, play whatever is smooth. A 60 fps loop decodes twice the frames the canvas shows, so Phone size plays up to 30 fps only.
- **Network.** A device downloads the whole video once per scene visit, in range requests from the start. Still downloads nothing.

### 6.3 Sizes and caps (shared/limits.ts)

| What | Cap | Why |
| --- | --- | --- |
| A video's file | 64 MiB | Most 1080p loops of a minute or two fit, under Cloudflare's 100 MB request body and the 95 MB web import |
| Quota headroom | A live upload must leave 32 MiB of the room's quota free. An import needs only the quota | A room at its quota turns read-only mid-session (actor.ts `#checkQuota`), but a near-full room's backup must still import |
| Length | 1 s to 10 min | Under a second stutters. Past 10 minutes is a film |
| Size | 256 to 4096 on each side, at most 8,294,400 pixels (3840 × 2160) | D-261102-512: square and large maps fit by area |
| Frame rate | at most 61 frames in any one second of the file, and 36,600 frames in all | Measured over every frame (section 10), so variable rate is allowed within it |
| Upload time | 15 minutes, at least 32 KiB a second as today | 64 MB on a slow home uplink |
| Intake slot | per session, not per IP, for a video | A 15-minute upload must not 503 every phone sharing the table's IP (slots.ts) |
| Parser reads | at most 4 KiB per value, 8 MiB for MP4's `moov`, 200,000 element headers plus 36,600 video and 60,000 sound frame headers counted apart, 8 levels deep, 5 s, and only headers: no write inside `mdat` or a Cluster's blocks | Bounded work and memory (section 10) |
| Videos per scene | one per phase, so 8 | Today's phase cap |
| Storage | the room's quota, 1 GiB by default | About 16 videos at the cap |
| CLI import | the room's quota plus the state caps, derived from ROOM_QUOTA_MB | IMPORT_LIMITS.inflatedBytes is a fixed 1 GiB today, which refuses a full room even on the command line |

## 7. Privacy and security

- **What a player's device may receive:** only the video of the phase showing on the players' scene. It travels in `map.video`, which the projection copies with `map` (`SCENE_FOR_PLAYERS.map: "copied"`), and phases stay DM only. `visibleAssetIds` adds only the shown map's video for a player, and every phase's video for the DM. The DM's device preloads other phases' stills only. The asset routes (server/http/assets.ts and display.ts) serve a video to a player only while it is in their visible set, and answer today's 404 otherwise.
- **The video reaches players whole**, as a map image does, and each device draws the fog over it.
- **Metadata is zeroed, from an allowlist** (D-261102-442). Images are re-encoded, which strips EXIF. A video is not, so the server keeps only what playback needs (section 10) and zeroes everything else in place, with no byte moved and no size changed. A dropped WebM element becomes a Void element with an all-zero payload. A dropped MP4 box is renamed `free`, also with an all-zero payload. Padding the file already holds (WebM Void, MP4 `free`, `skip` and `wide`) is zeroed too, since an editor may have blanked metadata there without erasing it. Timestamps inside kept fields, such as the creation and modification times in `mvhd`, `tkhd` and `mdhd`, are zeroed, and handler names and kept strings are zeroed to empty.
  - This covers the location atoms `©xyz` and `com.apple.quicktime.location.ISO6709` wherever they sit (`udta` and `meta` in `moov`, `trak` and `mdia`). It also covers WebM Tags, Attachments, Chapters, Title, SegmentFilename, DateUTC, track Name and CodecName.
  - CRC-32 elements are dropped too, since the zeroing would leave their checksums stale.
  - The server never writes inside the media data, so it never writes at offsets the file's tables give (D-261102-514). A file with any track beyond one video track, at most one sound track and, in MP4, one timecode track is refused (`video_tracks`). The timecode track is kept as it is: its one sample is a frame count, which can read as a time of day but names no place or person. That is accepted and recorded.
  - Vorbis sound is refused (`video_vorbis`), since its CodecPrivate holds the Vorbis comment header, free text such as a location or contact. Clearing those strings in place inside a packed header is not certain to leave a header every browser still reads. Opus, the common WebM sound codec, carries only OpusHead in CodecPrivate. AAC's `esds` can carry a URL and a program configuration element with a comment, so only a bounded subset of it is accepted (section 10).
  - Text inside the media data itself, such as H.264 SEI user data or AV1 metadata OBUs, is never touched, since the server never writes there. That is accepted and recorded beside the timecode track.
  - The tests search the stored bytes for each identifying string (section 12).
- **No decode on the server.** Players' browsers do decode the file, so a DM could send players bytes aimed at a browser's video decoder, a surface images do not have. This is accepted. Browsers decode media in a sandboxed process, the DM is already trusted with the players, and any player can choose Still, which downloads nothing. The docs commit records it in docs/assurance-case.md, whose claims that every upload is "re-encoded and stripped of metadata" change to say what a video gets.
- **Serving.** A video is served as `video/webm` or `video/mp4`, taken from its row, never from its bytes. It gets the same headers as images: `nosniff`, the sandboxing CSP, `cross-origin-resource-policy: same-origin` and `private, immutable`. It also carries a strong `ETag` of its hash and pipeline (D-261102-457).
- **CSP.** The page's policy gains `media-src 'self' blob:`, with `'self'` for the board's video and `blob:` for the first-frame probe. The change touches server/http/security.ts, its pinned test and the copy pinned in docs/design/design.md.
- **The upload route** (server/http/assets.ts) accepts `video/webm` and `video/mp4` only with `kind=video`, and image types only for image kinds. It checks this before any body byte is read, and anything else gets 415.
- **Cloudflare** (D-261102-510). Cloudflare's Service-Specific Terms for its CDN say non-Enterprise customers must use its paid services to serve video and other large files, and that Cloudflare may limit CDN access otherwise. The risk is to the whole site, so the switch is off by default. docs/self-hosting.md "6. If you use Cloudflare" says so, with a link to the terms, before the line that turns it on.

## 8. Accessibility and the UI checklist

- **Loading:** each step of 4.1 shows on the busy button, uploads with their percent, through the shared indicator after about 200 ms. A second tap is refused. Every path ends with the map set or a plain error from 4.5. The board never waits on the video.
- **Keys and focus:** no new key or gesture, so the shortcut sheet and FEATURES.md's Shortcuts do not change. Use the still only, Pick a still image and Try again are buttons in tab order. Animated maps is a radio group like Map detail's.
- **Screen readers:** the `<video>`, the probe and the cover are `aria-hidden`, as the canvas is. The Map image row's help reads its size, length and "looping", and the device line reads as text. Players get no status line.
- **Reduced motion:** the still, following the setting live.
- **Large interface sizes:** at 130% on a 320 px phone, the Map image row, its device line and its buttons wrap. The radio row goes to one option per row there, as Map detail's does.
- **Color:** new surfaces use the light theme's tokens (the light theme's design), never a fixed color. The cover uses the board theme's ground.
- **Exact words:** sections 4.1, 4.2, 4.4 and 4.5.
- **A preview before the build**: the Map image group of an animated map, folded and open, with its device line and Use the still only. Also the upload's steps with the percent, the Pick a still image and Low Power Mode fallbacks, This device's Animated maps row, and the Library's video tile and viewer.

## 9. The model

### 9.1 State

```ts
// shared/model.ts
export type MapVideo = {
  assetId: AssetId;
  /** The rest comes from the asset row, filled by the server like a map's size, never by the client. */
  widthPx: number;
  heightPx: number;
  container: "webm" | "mp4";
  /** RFC 6381 strings, such as "vp09.00.40.08", and "opus" or "mp4a.40.2". `audio` is absent with no sound track, and a file has at most one. */
  video: string;
  audio?: string;
  /** The peak rate: the most frames in any one second of the file, counted over every frame (section 10). */
  fps: number;
  durationMs: number;
  kbps: number;
  /** The sound track's channels and sample rate, for Media Capabilities' audio configuration. */
  audioChannels?: number;
  audioHz?: number;
};
export type SceneMap = { /* as today */ video?: MapVideo };
export type MapPhase = { /* as today */ video?: MapVideo };
```

The still keeps `assetId`, `widthPx`, `heightPx`, `cellPx` and `originPx`. The grid and every reader work in the still's pixels, and the video is stretched to `mapWorldRect(map)`. The video's size is its coded size, which section 10 requires to equal its display size, so the phone cap reads the size a decoder needs.

**Every place that builds a map or a phase field by field carries `video`**:

- shared/reducer/phases.ts: `phaseMap`, `withPhases`, and `setMapWithPhases`, which puts the new map's `video` on the active phase or removes it.
- client/features/phases/rules.ts: `phasesOf`'s implicit first phase and `addPhase`'s new phase.
- server/rooms/remap.ts: both field-by-field copies, where the refill overwrites the old id.
- server/rooms/stateSchema.ts: the strict map and phase schemas take `video` with protocol's bounds. `phasesFitTheirGrid`, which compares the active phase with `map`, also requires `map.video` to equal the active phase's video in presence, id and facts.

The asset row gains a kind `video` and two columns (db/schema.sql, each step idempotent like the thumb kind's). `media text` holds `webm` or `mp4`, and is null for an image. `video jsonb` holds the facts above, without the id and size. A video row's one variant is `full`. The kind joins all four declarations: shared/permissions.ts, server/assets/kinds.ts, client/lib/api.ts and `AssetFact` in server/rooms/persistence.ts.

### 9.2 Ops and permissions

There is no new op. `scene.setMap`'s and `scene.create`'s `map`, and each entry of `scene.update`'s `phases`, take an optional `video` (shared/protocol.ts `mapVideo`). The client sends the id with placeholders that the server overwrites. `withAssetSizes` (server/rooms/actor.ts) fills every field but the id from the asset row, and `loadAssetFacts` gains `media` and `video` for that. `assetIdsOf` already finds the nested id.

shared/permissions.ts refuses each of these with `invalid`:

- a video that is not a `video` row of the room (`canUseAsset(..., "video")`)
- a `video` on a map whose still is missing
- a video whose shape is more than 1 px off its still's after scaling (`VIDEO_SHAPE`)
- while the switch is off, an op that adds a video reference the room's state does not already hold anywhere, compared room-wide as `restoreAddedAssets` (shared/referencedAssets.ts) compares a restore's (`VIDEO_OFF`, from a permission dep the actor sets). Renaming, reordering, adding a still phase, removing a phase or a video, and `scene.duplicate` of a scene whose video the room holds all pass. A history restore (`sys.restore`) that passed the server's undo checks is exempt from this rule, so undoing a video phase's removal passes too, though its asset must still exist as a `video` row of the room

Only the DM sets maps, as today. `restoredAssetUsable` checks the kind `video` when an undo brings a video back. shared/referencedAssets.ts names map and phase videos with the kind `video`, so the Library's In use, deletion and cleanup see them.

### 9.3 Copies, backups and import

- **Copies.** Duplicating a scene copies its map and phases, videos included. Thumbnails draw the still. Export as image draws the still too, and MapExport.tsx says "An animated map exports its still image." under the size choice.
- **Backups.** A room backup carries the video as `assets/<sha256>-video-full.webm` (or `.mp4`), with `media` in the manifest (server/rooms/exportRoom.ts).
- **Import.** importRoom.ts (AM-B) checks each video with the same intake as an upload, against the quota. A video entry reserves its checked entry size, not the kind's 64 MiB maximum (today `importFromZip` reserves `KINDS[kind].maxUploadBytes`), keeping the file cap, the streamed-size check that the bytes read match the entry, and the final quota check at commit. Image entries reserve their entry size the same way, in the same `importFromZip`. It hands the new rows' facts to `refillMapVideos` (remap.ts, AM-A), the refill's one owner. That function overwrites each `map.video` and each phase's `video` from its row after the id remap, then sets the shown `map.video` from the surviving active phase. A video the import skips leaves the still as a plain map, so the scene still works, and while the switch is off every video is skipped. The CLI import's inflated cap comes from the quota (6.3).
- **On disk** a video is `<sha256>-video-full-v<pipeline>.webm` or `.mp4` (D-261102-454). The orphan sweep (cleanup.ts `VARIANT_FILE` and its comment) takes both extensions. docker/backup.sh runs on BusyBox in postgres:17-alpine, so its changes are BusyBox-safe:
  - `LIST_LINE` becomes `grep -E` with `(webp|webm|mp4)`, or three patterns, never a BRE `\|`.
  - Each `find` becomes `\( -name '*.webp' -o -name '*.webm' -o -name '*.mp4' \)`.
  - The awk that prints names maps the `media` column completely: null (`\N`) or missing, as in an old dump, to `.webp`, `webm` to `.webm`, `mp4` to `.mp4`, and any other value fails the list, as an invalid row fails it today (backup.sh 154 to 160).
  - selfhost/compose.yml embeds the script (scripts/selfhost-compose.ts), so it is regenerated. scripts/backup-check.ts tests an old dump and a new one.
  - `ANIMATED_MAPS` goes in docker/server.env.example and the environment list of docker-compose.server.yml, and selfhost/env.example and selfhost/compose.yml are regenerated from them.

### 9.4 Versions, replay and migration

- **The next free op version**, an identity step. Three ops may carry `video`, a new optional field. No stored op changes shape, the reducer writes nothing new on its own, and old ops replay as before.
- **The next free snapshot version**, an identity step, so an older build refuses a room that may hold a video cleanly (as with weather's D-261102-133).
- **Migration:** none. A room has no video until the DM adds one.

## 10. Server checks (server/assets/video/)

`checkVideo(path)` runs in the processing queue like an image job and never decodes a frame. It reads through a 64 KiB window, not one `read()` per header, because libuv's thread pool is shared with argon2 (process.ts). It checks its 5 s budget inside every loop, since a timer cannot interrupt synchronous code. It never throws anything but an `AssetError` carrying a 4.5 code.

**Bounds.** Every value read is at most 4 KiB. A track's CodecID is read before its CodecPrivate, so a Vorbis track is `video_vorbis` whatever its size, and any other CodecPrivate over 4 KiB is `bad_video`. Block and sample headers are counted apart from the 200,000 element headers, at most 36,600 video and 60,000 sound frames. Integers above 2^53 are `bad_video`. Floats must be finite and above 0, and TimestampScale above 0. An unknown size is `video_unfinished` wherever it appears. A box smaller than its own header, an element that runs past its parent, and bytes after the last top-level element are `bad_video`. An MP4 size of 0 (to the end of the file) is allowed only on the last top-level box.

**Sniff.** `file-type` tells WebM (`webm`) from MP4 (`mp4`, `m4v`). Matroska that is not WebM, MOV (`qt`), AVI and every other container are `video_type`.

**WebM** (webm.ts):

- One Segment reaching the file's end, and Info with TimestampScale and Duration (else `video_unfinished`). The last Cluster's timestamp must fall within Duration. ContentEncodings (compression or encryption) are `bad_video`.
- Exactly one video track, in V_VP8, V_VP9 or V_AV1, else `video_codec`. AlphaMode 1 or BlockAdditions are `video_alpha`. A Colour TransferCharacteristics of 16 or 18 (PQ, HLG) is `video_hdr`.
- At most one audio track, in Opus. Vorbis is `video_vorbis`, other audio codecs are `video_codec`, and a second video or audio track, or any other kind, is `video_tracks`.
- **The sound's length**: the Cluster walk inspects each sound block's timing before skipping its payload. Only sound that ends more than max(one video frame, 50 ms) after the video is `video_layout`, the same contract as MP4's. Sound that ends earlier, by any amount, is fine. The sound's end is found from its last block: its timestamp minus CodecDelay, plus its duration, minus its DiscardPadding only where that is positive, since a positive value trims the block's end. A negative DiscardPadding trims the block's start and leaves its end where it is. The duration is BlockDuration where a BlockGroup gives one. Otherwise it is the Opus packet durations of the block's frames: the lacing header (Xiph, EBML or fixed) gives each frame's size, and each frame's TOC byte, and for code 3 its frame count byte, gives the packet's length (RFC 6716 section 2.1.4, at most 120 ms). Those few bytes are the only payload bytes read, and nothing is written there.
- DisplayUnit 0, with DisplayWidth and DisplayHeight, where set, equal to PixelWidth and PixelHeight, and no PixelCrop. Else `video_geometry`.
- **The frame rate** is measured over every frame, never taken from DefaultDuration alone. The walk that already reads every Cluster's headers also reads each video block's header: the track number as a VINT of up to 8 bytes, the 2-byte relative timestamp and the flags. Sound blocks have their timing inspected first (the sound's length, above), and blocks are then skipped by size. An invisible block is skipped, and lacing on the video track is `bad_video`, since video is never laced. From the frames' timestamps the check takes the most frames in any one-second window, a sliding count over the sorted times, which is the `fps` fact. More than 61 frames in any second is `video_fps`, as is more than 36,600 frames in all. So a fast later stretch cannot hide behind a slow start, and no file lacks a rate.
- **The codec string.** AV1 requires its av1C CodecPrivate and builds `av01.P.LLT.DD` from it, and a missing or malformed record is `bad_video`. VP9 takes profile, level and bit depth from CodecPrivate where present. Otherwise it takes profile and bit depth from the first keyframe's uncompressed header, and the level from the VP9 level table for the size and rate. VP8 is `vp8`.

**MP4** (mp4.ts):

- `ftyp` first, exactly one `moov` of at most 8 MiB, and at least one `mdat`. An `mvex` or `moof` box is `video_fragmented`.
- Exactly one `vide` track, in `avc1`, `avc3` or `av01`, with other video codecs `video_codec`. At most one `soun` track, in `mp4a` (AAC, its codec string `mp4a.40.x` from `esds`) or `Opus`. **`esds` is accepted only in a bounded subset**: one ES_Descriptor with URL_Flag, streamDependenceFlag and OCRstreamFlag all 0, one DecoderConfigDescriptor for MPEG-4 audio, one DecoderSpecificInfo holding an AudioSpecificConfig of object type 2 (AAC-LC), or 5 (SBR) or 29 (PS) whose inner object type is 2, with a channelConfiguration of 1 to 7 (0 would bring a program configuration element and its comment field), and dependsOnCoreCoder and extensionFlag 0, then a predefined SLConfigDescriptor. MPEG-2 AAC (objectTypeIndication 0x66 to 0x68) is `video_sound`. One sync extension is admitted, the exactly bounded, text-free one FFmpeg's AAC encoder always writes: syncExtensionType 0x2b7 with extensionAudioObjectType 5 and sbrPresentFlag 0, followed only by zero bits to the byte's end. So FFmpeg's 48 kHz stereo AAC-LC, `11 90 56 e5 00`, is accepted. The DecoderSpecificInfo must end exactly where the parsed AudioSpecificConfig, with that extension and its padding, ends. Any other descriptor, flag, extension, an explicit SBR-present extension or trailing data is `video_sound`: "That video's sound settings can't be checked. Export it again with AAC-LC or Opus sound." At most one `tmcd` track, kept as it is. A second `vide` or `soun` track, or any other track, is `video_tracks`.
- **Geometry.** The `tkhd` matrix must be identity, and `tkhd`'s 16.16 width and height (what `videoWidth` reports) must equal the sample entry's coded size. Any `pasp` must be 1:1, and there must be no `clap`. Else `video_geometry`.
- Only an `nclx` `colr` is kept, and one of 16 or 18 transfer is `video_hdr`. Any other `colr` (`prof`, `rICC`, whose ICC profile can hold text tags) is renamed `free` and zeroed. The codec string comes from `avcC`, or from `av1C`, which AV1 requires. Every codec record (`avcC`, `av1C`, `dOps`, and in WebM OpusHead and VP9 CodecPrivate) is fully consumed by its parser, and bytes left over are `bad_video`. `avcC` is read with its High-profile extension optional, since some muxers omit it. Trailing bytes there that are all zero are kept, still zero, and only non-zero leftovers are `bad_video`.
- **The length** is the movie's presentation timeline. Each track has no `edts`, or a single `elst` entry that covers its media and starts at media time 0 or at one positive offset. Only a sound track that ends more than max(one video frame, 50 ms) after the video track is refused, the same contract as WebM's. The tolerance is there because AAC's padding at 48 kHz runs to 21.3 ms against a 60 fps frame's 16.7 ms. Sound that ends earlier, by any amount, is fine. `mvhd`'s duration matches the longer of the two within the same tolerance. Anything else is `video_layout`.
- The frame rate is measured as in WebM, from the video track's `stts` (and `ctts` for presentation order) expanded to each sample's time, at most 36,600 samples, with the same one-second sliding count and the same caps.

**The allowlist** (section 7). Everything not listed here is zeroed in place.

- **WebM keeps:** the EBML header. SeekHead entries that point at kept elements. Info's TimestampScale and Duration, with MuxingApp and WritingApp kept as zeroed, empty strings because the format requires them. Tracks, with TrackNumber, TrackUID, TrackType, the Flag elements, DefaultDuration, CodecID, CodecPrivate, CodecDelay and SeekPreRoll. Video (the pixel and display sizes, DisplayUnit, FlagInterlaced, AlphaMode and Colour) and Audio (the rates, Channels and BitDepth). Cues. Clusters, with Timestamp, SimpleBlock, PrevSize, and BlockGroup's Block, BlockDuration, ReferenceBlock and DiscardPadding. Void, its payload zeroed.
- **MP4 keeps:** `ftyp`, `moov`, `mdat` and `mvhd`, with `free`, `skip` and `wide` kept but their payloads zeroed. The `tmcd` track's sample entry keeps only its fixed fields, and its `name` box is zeroed. In kept tracks: `tkhd`, `edts`/`elst`, `mdia` with `mdhd` and `hdlr` (its name zeroed), `minf`, `vmhd` or `smhd`, and `dinf`/`dref` (self-contained only, else `bad_video`). `stbl` with `stsd`, `stts`, `ctts`, `stss`, `stsc`, `stsz` or `stz2`, `stco` or `co64`, `sdtp`, `sbgp`, `sgpd` and `cslg`. Sample entries with `avcC`, `av1C`, `esds`, `dOps`, `pasp`, `btrt` and `colr`.

**Then** the caps of 6.3 apply, and the check returns the facts, with `kbps` worked out from the size and length.

**Ingest.** `AssetService.ingest` branches on the kind. A video skips `sniffImage` and sharp, runs `checkVideo` and places one file. The row's hash is the upload's, and the zeroing is deterministic, so the same bytes make the same file under one pipeline number. Files are named by upload hash and pipeline and never zeroed again. So videos have their own `VIDEO_PIPELINE` in kinds.ts, stepped whenever the check's output changes.

**Serving** (serve.ts `sendVariant`, called from server/http/assets.ts and display.ts):

- One `Range` gets 206, with `Content-Range` and `Accept-Ranges: bytes`, and a range past the end gets 416. Safari plays nothing without range answers.
- A request for several ranges gets 200 and the whole file. An `If-Range` with the matching ETag is honored, and any other `If-Range` gets 200 and the whole file.
- While the switch is off, every video variant answers 404.
- Each range request passes the same grant and visible-set checks as an image request. The visible set is cached per committed seq (actor.ts), so the integration test measures 64 range requests with ops landing between them.

## 11. Cases

| Case | Expected | Test |
| --- | --- | --- |
| Switch off | Pickers images only, upload `video_off`, video GET 404, an op adding a new video `invalid`, import keeps stills, maps still | animmap.itest, am-12 |
| Switch off, a scene with two video phases: rename a phase, add a still phase, remove one, undo each | Every edit and undo accepted, the videos kept | permissions test, am-12 |
| Switch off: remove a video's last reference and undo it, duplicate a scene with a video, add a video the room never held | The undo and the duplicate accepted, the new video `invalid` | permissions test, am-12 |
| First scene of a new room made from a video | The probe in the form reads the frame with no board mounted | firstFrame test, am-1 |
| Replace a map while another animated map plays | The old `src` cleared before the new one is set | controller random test, am-3 |
| DM adds a 1080p WebM to a new scene | Percent shown, still and video uploaded, grid searched on the still, one Setup step, map moves | animmap.e2e am-1 |
| `crypt_30x20.webm` | Scale from the name | upload test, am-1 |
| Still upload fails or is cancelled | The video this upload made is deleted, a held one kept | upload test, am-1 |
| Players' scene, player on Moving | Plays under fog and tokens, at most 32 video draws in any second | am-2 |
| Zoomed out, panned to an edge, Isometric, fully fogged | Pixels outside the scene rect equal the board ground, no video anywhere but in the map's place | am-2 |
| Player's socket, a video phase not showing | Never receives it, 404 on its id | project test, animmap.itest |
| DM switches to a video phase | Player plays it, the old element freed | am-3 |
| Add a phase, rename the first phase, move or remove phases on an animated map | Every video kept where it was | rules test, reducer test |
| Still, Low power, reduced motion | No video request, still shown, reason line | am-4 |
| Phone size and a 4K or 60 fps video, or not power-efficient | Still with the Phone size or efficiency line | playback test, am-5 |
| VP9 changes size mid-stream past the rule | Still on resize | controller test |
| `play()` rejects | Still, then a `pointerup` on the board plays it | controller test, am-6 |
| Isometric, a setup tool, page hidden, a panel over the screen | Paused, plays again within a frame after | controller random test, am-7 |
| View as a player, the Library viewer playing | The covered board's `src` cleared, one element holding a video | controller random test, am-7 |
| 24, 25, 30, 50, 59.94 and 60 fps, a 33,333,333 ns DefaultDuration, and 12 s at 60 fps then 18 s at 10 fps, at 60, 90, 120 and 144 Hz, healthy | Never steps down, at most 32 draws in any second, the slow stretch drawn whole | controller and stepDown random tests |
| 31 fps content, and the rAF fallback at 60, 120 and 144 Hz | 31 fps draws every frame. The fallback draws with no gap over 50 ms while playing and at most 32 draws in any second | controller random test |
| 30, 29.97 and 60 fps on 59.95, 60.00 and 60.05 Hz displays, healthy | No frame the media-time gate admits is skipped by the wall-clock cap | controller random test |
| 60 fps under a 30 Hz render cap (Energy Saver), and the rAF fallback with a smoothly advancing clock | Not late, never steps down, at most 32 draws in any second. A struggling device under the cap still steps down | stepDown random test |
| A quarter of frames dropped for 10 s | Still until reload, never back up | stepDown random test |
| Table display Moving, then Still | Plays, then the still, no further requests | am-8 |
| HEVC, alpha, HDR, screen recording, fragmented, rotated, stretched, edited timeline, sound 60 ms longer, 11 min, 4097 wide, 9 MP, 70 MB, MOV, Vorbis, a second video or sound track, a subtitle track | Each refused with its 4.5 words | parser tests, am-9 |
| 60 fps MP4 with AAC ending 21 ms after the video | Accepted | mp4 test |
| WebM with no DefaultDuration, a short first Cluster, a faster later stretch, 2-byte and 8-byte track VINTs | The peak counted over every frame, the fast stretch refused past 61 a second | webm test |
| AV1 without av1C | `bad_video` | parser tests |
| Phone MP4 with a location, WebM with Title, DateUTC, Tags and CRC-32, a Void and a `free` already holding a name | No identifying string in the stored bytes, every blanked range and padding zero, still plays in Chrome | parser tests, animmap.itest, am-9 |
| Any accepted file | No byte written inside `mdat` or a Cluster's blocks | video random test |
| iPhone cannot decode the WebM | Video uploads, then Pick a still image, checked against the server's facts | firstFrame test, am-10 |
| Use the still only, then Undo | Video gone and back, one Setup step | reducer test, am-11 |
| Delete a video in use, then not in use | Refused, then deleted on a second tap, quota freed | library test, animmap.itest |
| A video that leaves under 32 MiB of quota | `quota_exceeded` | animmap.itest |
| Backup and import, mismatched active phase video, skipped active phase video | Video checked and refilled, mismatch refused, a skip leaves the still | stateSchema test, animmap.itest |
| Export a room at its quota minus 10 MiB, then import it, and a room 976 MiB full of 1 GiB with a 1 MiB video last | Both imported, the video reserving its entry's size, no headroom refusal | animmap.itest |
| `esds` with a URL, a PCE comment, an explicit SBR-present extension, trailing bytes after the AudioSpecificConfig, MPEG-2 AAC, an ICC `colr` with a name tag, WebM sound 60 ms longer, a 5 KiB Vorbis CodecPrivate | `video_sound` for the first five, accepted with the ICC zeroed and the name gone from the bytes, `video_layout`, `video_vorbis` | parser tests |
| FFmpeg's AAC-LC AudioSpecificConfig `11 90 56 e5 00` (SBR-absent sync extension), WebM and MP4 sound ending well before the video, a laced Opus block, and blocks trimmed by positive and by negative DiscardPadding ending within 50 ms | Each accepted, the negative padding not moving the end | parser tests |
| `avcC` from FFmpeg High, Android MediaMuxer High and a Baseline file, and one with non-zero bytes after the record | The three accepted, the last `bad_video` | mp4 test |
| A video with sound | `decodingInfo` gets one codec per configuration and plays it | playback test with a stub that rejects multi-codec types |
| Range, multi-range, If-Range, ops between requests | 206, 200 whole, honored by ETag, visible set right after each op | animmap.itest |
| Nightly backup on BusyBox, old dump and new | `.webm` and `.mp4` copied, `.webp` as before | scripts/backup-check.ts |
| Older build loads the new snapshot version | Refused cleanly | migrate test |
| Changed screens at 1440 × 900, 390 × 844 and 320 × 568, 100% and 130% | Nothing over 1 px out of line | alignment roots |

## 12. Tests

**Unit** (`node:test`):

- **Parser tests** in `server/assets/video/webm.test.ts` and `mp4.test.ts` run on files a test writer builds byte by byte (`videoTestutil.ts`, which writes EBML elements and MP4 boxes). The writer can also rebuild a real fixture with Title, DateUTC, Tags, CRC-32 elements and a `©xyz` added. There is one case per check in section 10 and per 4.5 code. The tests check that the zeroing keeps the length and every offset, that no identifying string survives (a byte search), and that every blanked range is zero.
- **A parser property test**, `video.random.test.ts` (fast-check): any bytes, truncation or bit flip of a valid file ends in facts or an `AssetError`, within the budget, never reading past the file's end. Every accepted file's zeroed ranges are all zero.
- **Shared tests** of the reducer, projection and permissions: `video` through every phase op, the shape rule at 1 px, the kind and switch refusals, `visibleAssetIds` for a player and for the DM, referenced assets, the identity version steps, and the state schema's active-phase video rule. `client/features/phases/rules.test.ts` covers add, rename, move and remove on an animated map.
- **Playback**: `client/features/animmap/playback.test.ts` covers every rule of 5.3 and its reason.
- **A controller property test**, `controller.random.test.ts`, under the state machine rule. It runs 2,000 random sequences of frames at mixed frame and refresh rates, camera draws, Animated maps, Low power and reduced motion flips, page hides, tree and tool switches, panels, covers and the Library viewer, scene and phase switches, `play()` rejections and taps, resizes, media errors and quality windows. Its invariants:
  - No video draw while not playing, no two video draws less than 1/30 s minus 2 ms apart, and so at most 32 video draws in any second, with camera draws counted apart. In the fallback, no gap over 50 ms while playing.
  - Of the board's and the viewer's elements, at most one per window holds a `src`, and Konva is never handed an element whose `src` is cleared. The probe is tested apart, in firstFrame.test.ts: it clears its `src` and revokes its URL on success, on failure and at its 20 s timeout.
  - The step-down only goes down, never on a healthy run at any rate or refresh rate, variable rate and a 30 Hz render cap included, and never from a dropped window.
  - Draws follow media time: no two drawn frames less than 1/30 s minus 2 ms apart in media time, outside a wrap.
  - Liveness: while playing and shown, a new frame gets a draw within 100 ms.
- **First frame**: `firstFrame.test.ts`, with a fake video and canvas, covers play then pause, the three-way race, the WebP to JPEG fallback, the 20 s timeout, Low Power Mode's line and the shape rule from the server's facts. `upload.test.ts` covers the order, the percent and the delete after a later failure. A test of api.ts's progress path checks that it keeps the queue and `retryOn503`.
- **Smaller tests**: `settings.test.ts` (`parseAnimatedMaps`), display `remember.test.ts`, render tests for the Library and HandoutViewer, and the row's words.
- **Mutation check per lane.** Remove each of these and say which test fails: the visible set's video line, the phase projection's drop, the rules.ts carry, the active-phase schema rule, the shape check, the switch's refusals, the media-time gate, the wall-clock cap, the late-callback rule, the camera-draw skip, the pause on hide, the `src` clear, the cover, the step-down's one-way rule, an allowlist entry's zeroing, the padding's zeroing, the track-count refusal, the sliding frame count, the audio configuration's split, and the Range bounds.

**Integration** (`server/assets/animmap.itest.ts`) covers the switch on and off, upload by session slot, serving with ranges, players' 404s, the quota and its headroom for live uploads only, deletion, the backup round trip and the refill, and zeroed metadata in the served bytes. It also replays a stored op at the old version and then the new one, and measures the visible set under ops. scripts/backup-check.ts takes the backup script's new patterns.

**e2e:** `animmap.e2e.ts` runs steps `am-1` to `am-12` at the next free E2E_PORT offset (weather took +33, and +34 and +35 are free). The server's switch is on in every step but am-12.

- **Fixtures** go in `e2e/fixtures/`: `map-loop.webm` (VP9) and `map-loop.mp4` (H.264), each 640 × 360 and 2 s long. They are an ffmpeg test pattern made for these tests, under the project's license, with the commands in the folder's README as for the PDF fixtures. The e2e browser is Chrome (`channel: "chrome"`), which plays both.
- **Test hooks:** the board exposes `data-animmap` ("playing", "still low-power" and so on, set on change), an `animMapDraws` property that counts video draws only, and `animMapCameraDraws`.
- **Run with** `reach`, `maps`, `scenesetup`, `display`, `iso` and `mapdiscovery`, which together cover every reader of the map image.
- **Alignment:** the roots in e2e/alignmentRoom.ts gain the Map image group with a video, folded and open, the upload's steps, the still pick, This device's row, and the Library's video tile and viewer.

## 13. Lane plan

**AM-0, the contract (S), goes first**. It holds `MapVideo` in shared/model.ts, the caps in shared/limits.ts and the codes in shared/apiErrors.ts. It adds the `video` kind to all four declarations: shared/permissions.ts, server/assets/kinds.ts, client/lib/api.ts and persistence.ts `AssetFact`. It writes client/features/animmap/words.ts with every word in 4.2, 4.4 and 4.5, the playback reason type, and status.ts, the live status store with the decoder's ownership protocol (5.2). It adds `ANIMATED_MAPS` to server/config.ts and `animatedMaps` to `/api/config` (server/http/rooms.ts, client/lib/api.ts).

Then four lanes run at once, with disjoint files. They start after weather lands, and build on top of it.

- **AM-A, shared and room model (M):** shared/protocol.ts, shared/reducer/phases.ts, shared/project.ts, shared/permissions.ts (the rules), shared/referencedAssets.ts and shared/migrate.ts. server/rooms/actor.ts (`withAssetSizes`, `restoredAssetUsable` and the switch's permission dep), server/rooms/persistence.ts (`loadAssetFacts`), server/rooms/stateSchema.ts and server/rooms/remap.ts (`refillMapVideos`). Their tests.
- **AM-B, intake, storage and serving (L):** the new server/assets/video/ folder (webm.ts, mp4.ts, check.ts, window.ts, videoTestutil.ts and their tests). server/assets/kinds.ts, service.ts, store.ts, serve.ts, slots.ts, quota.ts (the headroom) and cleanup.ts, with their stale comments. server/http/assets.ts (the content-type scope), display.ts, security.ts and security.test.ts. server/rooms/exportRoom.ts and importRoom.ts (the derived CLI cap and the call to `refillMapVideos`). db/schema.sql. docker/backup.sh, scripts/backup-check.ts, and `ANIMATED_MAPS` in docker/server.env.example and docker-compose.server.yml's environment list, with selfhost/env.example and selfhost/compose.yml regenerated from them. server/assets/animmap.itest.ts, and e2e/fixtures/ with its README.
- **AM-C, playback on the board (L):** the new client/features/animmap/ files AnimMapController.tsx, playback.ts, capabilities.ts and stepDown.ts. client/canvas/layers/MapLayer.tsx (the video flag, the swap keep and the grid's cached path). client/canvas/Stage.tsx (the element's host and the cover). One line each in client/canvas/relief/IsoBoard.tsx (which passes no flag) and client/features/layers.ts. client/features/dm/PlayerPreview.tsx (the cover signal). client/features/device/settings.ts and ThisDevice.tsx. client/features/display/DisplayRoom.tsx and remember.ts. scripts/bench-animmap.ts. e2e/animmap.e2e.ts, with its room helpers and steps am-2 to am-8 and am-12.
- **AM-D, the DM's upload and Library (M):** the new client/features/animmap/ files firstFrame.ts, upload.ts and MapVideoRow.tsx. client/lib/api.ts (the XHR progress path). client/features/scenes/SceneSettings.tsx, NewScene.tsx and create.ts. client/features/phases/PhasesSection.tsx and rules.ts. client/features/images/LibraryGrid.tsx and library.ts. client/features/handouts/HandoutViewer.tsx and client/features/mapexport/MapExport.tsx. Steps am-1 and am-9 to am-11 in e2e/animmap.e2e.ts, added after AM-C's first commit of the file. The roots in e2e/alignmentRoom.ts.

**The docs commit** comes last, in AM-D:

- FEATURES.md: an "Animated maps" bullet after Map phases, Isometric's still, Export's still line, This device's row and Low power's line, the table display's menu, the Library line, the switch under Running the server, and the size note under Backups.
- docs/dm-guide.md: a short section in guide prose, with a screenshot.
- docs/self-hosting.md: "6. If you use Cloudflare", and the switch.
- docs/assurance-case.md: the upload claims, and the new decoder surface.
- docs/design/design.md: in 14.2, a playing animated map is the second loop at rest, after weather. Also the pinned CSP and the asset `Content-Type`.
- This note, and its line in docs/design/README.md.

## 14. Decisions

- **D-261102-440** A video map is a still plus a video on the same rectangle, and every reader of the map's pixels keeps the still. Rejected: the video as the map's only image (every reader rewritten, and no phone copy or thumbnail without a decoder).
- **D-261102-441** WebM (VP8, VP9, AV1) or MP4 (H.264, AV1), one file per map, solid SDR only, with no rotation or stretch in the file. One video track, at most one sound track (Opus, or AAC in MP4) and in MP4 at most one timecode track (D-261102-514). Rejected: WebM only (iPhones before iOS 17.4, and the makers' MP4s). Vorbis sound (its comment header is free text that cannot be cleared in place with certainty). Dropping extra tracks by zeroing their samples (writes at offsets the file gives). A WebM and an MP4 per map (two uploads, double the storage). HEVC (Chrome and Firefox play it only with hardware). See-through video (Safari draws VP9 alpha black). HDR (washed out in an sRGB canvas). Display geometry unlike the coded size (the phone cap would read the wrong size).
- **D-261102-442** No transcoder. A bounded header parser keeps an allowlist and zeroes the rest in place. Rejected: ffmpeg in the image (about 80 MB more, minutes of CPU for one 4K loop in the one-job queue, and the largest media parser there is). A parsing package (a new dependency for a few hundred lines). A denylist of known metadata (always one field behind). Renaming without zeroing (the payload survives). Keeping the file's own padding as it is (an editor may have blanked metadata there without erasing it). A remux (rewrites offsets, much more to get wrong).
- **D-261102-443** 64 MiB, 1 s to 10 min, at most 61 frames in any second counted over every frame, inside the quota with 32 MiB of headroom for live uploads, and D-261102-512's size cap. Rejected: the headroom on import too (a near-full room's backup would not import). A mean rate (hides a fast stretch). Images' 32 MiB (cuts most loops of a minute). 100 MiB or more (past Cloudflare's 100 MB request body and the 95 MB web import). A fixed 3840 × 2160 box (refuses square maps).
- **D-261102-444** No phone copy. Phone size plays up to 1920 × 1080 per axis (portrait swapped), at up to 30 fps, with power-efficient decoding only. Rejected: phones playing 4K (decoder memory and heat). Smooth alone (software AV1 answers smooth and drains the battery). A phone copy made on the DM's computer with WebCodecs (later, section 15).
- **D-261102-445** The DM's device makes the still from the first frame, or the DM picks an image within 1 px of the video's shape. Rejected: a server-made poster (needs a decoder). Always asking for a still (most DMs have only the video at hand). A 1% tolerance (up to 38 px of drift on a 3840 px map).
- **D-261102-446** Konva draws the `<video>` in the map layer, with the element kept in the page behind an opaque cover in the board's ground. Rejected: a DOM video under a transparent canvas (the camera kept in step every frame, and no Isometric). A layer of its own (the stage's five are used). The element behind the canvas with no cover (shows unfogged outside the scene). A detached or hidden element (Chrome pauses it).
- **D-261102-447** Isometric and the four setup tools show the still. Rejected: a moving isometric ground (every raised top recopied each frame).
- **D-261102-448** No sync across devices. Rejected: a start time in the scene so devices line up (seeks stall on phones, a loop has no story to keep in step, and nobody compares two screens' water).
- **D-261102-449** This device's Animated maps: Moving or Still, Moving by default, Still downloading nothing, and the same on the table display. Rejected: a row inside weather's (two looks, two reasons to turn one off). Still by default on phones (a DM buys these maps to see them move, and Phone size, the step-down and Low power guard a slow phone).
- **D-261102-450** Draw a presented frame when its media time is at least 1/30 s minus 2 ms past the last drawn one, or in the rAF fallback when 1/30 s minus 2 ms of wall time has passed, backed by a wall-clock cap that refuses while the oldest of the last 30 draws is under 950 ms old, so at most 32 in any second. Step down one way to Still on decoder drops or late callbacks (`presentedFrames` up by 3 or more), never on the file's rate. Rejected: a 30 ms clock gate (24 draws a second for a healthy 60 fps video at 144 Hz, and over 30 on some clocks). Every k-th frame by k = ceil(fps / 30) (draws 60 a second in a variable-rate file's fast stretch, and halves a 30 fps file whose rate rounds to 30.0000003). Presented frames counted against the video's rate (a healthy slow stretch reads as loss). Stepping back up (flicker).
- **D-261102-451** Audio stays in the file untouched and never plays, but it joins the playability check as its own audio configuration (D-261102-514). Rejected: both codecs in `video.contentType` (Media Capabilities takes one codec per track and rejects it). Dropping and zeroing the audio in place (writes inside the media data). Stripping it (a remux). Refusing files with sound (some packs carry it). Checking the video codec alone (an undecodable audio track fails the whole element).
- **D-261102-452** Each phase may be a video, and only the phase showing reaches players. The DM's device preloads other phases' stills only. Rejected: one video per scene (packs sell day and night loops). Preloading phase videos (up to 7 × 64 MB).
- **D-261102-453** The next free op and snapshot versions, as identity steps. Rejected: no bump (an older build fails on the field instead of refusing the room).
- **D-261102-454** Video files keep their real extensions, and cleanup, the BusyBox nightly backup, the restore and the embedded compose copy learn them. Rejected: naming them `.webp` so the scripts need no change (misleads every tool and every operator).
- **D-261102-455** When iOS Low Power Mode refuses autoplay, the still shows, and the next `pointerup` or `click` on the board tries again. Rejected: a Play button over the map (a new control on every board). `pointerdown` (grants no activation). Giving up for the session.
- **D-261102-456** The Library shows a video as a film-strip tile with its length. The handout viewer gains a video page that plays it under the device rule and frees the board's element meanwhile. Rejected: a thumbnail per video (the asset row holds no pairing to make one from). A second element beside the board's (two decoders).
- **D-261102-457** Range answers for videos, with a strong ETag, several ranges as 200 and the whole file, and each request checked like any asset request. Rejected: whole files only (Safari plays nothing). A cached visibility answer per session (a player could keep reading a video the DM took away).
- **D-261102-458** The upload order is first frame, video, still, then grid, and a later failure deletes the video this upload made. Rejected: the still first (a refused video leaves an unused image). Leaving a failed upload's 64 MB to the Library's Not in use alone.
- **D-261102-459** Export as image, thumbnails and Line up grid use the still. Rejected: a frame picker (a later nicety, and the first frame is what the grid search measured).
- **Coordinator's decisions:** D-261102-510, the server owner's switch, off by default, with Cloudflare's terms in docs/self-hosting.md. D-261102-511, a real upload percent through a progress-reporting path that keeps the queue and the 503 retry. D-261102-512, a size cap of about 8.3 megapixels with no side over 4096, with the phone rule kept per axis and portrait swapped. D-261102-514, the sound track untouched and checked as its own audio configuration, a sound track ending up to max(one video frame, 50 ms) from the video, and every track beyond one video, at most one sound and a timecode track refused, so the server never writes at the file's sample offsets.

## 15. Later

- A phone copy made on the DM's computer with WebCodecs, encoded to 1080p H.264 at 30 fps, so phones can play 4K packs.
- A moving isometric ground, and a frame picker for the still.
- **Open risks for the live play review on real phones:** whether the covered element plays on Android Chrome and iOS Safari, whether Low Power Mode's refusal and the tap retry work, and whether the step-down's counters read alike in Safari, Chrome and Firefox, Chrome's Energy Saver included. Also battery over an hour on a phone with weather on, and whether a phone without AV1 hardware shows the still.

## As built

Where the build went its own way, by part.

**The contract.**
- The versions are OP_VERSION 45 and SNAPSHOT_VERSION 35, after snap off's 44 and 34, both identity steps (9.4 says the next free ones).
- The decoder's ownership protocol is a lease in client/features/animmap/status.ts: a newer owner asks an older one to clear its `src` and let go, except that the board never takes the decoder from the Library viewer and waits for it to close.
- The Map image row and the viewer read the device's playback rule themselves (useVideoPlayback.ts), from the same live inputs the board's controller passes, and keep only the browser's answer per file. So a change of Low power, reduced motion, Animated maps or the server's answer judges again at once, and a viewer needs no board, as in a room with no scene showing (round 1 of the build review: AMBUILD-ASTRA-05, AM-R1-03).
- `ANIMATED_MAPS` takes `0` or `1`, and empty is off. Any other value stops the boot.

**The room model.**
- A video that is not a checked `video` row of the room is refused as `invalid` with "That video isn't in this room any more.", a word 9.2 did not have. The order is the still's own check, then the switch, then the row, then the shape.
- The asset row's `media` and `video` columns are read through `to_jsonb`, so the facts load the same before and after the columns exist. The refill also drops a video its still no longer fits, by the row's real size, and keeps the still as a plain map.
- `server/app.ts` passes the switch to the actor in one line.

**Intake, storage and serving.**
- Refusals answer 415 for `video_type`, 403 for `video_off` and 422 for the other codes of 4.5.
- The parser is stricter than section 10 in a few places: every MP4 sample must lie inside an `mdat`, an `av1C`'s config OBUs may be sequence headers only, the sound sample entry must be version 0, the VP9 level comes from the level table, and the timecode track's `gmhd` is renamed `free`.
- After round 1 of the build review, every value the check keeps is read and checked by its type and range whether or not anything uses it, and an element or box its parent may hold once is refused the second time (AMBUILD-ASTRA-02, AMBUILD-SOL-002, AMBUILD-SOL-006).
  - WebM: the EBML header's versions, the track flags (0 or 1), DefaultDuration, CodecDelay, SeekPreRoll, Colour's numbers (16 bits) and MasteringMetadata's (not negative) have ranges. The Audio's Channels must match OpusHead's. A SeekHead entry must point where its element starts. Each Cue must name a track the file has and a Cluster where one starts, a place and a block number inside it, and times inside the file's own. A block's reserved flag bits must be clear, and a BlockGroup holds at most two ReferenceBlocks, none farther than ten minutes. PrevSize is no longer kept: it only helps play backwards.
  - MP4: each FullBox's version and flags are checked. `ftyp`'s minor version and any compatible brand off a known list are zeroed. The reserved and predefined bytes of `mvhd`, `tkhd`, `hdlr`, `vmhd`, `smhd` and the sample entries are zeroed, where QuickTime names a vendor or a component. `mvhd`'s matrix must be the identity, and a sound or timecode track's `tkhd` gets the identity and no size. `mdhd`'s language becomes "und". A square `pasp` becomes 1:1, and `btrt` is no longer kept. An nclx `colr`'s code points and reserved bits are checked, and an avcC's parameter sets must be parameter sets. `stss`, `sdtp`, `sbgp`, `sgpd` and `cslg` are read whole against the track's samples, an `sgpd` of version 1 or later with its default and per-entry lengths (round 2: AMBUILD-SOL-008), and a sample group of a type other than `roll`, `prol`, `rap `, `sync` and `tele` is dropped with its mapping (AMBUILD-SOL-003). An AAC rate outside the table is `video_sound`, and the facts must be ones the protocol takes (AM-R1-05).
- The whole presentation timeline is checked, not the last Cluster's timestamp alone (AMBUILD-ASTRA-03, AMBUILD-SOL-005, AMBUILD-SOL-009). The tolerance is a frame or 50 ms, the larger, but never more than a second, whatever frame length the file claims. A timeline that runs past the ten minutes by more than that is `video_length`, whatever the durations say.
  - WebM: each frame ends at its own BlockDuration, else at the track's DefaultDuration, and a last frame with neither lasts the larger of the average gap and the gap before it. The frames' ends, invisible blocks and the sound's end must match the Duration: a timeline past it is `video_unfinished`, and one short of it `video_layout`. No block may be before the start. A Cue's time is a block's time, and its CueDuration must end by the timeline's end (AMBUILD-ASTRA-07).
  - MP4: each track's presentation runs from its first composition time to its last sample's end, less the edit's media time. With no edit list, the first composition time stands in for the media time, as long as it is at most a second (D-261102-732). So a B-frame file whose writer left out the edit, its first frame 66 ms in, plays as the media's own length. It must start at the start and end where the edit's segment, or the media's own length, does, or it is `video_layout`. A start more than a second in with no edit list is a gap at the start, and an edit list whose media time leaves a gap is one too. `mdhd`'s and `tkhd`'s durations must match each track's samples, a composition offset may move a frame by at most 16 of the track's most common sample duration and never before the start, and `cslg`'s numbers must lie inside the track's times.
- The check runs in a worker thread (D-261102-539), ended at its deadline if it fails to refuse on its own, so no upload stalls the event loop other rooms share. Its media-edit guard sweeps sorted ranges, its writes go out at most a window at a time, and the MP4 sample walk finds each sample's `mdat` by halving, all under the 5 s budget, so a file at every cap checks in well under it (AMBUILD-ASTRA-01, AMBUILD-SOL-001, AM-R1-01). A batch of writes ends wherever media data lies between two edits, and each write's own span is checked against the media data before it runs, so no write the check makes reaches it, not even to put its bytes back (round 2: AMBUILD-SOL-007). A disk's error reaches the route as one rather than as `bad_video` (AM-R1-06). The output bytes of files the old check accepted change only where the new rules zero more, and VIDEO_PIPELINE stays 1, since no stored video predates them.
- A live video's commit checks the quota and its headroom again, even at its reserved size, since uploads reserved after it and the room's own writes do not count its headroom (AMBUILD-SOL-004).
- A backup's manifest stays at version 2, with `media` on each video. An import entry over its kind's cap is skipped, and each stream is cut at its claimed size.
- ffmpeg is not used for the fixtures: `scripts/video-fixtures.ts` records a test pattern on an opaque canvas with Chrome's MediaRecorder and rebuilds it as a plain WebM and MP4 at exactly 30 frames a second. A transparent canvas records its alpha as BlockAdditions, which the check refuses.

**Playback on the board.**
- Isometric pauses the video and keeps its source, and draws start only once Konva holds the element, so the first draw is never a blank one.
- The step-down reads drops from the decoder's own frame counts and allows for a 30 Hz render cap one second at a time.
- The cover's ground is the board's ground in both themes (`BOARD_GROUND` in AnimMapController.tsx, the Room's `MAP_GROUND`), the one color the board draws for a video. Round 1 of the build review found it read the page's background token, which turns light with the page (AMBUILD-ASTRA-06, AM-R1-02).
- The board stops, clears its source, frees the decoder and clears its status when its controller unmounts while the Room stays, as a blackout does, and a disposed board stops hearing the page's step-down, so an ended View as a player is not kept alive (AMBUILD-ASTRA-04, AM-R1-04).
- View as a player covers the room through weather's existing cover count, so PlayerPreview.tsx did not change.
- The bench (`scripts/bench-animmap.ts`, 1080p 30 fps VP9 under heavy rain, 4 times slower, 390 × 844 at 3x) met every target of 6.1 on a desktop GPU: pans and drags within 0.1 ms of a still map, a draw at 0.2 ms median and 0.9 ms at the 95th percentile, at most 31 draws in any second, none hidden or Still, and the heap 2% up over 10 minutes. A phone's GPU and battery stay for the live play review.
- The board's test hooks speak in dashes, such as `still still-view`.

**The DM's upload and the Library.**
- The words of the upload's steps and the probe's fallbacks live beside the code that shows them, in client/features/animmap/upload.ts and firstFrame.ts, since words.ts was the contract.
- The Map image row and Add a phase show a Cancel while a video's steps run, since 4.1 says Cancel stops any step and neither had one during an upload.
- A still of the wrong shape keeps the uploaded video for the next pick, so it never goes up twice, and Cancel, another file or leaving the form deletes it when this upload made it. The shape is checked before the still goes up where the browser can decode it, and against the server's answer after.
- The probe is styled through its style object, never a style attribute, which the page's CSP refuses.
- The Library calls a video "Animated map", with its length in the tile's corner and a film strip drawn from the theme's tokens. Under Still with no scene naming the video, the viewer shows the strip with "Still on this device:" and the reason over the stage, so it reads at any zoom. The row and the viewer ask the device's rule once per video, and follow the board's live status when the board shows that video.
- The video help under the pickers sits after Use the still only in the Map image row.
- The alignment sweep runs with the switch on, and measures the Map image group folded and open, the row, an upload's step, the still pick, This device's row, and the Library's maps and viewer at both phones upright, the phone sideways, the tablet and the computer, at 100% and 130%.

## Design review

Six rounds of design review, by Claude and Codex reviewers, changed this note before the build, and every finding was adopted:
- Sections 7 and 10: an allowlist that zeroes everything else in place, the file's own padding and CRC-32 elements included, with no write inside the media data. Vorbis sound and every track beyond one video, one sound and an MP4 timecode track are refused, and `esds` is read only in a bounded subset.
- Section 10: the frame rate is the most frames in any one second, counted over every frame, and the sound may end at most max(one video frame, 50 ms) after the picture, in WebM and MP4 alike.
- Sections 5.2 and 5.4: the opaque cover, draws gated on the frame's media time with a wall-clock cap, so no two video draws are less than 1/30 s minus 2 ms apart, and a one-way step-down on decoder drops and late callbacks that never reads the file's rate.
- Sections 4.1 and 5.2: the first-frame probe in the form, the video uploaded before the still and checked against the server's facts, and one decoder per window, which the board and the Library viewer take in turn.
- Sections 6.3 and 9.3: quota headroom for live uploads only, an import that reserves each entry's checked size, and the BusyBox-safe nightly backup.
- Section 9.2: with the switch off, only an op that adds a video the room does not hold is refused, so undo and duplicate keep working.
