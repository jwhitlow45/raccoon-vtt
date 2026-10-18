# raccoon-vtt design: pasting images from the clipboard

Status: proposal. Section 10's questions go to the project owner, each with the answer this note recommends.

The project owner asked: "it would also be great if there was support from uploading media from the clipboard. (on both mobile and desktop). this way a battlemap, player icon, etc. can just be copied to clipboard without the user needing to save the file to disk"

Short answer: the token image picker already takes a paste (Ctrl+V, and "Paste from the clipboard" where the browser has `clipboard.read()`). Maps, map phases, handouts and stamps do not, and a phone whose browser refuses `clipboard.read()` has no way in at all. This note adds one paste layer at the point where each entry already receives a picked file, so a pasted image takes exactly the path a chosen file takes. No server route, protocol, op or snapshot changes.

## 1. Where paste works

### 1.1 Every entry that takes an image today

| Entry | Where | File input | What a picked file does | Kind |
| --- | --- | --- | --- | --- |
| Choose an image: a token's picture and other images, a character's portrait (new or existing), a companion, a group's image, a monster's token image | `client/features/images/ImagePicker.tsx:52`, opened from `client/features/images/ImageField.tsx:107` (`TokenPanel.tsx:294`, `CharacterCard.tsx:67`, `CharactersPanel.tsx:528`, `CompanionsSection.tsx:335`, `GroupMoreSheet.tsx:120`), `AltImages.tsx:61` and `MonsterImage.tsx:81` | `ImagePicker.tsx:285` (Device tab) | `uploadTokenImage` (shrunk to 1024 px, 10 MB cap), then the crop editor. Paste exists: `ImagePicker.tsx:142` (event) and `:260` (button) | `token` |
| New scene, Map image | `client/features/scenes/NewScene.tsx:278` | same | `pickFile` (`:180`) keeps it and starts the grid search, Upload and create sends it (`uploadMap`, full size, 32 MB) | `map` |
| A scene's Map image: add or replace | `client/features/scenes/SceneSettings.tsx:449` | same | `choose` (`:374`) uploads at once, searches the grid, and on the players' scene only after the DM has confirmed (`armed`, `:352`) | `map` |
| Add a phase | `client/features/phases/PhasesSection.tsx:259` | same | `add` (`:49`) uploads at once and names the phase from the file | `map` |
| Show a handout, Upload a file | `client/features/handouts/HandoutsSection.tsx:405` (`FileButton`, `client/features/dm/controls.tsx:155`) | same | `upload` (`:328`): a PDF goes to its page job, an image is shrunk to 2048 px and uploaded, titled from the file | `handout` |
| Stamps, This room's images | `client/features/builder/stamps/StampPicker.tsx:175` | none today | picks a room token image by id | `token` |

Entries that take a file but not an image, and stay as they are: a Universal VTT file (`client/features/uvtt/ImportDialog.tsx:522`, `.dd2vtt`, `.uvtt`, `.df2vtt`) and a room import (`client/features/settings/ImportRoomCard.tsx:85`, `.zip`). The Library panel adds nothing of its own (its pictures come from the picker), and scene thumbnails are made by the app.

### 1.2 The shared layer

There is no single uploader to route through: three upload functions (`uploadTokenImage`, `uploadMap`, the handout path) and five image file inputs. What every entry has is one handler that receives a `File`. Paste joins there, so each entry keeps its own role rule, quota, size cap, downscale, grid search, PDF path and busy and error states, and nothing new reaches the server.

- **`client/features/images/paste.ts`**, pure and unit tested: `clipboardImage(source, accepts)` picks the image out of a paste event's `DataTransfer` or out of `clipboard.read()`'s items and says why when there is none. `pastedFile(blob, name, now)` names it. `pasteError(reason, accepts)` gives the words.
- **`client/features/images/PasteImage.tsx`**: `PasteButton` (the visible control, section 2.2), `PasteBox` (the fallback, section 3.3) and `usePasteTarget(ref, target)`, which registers an entry with the room's paste router.
- **The router**, one `paste` listener per Room page beside `useShortcuts` (`client/pages/Room.tsx:343`), so exactly one entry takes a paste even with two panels open. It listens on `document` in the bubble phase, so the paste box's and React's own handlers run first and a paste they cancel stays theirs. A "view as a player" preview's page mounts it switched off, as its shortcuts are.

