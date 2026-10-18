# raccoon-vtt design: starter packs for DMs

Status: draft 2, with the packs decided (section 12) and built. Sections 1, 3, 7, 8 and 10 describe the build. The project owner reviews the built packs in the app.

The project owner asked: "please also add some open source art that can be selected from to help DMs get started. group the art into categories and organize it. just overall i want to make things as easy as possible for dms. you must be 100% positive that the art is open source and abide strictly by licenses as we have so far."

After draft 1's contact sheets (single museum works), the owner set the direction: "I was really hoping for you to find like packs of art and battle maps for D&D, if that makes sense? That way there was at least some coherency. Also, I just want to be sure that this art isn't going to clog up the DMs' management of their own battle maps they have uploaded. All of this should be its own selector in the relative places that art is picked from". On AI: "do still abide by licensing though and just look for telltale signs of AI generated art. I'm gonna review it anyway".

## 1. Summary of the decisions

1. **Starter art ships as packs**: sets from one artist or project in one style, made for tabletop fantasy. 14 packs of 501 works (section 3), decided in section 12.
2. **Battle maps:** Dyson Logos's hand-inked maps are the heart of it, 29 picked from the 276 posts that carry CC BY 4.0. Beside them: the Scarlet Heroes maps, Majcher Arcana's index card dungeons and Ferrin's painted cavern. No color battle map pack passes: of 711 itch.io map pages read, none of the 145 free battle maps carries an allowed license.
3. **Tokens and portraits:** Oozejar's Illustrated Bestiary (60 monsters in color), Justin Nichol's cute heroes and monsters, Dungeon Crawl Stone Soup's monster tiles, and three portrait packs for NPCs.
4. **Builder stamps:** the rest of the Warlock's Gauntlet top-down packs (40 props in the shipped look), 41 Poly Haven models rendered from above, and Mark Gosbell's 50 flat greyscale props.
5. **The museum pictures stay as one optional pack, Historical art**, trimmed from 134 to 47: no D&D pack offers letters, old maps, treasure or scene paintings for handouts.
6. **Every SRD monster gets a default token** from the shipped game-icons.net icons, as draft 1 planned.
7. **Starter art is its own selector.** A Starter tab, by pack then category, in each place art is picked: the token image picker, New scene, Handouts, and the builder's stamps. It never shows in, or counts against, the room's library until the DM picks a work.
8. **A pick copies the work into the room** as an ordinary asset with its credit, marked as starter art, outside the room's storage quota and grouped apart in the library. Stamps stay a reference to the bundled file, as the 46 shipped stamps are.
9. **32.7 MB** in `public/starter` (679 files, thumbnails included) and 0.96 MiB of new stamps, under the 40 MB budget (section 10).

## 2. What changed from draft 1

- **Packs, not single works.** Draft 1 chose museum works for their certainty. The owner wants coherent sets a DM recognizes as D&D art.
- **AI checks are best effort.** The pre-2022 date rule and the Wayback snapshot per file are gone. A pack is rejected for an explicit AI label or for visible signs (warped grids or text, melted details, malformed hands, lighting or style that disagrees within a pack). Each pack's license page has one Wayback snapshot. Three recent packs (Bestiary, Lemurs, Index Card Dungeons) state "No generative AI was used" on their itch.io pages.
- **Licenses stay strict:** CC0, a public domain dedication or mark from the rights holder or institution, CC BY 3.0 or 4.0, CC BY-SA 3.0 or 4.0, stated by the rights holder for the pack (the artist, the studio, or a project lead who plainly speaks for the artists). Never NC, ND, custom terms, personal-use terms, or a paid pack. A pack whose page and license file disagree is out.
- **A rights holder's public domain dedication counts**, so the Scarlet Heroes maps pass.

## 3. The packs

Sizes are as the build encoded them (section 8), thumbnails apart. Draft 2 also weighed Kenney's sample maps and Sine Nomine's Spears of the Dawn maps and figures, and held four packs for the owner. Section 12 settled them all: those three sets are left out, and the held packs that are in appear below.

| Pack | Author | License | For | Works | MB |
| --- | --- | --- | --- | --- | --- |
| Dyson Logos maps | Dyson Logos | CC BY 4.0, on each map's post | Maps | 29 | 7.9 |
| Scarlet Heroes maps | Dyson Logos, released by Kevin Crawford (Sine Nomine) | Public domain dedication | Maps | 5 | 0.6 |
| Index Card Dungeons | Majcher Arcana (Marc Majcher) | CC BY 4.0 | Maps | 10 | 0.8 |
| Cavern Battlemap | Ferrin | CC0 | Maps | 1 | 0.2 |
| Illustrated Bestiary | Oozejar (Gourdin Konbo Club) | CC BY-SA 4.0 | Tokens, handouts | 60 | 5.7 |
| Cute Heroes and Monsters | Justin Nichol | CC BY 4.0 | Tokens | 64 | 0.8 |
| Dungeon Crawl Stone Soup monsters | the DCSS artists | CC0 | Tokens | 61 | 0.04 |
| Lemurs Fantasy Portraits | Jon Aspeheim | CC BY 4.0 | Portraits, handouts | 58 | 2.1 |
| Fantasy RPG Portraits | Joseph Hewitt | CC BY 4.0 | Portraits, handouts | 25 | 2.0 |
| Flare Hero Portraits | Justin Nichol, for the Flare project | CC BY-SA 3.0 (6), CC BY 3.0 (4) | Portraits, handouts | 10 | 0.8 |
| Warlock's Gauntlet: ruins, wrecks, bones and woods | the Warlock's Gauntlet artists, stated by the project lead | CC BY 3.0 | Stamps | 40 | 0.4 |
| Poly Haven props | named per model | CC0 | Stamps | 41 | 0.5 |
| Flat greyscale props | Mark Gosbell | CC0 | Stamps | 50 | 0.1 |
| Historical art | AIC and Cleveland open access | CC0 | Handouts, portraits | 47 | 9.4 |

Each pack's evidence (its page, the license in the page's words and in its license file, a Wayback snapshot, the AI check, the credit the author asks for) is in the candidate list, and its contact sheet is among the contact sheets (kept outside the repository).

### 3.1 Notes per pack

- **Dyson Logos.** A full count through the blog's public API: of 3,425 posts, 276 carry "Cartography by Dyson Logos is licensed under a Creative Commons Attribution 4.0 International License" on the live page, all dated 2013-12-20 to 2019-06-13. The 29 picks cover inns, caves, dungeons, temples, ruins, castles and towers, a town, a hamlet, wilderness, a shipwreck, docks, crypts, sewers and manors. 26 have a drawn grid: the build measured its square on all 26, and where its lines fall on 21. 247 more maps carry the line if the pack should grow.
- **Scarlet Heroes maps.** Five Dyson maps from 2014 that Kevin Crawford bought outright and released: "I am releasing all the art from that book into the public domain", on the publisher's DriveThruRPG page (Wayback 2014-03-28). No drawn grid.
- **Index Card Dungeons.** Inked 3 by 5 inch cards from 2014, each a whole small dungeon: exploration maps, not 5 ft battle grids.
- **Illustrated Bestiary.** The best find: hand-drawn color monsters on transparency for the Cairn RPG, covering the owlbear, mimic, gelatinous cube, chromatic dragons and more, 60 of 145 picked. Every file name carries "CC-BY-SA_Oozejar".
- **Dungeon Crawl Stone Soup.** Only the vetted November 2015 release of the crawl/tiles repository, whose maintainer states CC0 for the artists who signed off. The OpenGameArt zips are repacks that include tiles since withdrawn, so they are not used. 32 px pixel art, upscaled 8 times with nearest neighbor.
- **Portraits.** Lemurs are ink heads of many races, Hewitt's are naive acrylic paintings, Flare's are painterly. Flare's packs 2 to 5 are left out: they are likenesses of named Kickstarter backers.
- **Warlock's Gauntlet.** The rest of the six top-down pages the shipped bushes and campfires come from. The license is stated by Liosan, the project lead, who wrote in 2013 that the artists "agreed to license it as CC for use in the WG project" (decided in section 12).
- **Poly Haven props.** Benches, a settle, chairs and stools, tables, candles, a lantern, a statue, pots, goblets, baskets, tubs, a crate, a chessboard, a cannon, a pier, stumps, logs and boulders, rendered from above by `scripts/stamps.ts` as the shipped furniture is. Three picks are one part of a model set, and their renders were checked on a contact sheet.
- **Historical art.** The clearest 14 people, 10 creatures, 10 places, 7 items and 6 documents of draft 1's 134, each keeping draft 1's evidence.

## 4. Where a DM finds it: its own selector