A target declares what it accepts (`image`, `image-or-link` for Choose an image, `image-or-pdf` for handouts), when it takes a key paste (`open` or `focus`, below), `disabled` by the same rule as its file control (busy uploading or finding a grid, or its own `read()` pending), and its `onFile`, the handler its file input already calls. The handlers lean on their disabled inputs today: a second `pickFile` during an upload clears New scene's busy state, and a second `choose` or `add` starts a competing upload.

| Entry | `onFile` | Takes Ctrl+V |
| --- | --- | --- |
| Choose an image | `upload` (link: `importUrl`, as today) | while open |
| Stamps | new: `uploadTokenImage`, then the image becomes the chosen stamp (`libraryFootprint`) | while open |
| New scene, Map image | `pickFile` | while the Map image form is open |
| Show a handout | `upload` | while the form is open with nothing picked |
| A scene's Map image | `choose` | only with focus in its row, and on the players' scene only while also confirmed (`armed`) |
| Add a phase | `add` | only with focus in its row |

The two scene settings rows take a key paste only with focus because they are always on screen while the Scenes panel shows, and `choose` uploads and sends `scene.setMap` with no further step. Otherwise a Ctrl+V meant for the room would replace a map, on the players' scene the live one. Confirming already moves focus into the row (`SceneSettings.tsx:364`), so the rule costs nothing. Their Paste button works whenever their file control does.

### 1.3 Which entry takes a key paste

The router's choice is a pure function (`pasteTarget`), tested without a DOM. Only a target whose element is shown counts (`el.checkVisibility()`, or `el.getClientRects().length > 0` where it is missing, as in Safari before 17.4, since a closed sheet hides through `dialog[data-rvtt-sheet]:not([open])` with no `[hidden]` to find). Each target registers its ref on an element with a box of its own, never one with `display: contents`. The side panel, a split's second pane and a phone's panel sheet stay mounted while hidden (`Room.tsx:983`, `:2201`, `:402`), and a form left open there must never take a paste out of sight.

1. Nothing, if the event was already handled (`defaultPrevented`), or on a preview page.
2. If a modal dialog is open (`[aria-modal="true"]`), only a target inside the newest one. None there: nothing happens, so a paste never reaches the room behind a dialog.
3. Otherwise the target whose element holds the focus, then the newest open target.
4. Otherwise the room-level offer (section 4), for the DM only.

**A disabled target still wins.** A chosen target that is disabled takes the paste and does nothing, and the paste never passes to another target or to the room offer. So a second Ctrl+V during an upload or a pending `read()` is ignored. The paste box keeps its entry's rule, and a busy entry's row in the room sheet is disabled.

**Text fields.** The test is `isTextField` (`client/state/shortcuts.ts:67`), which covers inputs, text areas, selects and editable content. A paste into a text field stays the field's whenever the clipboard holds text. When it holds only an image (a file and no `text/plain`), which a plain field cannot take, the target around the field takes it. So an image pasted while the scene's name or the picker's search box has focus still lands. The room-level offer never fires from a text field.

## 2. Desktop

### 2.1 The key

Ctrl+V or Cmd+V, and the browser's own Paste in the Edit menu or a right-click menu, all fire the `paste` event, which carries the clipboard in `clipboardData`. Reading it needs no permission and shows no prompt. The spec fires it at the focused element, or the body when nothing has focus, and it bubbles to the document. Chrome and Firefox do so with focus on a button or the page, and the probe (section 8.3) saw it in Chrome with the image as one `File` named `image.png`.

**Safari is the exception to check.** WebKit long fired no paste event without an editable element focused (WebKit bug 75891). A 2025 change on WebKit's main branch targets the focused element as the spec says, and the bug was called fixed in 2026, but which Safari release ships it is not confirmed. Where Safari drops the key paste, the Paste button works, since it reads through `clipboard.read()`. The build tries one cheap remedy and keeps it only if the hand check shows it works: WebKit's source enables Paste on a page whose `beforepaste` handler cancels the event, so the router cancels `beforepaste` while an open target is registered.