Starter art never mixes into the room's own images. Each place that picks art gains a **Starter** tab beside its existing sources, showing only the packs that fit that place, organized by pack and then by category inside the pack (Dyson Logos by Taverns, Caves and Dungeons, the Illustrated Bestiary by Dragons and Undead, and so on). A search box covers names and tags across the packs shown. Under the chosen tile: the work's name, the pack, its author and license, and Use. Where the dialog is too short for the tiles' box and that row, as on a phone held sideways or at 130%, the row is pinned to the dialog's foot, so Use is never under the fold. The Icons tab's row is pinned the same way.

| Place | Starter tab shows | What Use does |
| --- | --- | --- |
| Token image picker (tokens, character portraits, monster images) | Token and portrait packs, the Bestiary, Historical art's people and creatures | Copies it in as a `token` image and opens the crop editor, as a library pick does |
| New scene, Map image | Map packs, by pack then setting | Copies it in as a `map` image and creates the scene at the map's grid (section 7) |
| Handouts | Portrait packs, the Bestiary, Historical art | Copies it in as a `handout` image |
| Builder, Stamp mode | Prop packs | Places the stamp by reference, as shipped stamps are placed |

One component, `client/features/starter/StarterBrowser.tsx`, serves all four, given the uses to show. The catalog loads with the panels the room preloads in the background (design.md 14.1). The 256 px thumbnails load when a pack opens, each showing loading until it arrives: a pick needs the server anyway, so having them early would buy nothing offline, and a phone would fetch every pack's previews for a picker it may never open. Players see the Starter tab in the image picker for their own character's portrait, since `token` is a kind a player may add. Maps and handouts stay DM kinds.

## 5. How a pick joins the room

**Two ways were weighed.**

- **A shared reference** (`{ starter: "<pack>/<work>" }` wherever an image is named): nothing in the room's library, no quota, nothing in backups. But it adds a variant to every reader of a token's, a portrait's, a handout's and a map's image (about 30 files, as the icon variant did). A room export would depend on the receiving server having the same pack version. A pack update that drops a work would break scenes. And maps would need their mobile and thumbnail variants shipped prebuilt.
- **A copy on pick** into the room's assets: everything that reads images works at once (the crop editor, handouts, map scenes and phases, export and import, the credit line), and the export is whole on any server.

**The decision: copy on pick for tokens, maps and handouts, and a reference for stamps.** Stamps already work by reference (`art: { key }`, drawn from `/stamps/<key>.webp`), so the prop packs join that catalog with pack-prefixed keys and never touch the library.

What keeps a copy from cluttering the DM's own images:

- **Route.** `POST /api/rooms/:id/assets/starter { work, kind }` looks the work up in the shipped catalog, reads the file from the folder the Starter tab is served from (`dist/starter/` in production, `public/starter/` elsewhere, where Vite serves it), runs the upload pipeline for the kind, and stores the credit from the catalog, never one the client sends, in the `credit` column the Openverse import added (docs/design-v1-dm-tools.md 3.13). The work must be in the catalog and the kind among its uses. `map` and `handout` need the DM. Picks spend an hourly budget of their own, apart from uploads (60 a session, 120 an IP, 240 a room). A DM's pick of a work the room already holds as that kind spends nothing. A player's pick spends one either way, so a player whose budget is spent is refused alike for a held work and a fresh one. A map's answer carries its grid as the server's catalog measured the file it copied. A player's pick answers no sooner than 400 ms after it came (`PLAYER_PICK_FLOOR_MS`), whether the room held the work or it was copied fresh: a held work's answer took a few ms against 13 to 105 for a fresh copy, so a player timing picks of the token packs could learn what the DM had picked, such as the image on a hidden token. The picker shows Use busy and "Adding to the room…" from the tap, so the wait never looks hung. The pick keeps its intake slot until it answers, so a second pick sent meanwhile is refused alike for a held work and a fresh one, and a held work takes its turn in the processing queue as a fresh copy does, so a full queue refuses both alike. A tablemate on the same address may meet a brief 503 on an upload meanwhile, which the image picker waits out. A failed pick waits out the floor too. The answer is built the same either way, and a player's library lists what they added by when they added it (`asset_uploaders.added_at`), so a held work picked now lists first, as a fresh one does. Known limit: a fresh copy that runs past 400 ms behind a busy queue answers later than a held work would, which is accepted. The DM's picks keep the fast path and the free reuse, since the DM's library lists every image the room holds.
- **Marked as starter.** `assets` gains `starter text`, the work's key (null for uploads). A second pick of one work reuses the row (`unique (room_id, sha256, kind)`).
- **Library.** The Library panel and the picker's Library tab list the DM's uploads first, then a folded "From starter packs" group, so a DM managing their own maps never wades through starter art. New scene's "Or use a map already in this room" and the handout form's list put the DM's own first and the picks after, apart.
- **Quota.** A starter row does not count toward the room's stored bytes (`roomStoredBytes` skips rows with `starter`). Its file is shared by every room that picked it and can always be made again from the image.
- **Storage and backups.** Asset files are stored by content hash, so a work picked in ten rooms is one file on disk, and the incremental backup copies it once.
- **"Not in use" cleanup.** A picked work nothing uses any more is marked Not in use like an upload. Deleting it is harmless, since the DM can pick it again.
- **Export and import.** The export carries the file, its credit and its mark, so a room moves to another server whole. An import keeps the mark only where that server ships the work with the same SHA-256 (section 12), and an import over the room's quota is refused whole.
- **A later scene from a pick.** The listing gives a pick's SHA-256, so a scene made later from a map the room holds takes the catalog's grid only when the catalog's file is the room's. A work rebuilt since, or a tab holding an older catalog, opens on Grid instead.