### 2.2 The Paste control

A secondary button, **Paste an image**, beside each entry's file control (Choose an image keeps its full-width "Paste from the clipboard" on the Device tab). It calls `navigator.clipboard.read()` synchronously in its click handler, with no `await` before it (no `permissions.query` first), so Safari's and Firefox's activation holds, and passes the first image to `onFile`. It shows busy while the browser answers, which can include a permission prompt, and refuses a second press meanwhile. Where `clipboard.read()` is missing, or the browser refuses it, the button opens the paste box (section 3.3) with the words for the refusal.

The button shows wherever its entry's file control shows, with the same disabled rule. On the players' scene it appears only once the DM has confirmed, beside "Choose the image", under the warning.

### 2.3 What the clipboard holds

| Clipboard | Paste event | Paste button |
| --- | --- | --- |
| No image (text, nothing) | Nothing happens in a field. Elsewhere in a target: "The clipboard has no image in it. Copy an image first, such as with Copy image on a web page." The room-level offer stays silent | the same words |
| Several images | The first is used, with a note under the entry: "The clipboard held 3 images. The first one was used." | the same. Chrome's `read()` returns one item, Safari's may return several |
| A file copied in the file manager | The paste event holds the file itself, with its own name, in `clipboardData.files`: Chrome and Edge 91 on, Firefox 116 on (the first file only), Safari 11.1 on, never on Android. It takes the entry's path: an image as any image, a PDF in Show a handout as a PDF, anything else "That file is not an image." A real name keeps its powers: `crypt_30x20.png` still sets the scale | `read()` returns no file in any browser, and on a Mac it may return a Finder file's icon as a picture, which then uploads as the image. No guess tells an icon from a real picture, so none is made: Ctrl+V carries the real file. The picture shows once uploaded, in the crop editor, the handout's thumbnail or the scene, and is replaced as today. The Mac hand check confirms the icon case |
| Text that is an image link | Choose an image imports an https link, as today, through the server's existing import (design 10.6). Everywhere else: "That is a link, not an image. Copy the image itself, or save it and choose the file." | the same |
| HTML with an `<img>`, from copying part of a page | Only the image bytes count. With bytes ("Copy image" puts both), the bytes are used and the HTML is ignored. Without: "That copied part of a page, not the image. Use Copy image on the image instead." | the same |
| SVG | Never read, as today: "SVG images are not supported. Use a JPEG, PNG, WebP, GIF or AVIF image." | `image/svg+xml` items are skipped |

**Links are not widened.** A link import is a fetch by the server, through the egress proxy's public port, which denies private and reserved ranges, takes https on 443 only, re-checks each redirect and caps the body at 10 MiB (design 10.6). That holds for any kind the route is asked for, so the risk would not grow. The case against is the gain: "Copy image" hands over the bytes the browser already holds, which needs no outbound fetch, spends no import budget and keeps the map's 32 MB cap and its grid search on the device. A map fetched by link would be held to 10 MiB and searched only on the server's copy. So in this change a link imports only where it does today, and the `<img src>` of copied HTML is never fetched (question 3).

## 3. Mobile

### 3.1 What browsers do today

| Browser | `clipboard.read()` | A paste event |
| --- | --- | --- |
| iOS Safari 13.4 on, and every iOS browser outside the EU, which all run WebKit | Needs the tap's activation, else `NotAllowedError` at once. Then shows the system's one-item Paste callout by the tap, unless the clipboard came from this site. A tap elsewhere, a tab switch or leaving Safari rejects with `NotAllowedError`. Gives only `text/plain`, `text/html`, `text/uri-list` and `image/png`, so an item held only as JPEG or HEIC reads as no image. Several items per read | Only into an editable element, after a long-press, Paste. A text input offers Paste only for text or a link. A `contenteditable` element offers it for images too. Gives PNG, JPEG and GIF as files (`image.png`, `image.jpeg`), never HEIC or TIFF |
| Android Chrome | Needs the page focused and the `clipboard-read` permission: the first read asks ("Clipboard" in the site settings), a denial rejects with `NotAllowedError` ("Read permission denied."), and a page can ask the state first (`navigator.permissions.query`). Any image on the clipboard comes back as one `image/png`. Android 12 on shows its own "pasted from your clipboard" note | Only into an editable element, which offers Paste for any clip, images included. The image arrives as a file, `image/png`, `image.png`, even into a plain text input |
| Desktop Chrome and Edge 76 on | As on Android, with the permission prompt the first time. One item per read | Fires on the focused element or the body, so a key paste works with nothing editable |
| Firefox 127 on | Needs activation, then shows a one-item Paste menu, enabled after a second, unless the clipboard came from this site. Dismissed: `NotAllowedError`. No permission to ask. `text/plain`, `text/html`, `image/png` | As Chrome on a computer |
| Desktop Safari 13.1 on | As iOS, with Paste as a menu item | Section 2.1: not confirmed without an editable element |