## 6. SRD monster tokens

Unchanged from draft 1. `shared/srd/tokenIcons.ts`, written by a script from the reviewed table, maps every SRD id to `{ icon, color }`, and `monsterImage` falls back to it when the room has no `srdImages` entry. The DM's own choice always wins, nothing is stored, and existing rooms get the defaults with no migration.

- 330 monsters: 113 exact icons, 214 close, 3 generic (Ettin, Weasel, Giant Weasel). 265 distinct icons by 10 authors, all CC BY 3.0 and already credited by author.
- The disk is colored by creature type from the 14 swatches (Aberration purple, Beast brown, Celestial yellow, Construct gray, Elemental orange, Fey pink, Fiend coral, Giant dark gray, Humanoid blue, Monstrosity teal, Ooze light gray, Plant green, Undead black). Dragons take their own color where the palette has one.
- The Bestiary pictures about 60 SRD monsters in color. A later step could offer "Use the Bestiary's picture" on those monsters' pages. The default stays the icon, since it covers all 330.
- The dragon turtle's SRD id was `dragon-tur-t-le` and its name "Dragon Tur t le", a parsing slip: the SRD import took names from the index of stat blocks, whose kerning gaps split that one. It takes them from the stat blocks now, so the monster is `dragon-turtle`, "Dragon Turtle". Rooms key `srdImages` by the id, so the fix came with a migration of its own, schema version 14 and op version 10 (docs/design.md, Versioning).
- A token wearing the shipped icon on another color was marked by hand, so Apply to N tokens leaves it for the DM's say.

## 7. Maps in the app

- **The grid.** Each map in the catalog carries its cell size in pixels, measured on the file as shipped, and feet per cell where the map or post says. A scene made from it starts at that cell size (`mapScene` takes it as it takes a file name's hint today), and where the build also found where the lines fall, at that origin, so it skips grid alignment. A map with no grid opens on Grid, as an upload does, and so does one whose square size was measured but not where its lines fall (5 of Dyson's), with the box already at that size.
- **Black and white maps.** Dyson's, Majcher's and the Scarlet Heroes maps are ink on white. The app's default grid (white, 25%) vanishes on white paper, so the catalog gives these maps a dark grid color and the scene starts with it. The DM's 50% fog turns the paper gray, which reads fine.
- **Encoding.** Line-art maps ship as 4-level gray PNG at 4096 px on the long side: 7.9 MB for Dyson's 29, against 16.4 MB as WebP, with no visible loss at 1:1 (checked on a crop). The painted cavern ships as WebP at quality 80. The upload pipeline then makes the room's variants as for any map, as WebP, and the pick's credit says so.
- **The notes in the margin.** 24 of Dyson's maps carry "SUPPORTED ON PATREON | www.DYSONLOGOS.com" in the margin. They stay: a crop is a change to record, and it moves the grid's origin.

## 8. The build

`node scripts/starter-art.ts`, like `scripts/stamps.ts`, never hand-made images:

- **Input.** `scripts/starter-art.json`: each pack's id, title, author, license, page, the license in its own words, its Wayback snapshot and AI check, and each work's key, name, category, tags, uses, grid, source URL and pinned SHA-256.
- **Fetch and pin.** It fetches each pack's archive or files from where the author published them and checks the pinned hash, so a changed upstream file fails loudly and asks for its license to be checked again. itch.io gives a fresh download link per request, which the script asks the page for, as a browser does.
- **Encode.** Maps as section 7 says. Token art at 512 px on the long side (the token kind's full size), pixel art upscaled 8 times with nearest neighbor to 256 px, portraits and the Bestiary at 1024 px, and Historical art's pictures up to 1600 px, shrunk until each is under 300 KB, all WebP at quality 80 (encoder effort 4). A 256 px thumbnail per work. Only mechanical changes: resize, crop, format and color space, each recorded per work.
- **Output.** `public/starter/<pack>/<key>.<ext>` and `public/starter/<pack>/thumbs/<key>.webp`, stamps into `public/stamps/` with pack-prefixed keys, and `shared/starterArt.ts`, the catalog the client and server read. The outputs are committed, as the stamps are.

## 9. Credits and credits.test.ts

- `CREDITS.md` gains a "Starter packs" section: one block per pack with its author, page, license, the credit the author asks for and what changed, then a table of its files. Historical art lists each work with its museum page.
- `shared/credits.ts` gains a `starter-packs` group, one credit per pack (one per work for Historical art), for the About page. Each picked image also carries its credit on its asset row, shown in the library and the token panel with the credit line its author asks for, where one does. A public domain dedication's credit links the snapshot of the page that makes it.
- `shared/licenses.ts` gains `CC-BY-SA-4.0` (the Bestiary) and `public-domain-dedication` (the Scarlet Heroes maps), the second named plainly, never as CC0.
- `credits.test.ts`: `shippedArt` adds `public/starter`. New tests:
  - The catalog equals the files on disk, and every file belongs to a pack.
  - Every pack names a page, an allowed license and a Wayback snapshot.
  - The per-file and whole-folder caps in section 10 hold, so growing the set is a decision.

## 10. Size budget

As built:

| Part | MB |
| --- | --- |
| Map packs (Dyson Logos, Scarlet Heroes, Index Card Dungeons, Cavern) | 9.5 |
| Token and portrait packs (Bestiary, Cute Heroes, DCSS, Lemurs, Hewitt, Flare) | 11.5 |
| Historical art | 9.4 |
| Thumbnails, 309 (the DCSS tiles are their own) | 2.3 |
| **`public/starter`, 679 files** | **32.7** |
| Prop packs, as stamps in `public/stamps` (Warlock's Gauntlet, Poly Haven, flat greyscale) | 1.0 |
| **Everything** | **33.7** |

Per-file caps: a line-art map at most 4096 px and 1 MB, a color map 2.5 MB, token art 512 px, a picture 1024 to 1600 px and 300 KB, a thumbnail under 30 KB. The repository's pack is about 25 MB today, and these files do not compress further, so it grows by the same amount, and the Docker image too, since `public/` is copied into `dist/`.

**What more would cost:** each further Dyson map about 0.26 MB (247 more carry the CC line), each further Bestiary monster about 0.09 MB (85 more), each color battle map 1 to 2.5 MB. Past 40 MB the art should leave git history, since every clone carries it forever. Two ways: a starter pack archive published as a release download with a pinned SHA-256 that the Docker build fetches, the repository keeping only the catalog, or Git LFS. Either is a separate decision.

## 11. Rejected sources and closest misses

| Source | Why |
| --- | --- |
| itch.io free battle maps | 711 map pages read: 145 free battle maps, none under CC0, CC BY or CC BY-SA. Most state no license, 36 are NC or ND, and 174 of the 711 carry an AI disclosure. |
| Elven Tower's "Stock Art Maps", Axebane's Dungeon Maps | CC BY 4.0, but paid. |
| Majcher Arcana's color "Dungeon Maps 2011-2013" | CC BY 4.0 and the best-looking color maps found, but nothing is downloadable yet. Worth asking the artist. |
| 2-Minute Tabletop | CC BY-NC 4.0 (https://2minutetabletop.com/license/). |
| Tom Cartos, Czepeku | Their own licenses: "Tom's Open Map License" and "Czepeku's Commercial Use Licence". |
| Dyson Logos's current Commercial Maps terms | A custom license that reserves moral rights. Only maps whose own posts carry CC BY 4.0 are used. |
| One Page Dungeon Contest | CC BY-SA, but each year is 100 or more authors in different styles, keyed with spoiler text: not a pack. |
| GitHub map repositories | Dungeondraft maps built on Forgotten Adventures' asset packs (art the repositories cannot relicense), NC licenses, or rough sketches. |
| Sine Nomine's Silent Legions pack | "Released for free use", which is not a dedication. |
| Justin Nichol's "The Free Monsters" | The page says CC BY-SA 3.0, the zip's license file CC BY-SA 4.0. |
| TornioDuva tokens | The page says CC0, the print sheets CC BY-NC 4.0. |
| FrogPotion tokens | No license stated. |
| Tania Herrero's Monstrous Menagerie | CC BY 4.0 with added restrictions, so custom. |
| Wesnoth | GPL only. |
| The DCSS OpenGameArt zips and the 2017 supplemental set | Include tiles since withdrawn or never vetted. Only the 2015 release is used. |
| Gordy Higgins's doodles | Public domain and coherent, but thin black lines vanish on a dark map. |
| Quaternius and KayKit prop kits | CC0, but low-poly 3D that clashes with both stamp looks. |
| Magic Circle, Foundry Fantasy Furniture, Cartography Assets' free Dungeondraft packs | Paid, or a custom non-commercial license. |
| Bleed's catapult | The page says CC BY 3.0, the license file forbids distribution. |
| Hyptosis, Lamoot | Three-quarter view, not top-down. |

Every rejected pack and source, with its reason, is in the candidate list's `rejected` section (draft 1's included).

## 12. Decisions

The questions of draft 2 are settled as follows, and the build follows them.

1. **The packs.** 14 packs, 501 works: Dyson Logos maps (29), Scarlet Heroes maps (5), Index Card Dungeons (10), Cavern Battlemap (1), Illustrated Bestiary (60), Cute Heroes and Monsters (64), Dungeon Crawl Stone Soup monsters (61), Lemurs Fantasy Portraits (58), Fantasy RPG Portraits (25), Flare Hero Portraits (10), Warlock's Gauntlet (40), Poly Haven props (41), Mark Gosbell's flat greyscale props (50) and Historical art (47).
2. **Dyson Logos.** In, under CC BY 4.0 with the credit "Cartography by Dyson Logos". The maps are changed only mechanically.
3. **Warlock's Gauntlet.** In, on the project lead's statement, as the shipped stamps are.
4. **Mark Gosbell's flat greyscale props.** In, as a pack of their own.
5. **Sine Nomine's Spears of the Dawn maps and figures.** Left out.
6. **Kenney sample maps.** Left out.
7. **Historical art.** In, as its own pack of 47.
8. **The Bestiary's size.** 1024 px, so a monster can be shown as a handout.
9. **SRD tokens.** Every one of the 330 monsters gets a default token, a disk colored by creature type (section 6). The dragon turtle's id was fixed separately, with schema version 14 and op version 10.
10. **A starter pick in a room export.** It keeps its starter mark on import only when the importing server's catalog has that work with the same SHA-256. Otherwise it imports as an ordinary upload and counts toward the room's storage.
11. **Removing an SRD monster's image.** "Use the default icon" takes the place of "Remove image", so an SRD monster's tokens never start as initials only. A DM's own image or icon still wins.
12. **The picks' rate.** Picks have an hourly budget of their own, apart from uploads, as handouts and thumbnails have, and a pick the room already holds costs nothing.

## 13. Evidence and checking

- **The candidate list** holds every pack with its evidence and every work with its source, size and grid, plus every rejected source with its reason. It stays outside the repository. The decided packs and works, with their evidence, become `scripts/starter-art.json`.
- **Contact sheets**, one per pack, number every work as the list does. Draft 2's sheets marked a held pack in its title.
- **An independent checker** verifies every pack's license before anything is built. A pack it cannot confirm is dropped, not argued.

## 14. Build split and tests

One lane, four commits:

1. The SRD defaults: the table, the fallback in `monsterImage`, and their tests.
2. The build script, catalog, files and credits.
3. The server route, the `starter` column, the quota rule and the library grouping.
4. The Starter tab in its four places.

Tests beyond section 9:

- The route's permissions by kind, and its refusal of an unknown work or a use the work lacks.
- A credit stored from the catalog, never from the request.
- A starter row outside the quota, and a second pick reusing one row.
- A map scene created at the map's grid and grid color.
- Export and import keeping the credit.
- The e2e files the four places touch.