`read()` gives pictures as PNG: Chrome's Copy image writes a bitmap, and MDN's `read()` page shows a copied JPEG reading back as PNG in its example. WebKit's paste event can pass a JPEG file as it is. Sources: MDN's [Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API), [Clipboard.read()](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/read) and [paste event](https://developer.mozilla.org/en-US/docs/Web/API/Element/paste_event), [caniuse](https://caniuse.com/mdn-api_clipboard_read), WebKit's [Async Clipboard API](https://webkit.org/blog/10855/async-clipboard-api/) and [Clipboard API improvements](https://webkit.org/blog/8170/clipboard-api-improvements/), [WebKit bug 75891](https://bugs.webkit.org/show_bug.cgi?id=75891), web.dev's [Async Clipboard](https://web.dev/articles/async-clipboard), [Chrome's file paste](https://chromestatus.com/feature/5671807392677888), [Firefox 116's notes](https://www.firefox.com/en-US/firefox/116.0/releasenotes/), [Firefox 127's notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/127), [Android 12's clipboard note](https://developer.android.com/about/versions/12/behavior-changes-all) and the [Clipboard API spec](https://w3c.github.io/clipboard-apis/). Where the docs are silent (iOS text inputs, Android's file names), the facts come from WebKit's and Chromium's source.

### 3.2 The control on a phone

**Paste an image** is the same button. It calls `clipboard.read()` straight from the tap, which is the gesture both browsers need. On iOS the system's own Paste callout appears by the button and the read waits for its tap. On Android the first press may bring Chrome's permission prompt. The button shows busy until either answers.

On iOS a `read()` that finds no image also opens the paste box, with "If you copied a picture, press and hold in the box, then tap Paste." A photo the clipboard holds only as JPEG reaches the page that way, as a file. One held only as HEIC does not, since WebKit hands no HEIC file to the page: it gets the no-image words, and the file control is its way in. The hand check (section 8.3) tells which a photo copied from Photos is. If a Photos copy always needs the box, iOS opens the box first and skips `read()`.

### 3.3 The fallback: the paste box

When `read()` is missing or refused (a dismissed iOS callout, a blocked Android permission, an older browser), the button opens a paste box under it: a 44 px field drawn as an input, `contenteditable="true"` so the system's long-press menu offers Paste (never `plaintext-only`, which iOS does not treat as rich and offers no image Paste for), `role="textbox"` with an `aria-label`, and `inputmode="none"` so no keyboard opens, and the line "Press and hold here, then tap Paste." (With a mouse: "Press Ctrl+V, or right-click here and choose Paste.") Its own `paste` handler takes the image through the same `clipboardImage`, cancels the event so nothing is inserted, and refuses typing and drops. It closes on a successful paste, on Cancel, and with its entry.

The box is the floor every browser meets: a paste event into an editable element needs no permission, and both phone browsers offer Paste there for an image. It must be `contenteditable`, not an input: iOS offers no Paste in a text input when the clipboard holds only a picture. The refusal's words sit above it: "The browser did not let the app read the clipboard. Press and hold in the box, then tap Paste." So a PNG, JPEG or GIF still reaches the page on a phone when `read()` fails, and the file control beside it works as before.

No key paste and no room-level offer on a phone: nothing there types Ctrl+V. A phone with a keyboard attached gets the desktop behavior through the same event.

## 4. Pasting with nothing open (desktop)

**Recommended: yes, for the DM.** A desktop DM's commonest paste is a map or a creature picture copied from a web page, and today that is five steps through the Scenes panel or the token panel. With the offer it is Ctrl+V over the map and one choice. The rules:

- **The DM's alone.** A player's one kind is a token image, and its natural place, their character's picture, is a tap away in the picker, where paste already works (question 1).
- **Only an image fires it.** It runs only when the router found no target (1.3), focus is not in a text field, no dialog is open, and the paste holds an image. Text, a link or a copied part of a page does nothing at all, so pasting into the wrong window never nags.
- **A choice before anything uploads.** A small sheet, **Use the pasted image** (the one Dialog, a bottom sheet on a narrow window), shows the picture (a local object URL, freed on close) with its name and size in px, and up to four rows, each a 44 px button with a line of help:
  - **New scene**: "Make a scene with it as the map." Disabled at the 50-scene limit, saying so.
  - **Picture for Goblin 2**: shown when exactly one token is selected.
  - **Stamp**: "Then tap the map to place it."
  - **Handout**: "Then choose who sees it."
- **The likeliest row first.** Stamp with the Build tool's Stamp mode on, the token's picture with one token selected, else New scene.
- **The sheet uploads nothing itself.** Each row hands the file to its entry (a one-item handoff slot in the room scope) and opens it, and the entry runs its `onFile` as if the DM had pasted there: New scene opens with Map image chosen and the image picked (the grid search starts at once), the DM panel's Show a handout opens and uploads it (on a form that already holds a pick, it replaces the picked image as choosing another file does today: `withPick` keeps a typed title and the audience, and replaces a title the last pick filled in), the Build tool's stamp picker opens and uploads it. The token's picture uploads through `uploadTokenImage` and opens the crop editor in the token's shape, then sends the token panel's own image patch. So every rule, busy state and error stays the entry's.
- **New token is left out.** Placing a blank token and pasting with it selected covers it in two steps, and a new token from a picture needs the kind and size the Add token tool asks for (question 2).

## 5. What the user sees

- **The name.** The file's own name when the clipboard has one. A browser's stand-in (`image.png`, `blob`, `Pasted Graphic.png` and the like) or a nameless `read()` blob counts as none, and the image becomes `Pasted image 2:32 PM.png`, the extension from its type and the time in the device's own format. A scene, a phase and a handout take their names from it as from a file ("Pasted image 2:32 PM"), and New scene's picker shows it where it shows a file's name.
- **The preview.** As today, after the upload: the crop editor (`ImagePicker.tsx:119` uploads first) and the handout form's thumbnail (`HandoutsSection.tsx:306` likewise), where a wrong picture is replaced as today. No new preview or confirm step: a paste stays one action. New scene, the map rows and the phases show the name, as for a file. Only the room-level sheet shows the picture first, since it asks what the picture is for.
- **Loading.** Every slow step is the entry's own, behind the shared delayed indicator: "Uploading…", "Waiting for the server…", "Looking for a grid…", "Preparing the image…". Reading the clipboard is the Paste button's busy state. Decoding the sheet's preview shows "Loading the picture…" after 200 ms. A failed step ends in words, never a spinner left turning.
- **Errors**, in plain words, each under its entry:
  - Refused: "The browser did not let the app read the clipboard." and the paste box's line.
  - Empty: section 2.3's "The clipboard has no image in it…".
  - A format the upload does not take (HEIC, TIFF or BMP copied as a file, where the browser cannot redraw it): the one string the server's 415 already shows (`uploadErrorText`, `client/features/scenes/upload.ts:24`), "That file is not an image the server accepts. Use JPEG, PNG, WebP, GIF or AVIF.", reused by `pasteError`.
  - Too large: the entry's own cap. Token and handout images are shrunk first, so a pasted screenshot fits. A map: "That image is too large. Maps can be up to 32 MB." checked in `uploadMap` against `MAX_MAP_UPLOAD_BYTES` (`client/features/uvtt/limits.ts`, 32 MiB as `server/assets/kinds.ts` has it) before a byte goes up. Today it waits for the server's 413. The Universal VTT import's own `uploadMap` call (`ImportDialog.tsx:177`) gets the check too, which is harmless.
- **Formats:** JPEG, PNG, WebP, GIF and AVIF, as today. Most pasted pictures arrive as PNG (Chrome's always, and the probe's came back re-encoded), an animated GIF as its first frame.

**A large PNG screenshot.** Token images and handouts go through `prepareImageUpload`: drawn down to 1024 or 2048 px and re-encoded, so a 4K screenshot of 10 to 20 MB uploads as a few hundred KB. A map goes up at full size, untouched, as design 11.1 decided, so a pasted map costs its PNG size. The probe measured the starter cavern, a painted 2000 px map: 0.19 MB as shipped, 0.45 MB as JPEG, 3.75 MB as the PNG a paste hands over. A painted map of 4096 px comes to about 15 MB as PNG, under the cap but slow on a phone's link, and one of 6000 px or more passes 32 MB and is refused. Line art barely grows (a Dyson map, 3413 by 4096: 0.38 MB as PNG).

So a **pasted map over 8 MB is re-encoded on a computer** before it uploads. The paste path calls `uploadMap(roomId, file, { pasted: true })`, since after `pastedFile` the name alone no longer says so, and "a computer" is `thisDevice()`. It is drawn at its own size, at most 8192 px on the long side (the server's `full` variant, so nothing it would keep is lost), as WebP at quality 0.92, and kept only when `encoded.type === "image/webp"` (Safari's `toBlob` can hand back PNG) and it is smaller (`smaller()`). The server re-encodes every map as WebP at quality 82 anyway. A phone uploads the original. The grid search reads the pasted file as before, at the same size (question 4).

## 6. Keys and docs

- **The shortcut sheet** (`client/state/shortcuts.ts`): the surface "Choose an image" becomes "Adding an image", with an intro naming where a key paste works ("Choose an image, the stamp picker, New scene's Map image, Show a handout, and a scene's Map image or Add a phase with focus there. In a text field, only a copied image with no text."). Its row `pickerPaste` keeps its id: "Ctrl+V (Cmd+V on a Mac)", "Paste a copied image there. Choose an image also takes an https link", everyone. A new room row `roomPaste` in Keys, DM only: "Ctrl+V (Cmd+V on a Mac)", "Use a copied image as a new scene, the selected token's picture, a stamp or a handout", "with nothing open that takes it".
- **FEATURES.md** in the same commit as those rows, the lane's last (`shortcuts.test.ts` checks the two tables word for word, so the rows and the tables move together), and the Images and art line becomes "Pasting a copied image works there too, and in New scene's Map image, a scene's Map image and phases, Show a handout and the stamp picker. On a computer, the DM can paste over the map and choose what it is for."
- **Paste is fixed, never rebound.** The app listens for the `paste` event, never for the key: the event fires from the system's paste however it was asked for (the key, the Edit menu, a right-click, a phone's menu), and it needs no permission. A moved key would have to call `clipboard.read()` on a keydown, which prompts in Chrome and shows a callout in Safari for something the system already does. Rows with Ctrl or Cmd are not rebindable today either.
- **The DM guide** gets a short section, "Pasting a picture", after Starter art, in the Contents:

> You don't need to save a picture to your computer before you use it. Copy it (on a web page, right-click it and choose **Copy image**, or press and hold it on a phone), then paste it wherever the app asks for an image: in the image picker, in **New scene**, a scene's **Map image** and phases, **Show a handout** and the stamp picker. Press Ctrl+V (Cmd+V on a Mac), or press **Paste an image**. A phone may ask your permission the first time, or show its own small **Paste** button for you to tap. If it won't let the app read the clipboard, press and hold in the box that appears and tap **Paste** there. On a computer you can also just press Ctrl+V over the map, and the app asks what the picture is for: a new scene, the selected token's picture, a stamp or a handout.

## 7. Security and privacy

- **Read only on a gesture.** `clipboard.read()` is called only inside the Paste button's click handler. The paste event is the user's own paste. Nothing reads the clipboard on a timer, on page load, on focus or on opening an entry, and no code calls `readText()` (the picker's button calls it today, and moves to `read()`'s `text/plain`).
- **Nothing kept or sent but the chosen image.** Text and HTML on the clipboard are read only to classify the paste and are dropped: never stored, logged or sent. HTML is classified by a pattern on the markup string alone, never put into a document and never left to `DOMParser` alone, so no `<img src>` in it loads and no handler in it runs. The one exception is today's: an https link pasted into Choose an image goes to the import route, which the user meant. The sheet's preview is a local object URL, freed when it closes. A refused or ignored paste leaves nothing behind.
- **No new way in for a player.** Every paste lands in an entry the role can already open, through that entry's own upload with its kind, and the server's rules are unchanged (`map`, `handout` and `thumb` stay DM kinds). The stamp picker, New scene, the scene settings and the handout form are the DM's. The room-level offer is the DM's alone, and in a preview it is off. The page's headers need nothing: a `Permissions-Policy` that leaves out `clipboard-read` keeps the page allowed (only `clipboard-read=()` would block `read()`, even at the top level, so the header must never gain it), and the CSP already allows `blob:` images.

## 8. Tests

### 8.1 Unit

- `paste.test.ts`: the first image file of several, with the count of the rest. Files before items, items' `getAsFile` when `files` is empty. SVG skipped, and an SVG-only paste refused with its own words. A PDF taken only by `image-or-pdf`. An https link taken only by `image-or-link`, http refused. HTML with an `<img>` and no bytes refused, HTML beside bytes ignored. Text only, and nothing at all. `read()` items: PNG chosen over other types, SVG never, an empty list. The stand-in names, and real names kept (`crypt_30x20.png` keeps its size). The 8 MB re-encode rule's choice.
- `pasteTarget`: a target inside the newest modal and none outside it, focus before open, the newest open target, a preview, a handled event, and the text field rule both ways. A disabled target taking a repeated paste during an upload and during a pending `read()`, with nothing passed on. A target inside `[hidden]` never chosen, nor one inside a closed, mounted sheet with `checkVisibility` unavailable (the `getClientRects` fallback). A confirmed Map image row with focus elsewhere and the players' scene's unconfirmed row with focus in it both getting nothing.
- The room-level rows by role, scene count, selection and Stamp mode, and their order.

### 8.2 End to end

A new `e2e/paste.e2e.ts`, steps labeled `pa-1` on, with the DM at 1280 by 800 and a player at 390 by 844 (`isMobile`, `hasTouch`), as `maps.e2e.ts` sets them up:

1. `pa-1` The DM pastes into New scene's Map image by a synthetic `ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true })`, as every synthetic paste here is, with a `DataTransfer` holding a code-drawn gridded PNG named `image.png`. The picker shows "Pasted image …", Upload and create makes the scene, its grid is found, and a second paste during the upload changes nothing.
2. `pa-2` The DM pastes into Show a handout, the stamp picker and Add a phase, each by the same event, with focus first moved into the Add a phase row.
3. `pa-3` The DM, with the context granted `clipboard-read` and `clipboard-write`, seeds the clipboard with `navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])` and presses Paste an image in a scene's Map image row. On the players' scene the button shows only after the confirm.
4. `pa-4` Room-level: a key paste over the map opens Use the pasted image, Handout opens the form with the image picked, and with a token selected its row is first and sets its picture after the crop.
5. `pa-5` The player, granted, presses Paste from the clipboard in their character's picker and reaches the crop editor.
6. `pa-6` The player in a context with no permission: the press is refused, the paste box shows with its words, and a synthetic paste on the box uploads exactly once: the box cancels it, and the router passes it on to nothing.
7. `pa-7` The player's key paste over the map opens nothing, and a text-only paste into a picker shows the no-image words.
8. `pa-8` A counter on `navigator.clipboard.read` (`addInitScript`) stays at 0 through load, opening every entry and switching tabs, and is 1 after one press.

### 8.3 What the probe found

A script outside the repository drove headless Chrome (the e2e browser) on desktop and phone viewports. A synthetic `ClipboardEvent` with a `DataTransfer` reaches a document listener with its file and text, so `pa-1` works as written. With the permission granted, `clipboard.write` then `read()` returns `image/png` on both viewports. Without it, `read()` from a click rejects at once with `NotAllowedError` ("Read permission denied."), which is `pa-6`'s case. A real key paste of that clipboard, on the page and in an editable box, gave one `File`, `image.png`, re-encoded (237 bytes for a 203 byte original).

Headless Chrome keeps a clipboard of its own in memory, and whether contexts share it is not confirmed, so the `pa` steps run one after another in their one file.

The e2e runs Chrome only. The rest is a hand check in the live play review, each a line of the build's report:

- iOS Safari: Paste an image with its callout, a dismissed callout (the box opens), a photo copied from Photos and a picture copied from a web page, both through the button and through the box.
- Android Chrome: the first press's prompt, a denial (the box opens), the box's paste.
- Safari on a Mac: Cmd+V in an open picker with focus on a tab, with and without the `beforepaste` remedy (section 2.1).
- On a Mac: a file copied in Finder, and a picture copied in Photos or Preview, each by Cmd+V and by the button.

## 9. Build plan

One lane, five commits:

1. `feat(images): pick a pasted image from the clipboard` (`client/features/images/paste.ts` and its test): the pure part.
2. `feat(images): paste into every image entry` (`PasteImage.tsx`, the router and its test, `client/pages/Room.tsx` one line, `ImagePicker.tsx` moved onto the router with the paste box, `NewScene.tsx`, `SceneSettings.tsx`, `PhasesSection.tsx`, `HandoutsSection.tsx`, `StampPicker.tsx`, `client/features/scenes/upload.ts` with the size check and the pasted map re-encode, `client/features/images/sizing.ts` for its rule).
3. `feat(room): offer a pasted image as a scene, a token picture, a stamp or a handout` (the sheet, the handoff slot, the four entries reading it). A commit of its own, so it can be left out without touching the rest. Leaving it out also takes `pa-4` out of commit 4, and the `roomPaste` row and its FEATURES.md line out of commit 5.
4. `test(e2e): paste into the image entries` (`e2e/paste.e2e.ts`).
5. `feat(shortcuts): list pasting in the shortcut sheet, features and the dm guide` (`client/state/shortcuts.ts` rows and its test, `e2e/shortcuts.e2e.ts` for the renamed heading, FEATURES.md, the DM guide with its picture). Last, as the lane rules ask of FEATURES.md and the guide, and one commit, since `shortcuts.test.ts` holds the registry and FEATURES.md's tables to each other.

During the build, run `paste`, `shortcuts`, `maps` and `reach`.

About 600 lines of code and tests: one build lane and one review round.

## 10. Questions for the project owner

1. **Should a player get the room-level offer too?** Recommended: no. A player's only kind is a token image, and their character's picture is a tap away in the picker, where paste works. If yes, the offer would hold one row, "Picture for <character>", for each character they own.
2. **Should the room-level offer include New token?** Recommended: no, in this change. A blank token then a paste with it selected covers it in two steps, and the Add token tool asks the kind and size a new token needs.
3. **Should a pasted link import a map, a handout or a stamp, or a copied page's `<img>` be fetched?** Recommended: no. Copy image hands over the bytes, which needs no fetch by the server, and a map fetched by link would be held to 10 MiB and searched only on the server's copy. Links stay where they work today, in Choose an image.
4. **Should a pasted map over 8 MB be re-encoded as WebP at its own size before upload?** Recommended: yes, on a computer. It keeps every pixel the server keeps, the server re-encodes at quality 82 anyway, and a painted 4096 px map goes up as a few MB instead of about 15.
