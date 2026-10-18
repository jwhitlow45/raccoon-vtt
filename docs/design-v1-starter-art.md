# raccoon-vtt design: starter art for DMs

Status: research and design, draft 1. Nothing is added to the repository until the project owner approves the candidate list and the contact sheets.

The project owner asked: "please also add some open source art that can be selected from to help DMs get started. group the art into categories and organize it. just overall i want to make things as easy as possible for dms. you must be 100% positive that the art is open source and abide strictly by licenses as we have so far. please also ensure the art is not ai generated regardless of license (either by you or by the person that put it on the internet)".

## 1. Summary of the decisions

1. **Every SRD monster gets a default token** from the game-icons.net icons the app already ships: 330 monsters, 265 distinct icons, each on a disk colored by creature type. No new art and no new credit. It helps the most for the least: every monster added from the list arrives recognizable.
2. **134 starter pictures** ship for handouts, NPC portraits and scene-setting, in five categories: People, Creatures, Places, Items, and Documents and old maps. All come from two museums that release their images CC0, so every one is a historical work with a catalogue record.
3. **Battle maps are scarce under the rules.** Four pass outright. Fourteen more (Dyson Logos and Sine Nomine Publishing) pass on a reading the owner must confirm (section 11). The builder stays the main way to make a battle map.
4. **Builder stamps**: five pass outright, and twelve share the license question the shipped Warlock's Gauntlet stamps already raise (section 11).
5. **One shared browser, three doors.** A Starter art tab in the image picker, starter maps in New scene, and starter pictures in Handouts. A pick copies the file into the room's library as an ordinary asset with its credit, so every existing feature works on it unchanged.
6. **About 23 MB** added to the repository and the image for everything that passes outright, about 27 MB with every held work, inside the 40 MB budget.

## 2. What a DM needs first, and so what ships

A DM starting out needs, in order: something on the map for each creature, a map to stand on, and something to show the table. The app covers the first two in part (icons, the builder) and the third not at all.

- **Tokens.** A monster added from the SRD list starts as a plain disk with initials until the DM picks an image (`client/features/monsters/images.ts`). The 4,180 shipped icons hold a fitting picture for nearly every SRD monster, so a default per monster costs nothing to ship (section 6).
- **Pictures to show.** Handouts, NPC portraits and "you arrive at..." scenes are where a new DM reaches for a web search. Museum open-access collections are certain on both rules: the institution that holds the work releases the image CC0, and the work was made by a named person long ago.
- **Battle maps.** The most wanted, and the hardest. Nearly every free battle map online is under a non-commercial or custom license (section 10). What passes is in section 5.4.
- **Stamps.** The builder's 46 stamps lack seating, dead trees, bones and carts. Section 5.6 has the additions.

## 3. Categories and how they are organized

Every work has a category, a group inside it, a short plain name a DM would use ("Old soldier with a gold chain"), search words, and the uses it fits. The browser shows categories as tabs, groups as headings, and a search box across all of them.

| Category | Groups | Works | Where it shows |
| --- | --- | --- | --- |
| People | Nobles and royalty 6, Warriors and guards 5, Scholars, priests and mages 6, Merchants, crafters and innkeepers 9, Common folk and travelers 8 | 34 | Image picker (portraits), Handouts |
| Creatures | Dragons and serpents 6, Fiends 4, Giants and ogres 3, Undead and spirits 5, Beasts and monstrosities 7, Fey and folklore 5 | 30 | Image picker, Handouts |
| Places | Castles and towns 6, Ruins and dungeons 7, Wilds 5, Interiors 6, Temples and palaces 3, Sea and ships 4 | 31 | Handouts, New scene (as a backdrop) |
| Items | Weapons 5, Armor and shields 5, Treasure and jewelry 7, Curiosities and magic items 7 | 24 | Handouts, Image picker (item tokens) |
| Documents and old maps | Letters and manuscripts 6, Maps and charts 5, Diagrams and curiosities 4 | 15 | Handouts |
| Battle maps | By setting: caves, villages and camps, houses, taverns, temples, castles, ruins, dungeons, cities | 4, and 14 held | New scene |
| Builder stamps | Seating, Dead trees and logs, Bones and remains, Vehicles, Ruins | 5, and 12 held | The builder's Stamp picker |

People are grouped by role, never by culture, and each role mixes cultures: the set covers European, Persian, Mughal and Deccan Indian, Chinese, Korean and Japanese sitters, 15 women and 19 men, young and old.

## 4. Where a DM finds it

**One browser.** `client/features/starter/StarterBrowser.tsx` shows the catalog filtered by use: tabs for the categories that fit, group headings, 96 px tiles from 256 px thumbnails that load lazily, and a search over names and tags. Under the chosen tile it shows the name, the work's title, maker and date, the institution and the license ("Portrait of a Lady by Michele Tosini, about 1555. Art Institute of Chicago, CC0."). Use imports it (section 5).

- **Image picker.** A new Starter art tab, second after Icons, showing People, Creatures and Items. It serves token images, character portraits and monster images. A pick lands in the crop editor as a library pick does today, so a portrait becomes a face on a token in two taps.
- **New scene.** The Map image choice shows "Start from a starter map" above the file field, with the battle maps by setting and the Places pictures as backdrops. A battle map with a known grid creates its scene at that cell size (`mapScene` takes the catalog's `cellPx` as it takes a file name's hint today), so it skips grid alignment. One without a grid opens on Grid, as an upload does.
- **Handouts.** "Starter pictures" beside the upload button opens the browser on People, Creatures, Places, Items and Documents, and a pick becomes a handout image.
- **Builder.** New stamps join `STAMP_ART`, as the 46 do. The Stamp picker gains group headings (Trees and plants, Rocks, Furniture, Camp and village, Bones and remains), since 60 tiles want them.
- **The DM guide** gains a short "Starter art" section, and the About page credits every work.

Players see the Starter art tab in the image picker for their own character's portrait, since `token` is a kind a player may add. Maps and handouts stay DM kinds.

## 5. How a pick becomes room art

**A copy into the library, not a new kind of image.** A new route, `POST /api/rooms/:id/assets/starter { key, kind }`, looks the key up in the shipped catalog, reads the file from the server's own `dist/starter/`, and runs it through the same pipeline as an upload (`processImage` for the kind's variants). The asset row stores a credit built from the catalog, never one the client sends, in the `credit` column the Openverse import added (docs/design-v1-dm-tools.md 3.13). Its license codes are the ones that column already reads: `cc0`, `by`, `by-sa` with their versions.

This was chosen over a new `ImageRef` variant (`{ starter: key }`), which would touch every reader of a token's, a portrait's, a handout's and a map's image again, as the icon variant did (about 30 files). A library asset works everywhere at once: the crop editor, handouts, map scenes, export and import, the library's credit line, and cleanup. Asset files are stored by content hash, so two rooms that pick the same work share one file on disk, and a second pick in one room reuses its row (`unique (room_id, sha256, kind)`).

**Permissions.** The kind's rules hold: `map` and `handout` need the DM, `token` any member. The key must be in the catalog and the kind among the work's uses. Room quotas count a starter pick as an upload.

**Offline.** A pick needs the server, as an upload does. The catalog and thumbnails load with the panels the room preloads in the background (design.md 14.1).

### 5.1 The credit shown

The library and the token panel already show an imported image's credit with what changed (`client/features/images/credit.ts`). A starter pick shows the same line: "Portrait of a Lady by Michele Tosini, CC0. Resized and converted to WebP." For the CC BY maps and stamps the line carries the attribution the license asks for. The asset's `originalWidth` and `originalHeight` are the original's as published, so "Resized" is said only when it was.

### 5.2 Sources

| Source | License as released | Works | Evidence per work |
| --- | --- | --- | --- |
| Art Institute of Chicago | CC0 for public domain works: "CC0 Public Domain Designation" on each object page, `is_public_domain` in the API | 67 | catalogue and API record, object page, Wayback snapshot |
| Cleveland Museum of Art | CC0: "CC0" on each object page, `share_license_status` in the API | 68 | catalogue and API record, object page, Wayback snapshot |
| OpenGameArt (Ferrin, Kenney, Bleed) | CC0, CC BY 4.0, on each page | 4 | page with date and license, Wayback snapshot from before 2022 |
| Poly Haven | CC0 (https://polyhaven.com/license) | 4 | API date, Wayback snapshot from before 2022 |
| OpenGameArt (Warlock's Gauntlet packs) | CC BY 3.0, stated by the submitter | 12 held | as above |
| Dyson Logos's blog | CC BY 4.0 on each map's own post | 6 held | post, Wayback snapshot from before 2022 |
| Sine Nomine Publishing | public domain dedication by the rights holder | 8 held | publisher's statement, Wayback snapshots from 2013 and 2014 |

The Met was searched but not used: its object pages refuse scripted requests and its search API rate-limited the research, so its evidence could not be checked as directly. AIC and Cleveland covered every subject.

### 5.3 Pictures

All 134 pictures are historical by the rule: each was made before 1930 (the latest dated is a 1919 print, and one undated painting entered its museum in 1927), and no named maker died after 1945. Each record holds the catalogue date, the maker's death year where known, the API record as fetched, the object page, and a Wayback snapshot (118 from before 2022). Where the first snapshot predates the museum's open access release (Cleveland's began in 2019), the record adds a later snapshot that shows the license. The planned change for every picture: resized to the largest of 1600, 1280 or 1024 px on the long side that fits 300 KB at WebP quality 75, colors converted to sRGB.

Taste rules applied, so the set reads well at a table: one clear subject legible on a phone, no nudity or gore, no devotional scene whose point is religious, no caricature, no famous sitter whose name is the point, little text except on documents. Three creature works show saints (two of Saint George fighting the dragon, and demons mobbing Saint Anthony) and are kept because the creatures are the subject (question 6).

### 5.4 Battle maps

What passes outright:

- **M-01 Cavern Battlemap** by Ferrin (OpenGameArt, CC0, 2015-09-19): made for VTTs in GIMP, a 50 px grid, 40 by 40 cells. The only battle map on OpenGameArt.
- **M-02, M-03**: the sample maps of Kenney's Roguelike/RPG pack (CC0, 2015), a lakeside village and a manor. Small pixel art (918 by 515), 25 and 26 px tiles, no drawn grid. Weak, kept because they pass.
- **M-18**: Nolli's plan of Rome, 1748 (Cleveland, CC0), a city backdrop without a grid.

Held for the owner (section 11): six Dyson Logos maps from 2015 to 2019 (an inn, a temple, a castle, a tower, riverside ruins, a cave citadel) whose own posts say CC BY 4.0, and eight from Sine Nomine's free packs (five more by Dyson Logos, three by Kevin Crawford) under a public domain dedication. Together they would give a DM a real starting shelf: a tavern, temples, a castle, caves, dungeons and a village.

### 5.5 What the battle map gap leaves

A DM without a fitting map has three answers in the app today: the battle mat, the builder with its textures and stamps, and their own upload or Openverse search. This design adds none: an agent laying out builder scenes would be making the art itself, which the request rules out. If the owner wants ready-made builder scenes (a tavern, a crypt, a forest road), a person should lay them out, and they would ship as room templates in a separate small design.

### 5.6 Stamps

Passing outright: four Poly Haven models published in 2020 and 2021 (a high-backed carved chair, an armchair, a rocking chair, a stool), rendered from above by `scripts/stamps.ts` as the furniture is today, and Bleed's medieval cart (OpenGameArt, CC BY 4.0, 2017) taken as a sprite. Bleed ships the cart's shadow as a separate layer, and drawing it under the cart would be a composite, not a crop, so the plan ships the cart alone. Held: twelve Warlock's Gauntlet sprites (three dead trees, a fallen tree, a log, a broken tree, a stump, a monster skeleton, a giant skull, a bone pile, a small boat, a ruined shed), the same look and source as the shipped bushes and campfires. Three more Poly Haven models (a chair, an urn, a jar) are dated 2021 by Poly Haven but have no Wayback snapshot from before 2022, so they fail the evidence rule. Still missing: an altar, statues, a cauldron, an anvil, a well, tents, a coffin, braziers, a weapon rack and rugs.

## 6. SRD monster tokens

`shared/srd/tokenIcons.ts`, written by a script from the reviewed table, maps every SRD id to `{ icon, color }`. `monsterImage` (`client/features/monsters/images.ts`) falls back to it when the room has no `srdImages` entry: `state.srdImages?.[id]?.image ?? srdDefaultImage(id)`. The DM's own choice always wins. Nothing is stored, so existing rooms get the defaults with no migration, and tokens already placed keep their image. "Apply to N tokens" treats the default as the monster's image, so it can repaint tokens placed before this change.

- **The picks.** 113 exact (a goblin's head for a goblin), 214 close (a wolf's head for a dire wolf), 3 generic (Ettin, Weasel, Giant Weasel). 265 distinct icons by 10 authors, all CC BY 3.0 and already credited by author on the About page.
- **The colors.** The disk takes a color by creature type from the 14 swatches, so a DM tells kinds apart at a glance: Aberration purple, Beast brown, Celestial yellow, Construct gray, Elemental orange, Fey pink, Fiend coral, Giant dark gray, Humanoid blue, Monstrosity teal, Ooze light gray, Plant green, Undead black. Chromatic and metallic dragons take their own color where the palette has one. Bronze and copper share brown, so their tokens of one age match. SRD 5.2.1's own types will surprise some DMs and are kept as given (a gnoll is a Fiend, a worg is Fey).
- **Weakest picks**, each one tap for a DM to change. The four mephits, Ettin and the weasels have no icon of their own. The Bearded, Chain and Ice Devils, Glabrezu, the Cloud and Storm Giants and Roper get an object that stands for them (a beard, chains, a claw, a cloud). Incubus and Succubus share an icon, as do Imp and Homunculus, and Hyena and Giant Hyena.
- **Data found on the way.** The dragon turtle's SRD id is `dragon-tur-t-le` and its name "Dragon Tur t le" (`shared/srd/monsters.json`, `rolls.json`), a parsing slip. Rooms key `srdImages` by that id, so fixing it needs a small migration of its own (question 8).
- **Tests.** Every SRD id has an entry, every icon key is in the shipped index, and every color is in `ICON_COLORS`.

## 7. The build

`node scripts/starter-art.ts`, like `scripts/stamps.ts`, never hand-made images:

- **Input.** `scripts/starter-art.json`, the approved list: each work's key, category, group, name, tags, uses and grid, with its evidence (source page, API record, license as stated, Wayback snapshots, checked date, human-made evidence). Keeping the evidence in the repository lets anyone audit a work later without this research.
- **Fetch and pin.** It fetches each original from the institution or author and checks a pinned SHA-256, so a changed upstream file fails loudly and asks for its license to be checked again. AIC serves images through IIIF, which encodes on request, so a changed hash there may be harmless: the failure says so, and the reviewer refetches.
- **Encode.** Pictures as section 5.3 says. Maps at most 4096 px on the long side at quality 80, stepping down until under 2.5 MB, with the cell size scaled to match. A 256 px thumbnail per work at quality 70. Only mechanical changes: resize, a crop given as a rectangle in the input (the two maps on each Sine Nomine page, a print's blank margin), format and color space. Each record's `changes` says exactly which.
- **Output.** `public/starter/<category>/<key>.webp`, `public/starter/thumbs/<key>.webp`, and `shared/starterArt.ts`, the catalog the client and server read. The outputs are committed, as the stamps are.

## 8. Credits and credits.test.ts

- `CREDITS.md` gains a "Starter art" section: a table of every file with the work's title, maker, date, institution or site, source page, license and changes. About 150 rows, fewer than the icons would have been, and each work is its own credit.
- `shared/credits.ts` gains a `starter-art` group built from the catalog, one credit per work covering both its files, so the About page lists them.
- `shared/licenses.ts` gains `CC-BY-SA-4.0` only if a work needs it, and a `public-domain-dedication` id only if the owner accepts the Sine Nomine works, which are not CC0 by name and must not be labeled CC0.
- `credits.test.ts`: `shippedArt` adds `public/starter`, so an uncredited file fails as today. New tests:
  - The catalog equals the files on disk.
  - Every work names a source and a license from the allowed set.
  - Every work's evidence has a Wayback URL (`https://web.archive.org/web/<14 digits>/`), a checked date and a human-made rule.
  - A historical work is dated before 1930, or its maker died before 1955.
  - Thumbnails are 256 px WebP under 30 KB, pictures at most 1600 px and 300 KB, maps at most 4096 px and 2.5 MB.
  - The folder stays under the budget, so growing it is a decision.

## 9. Size budget

Measured by encoding every candidate as the build would:

| Part | Works | MB |
| --- | --- | --- |
| People, creatures, places | 95 | 13.72 |
| Items and documents | 39 | 5.42 |
| Battle maps that pass | 4 | 2.45 |
| Stamps that pass | 5 | about 0.1 |
| Thumbnails (6 KB mean, 25 KB largest) | about 140 | about 0.9 |
| **Total that passes** | **about 143** | **about 22.6** |
| Held maps and stamps, if accepted | 26 | about 4.5 |

Per-file targets: a picture at most 300 KB (median 137 KB), a map at most 2.5 MB, a thumbnail under 30 KB, a stamp under 30 KB. The repository's pack is about 25 MB today. WebP does not compress further, so the pack grows by the same 23 to 27 MB, and the Docker image too, since `public/` is copied into `dist/`. The test in section 8 holds the folder under 40 MB.

Going past 40 MB, for example to a few hundred maps, should stay out of git history, since every clone would carry it forever. The options are a starter art pack published as a release download with a pinned SHA-256 that the Docker build fetches, the repository keeping only the catalog, or Git LFS. Either is a separate decision.

## 10. Rejected sources

| Source | Why |
| --- | --- |
| 2-Minute Tabletop | Free maps are CC BY-NC 4.0 (https://2minutetabletop.com/license/): non-commercial. |
| Tom Cartos | "Tom's Open Map License", a custom license. |
| Dyson Logos's current terms | The Commercial Maps page now gives a custom license and reserves moral rights. Only maps whose own posts state CC BY 4.0 are considered, and those are held (question 2). |
| Sine Nomine's Silent Legions pack | Says only "released for free use": neither an allowed license nor a public domain dedication. |
| Kenney's Scribble Dungeons | Published 2022-03-05, after the date line. |
| Kenney samples with the logo drawn in | Would need a crop to remove the logo, and they are previews more than maps. |
| bellow's Temple and Train maps (OpenGameArt, 2021) | Look assembled from a commercial asset library, and the page names no sources. |
| One Page Dungeon Contest | Entries are CC BY-SA, but each is a PDF with the adventure's text on the map, which spoils it for players, and each entry's own notice could not be checked. |
| itch.io free battle maps | None checked shows a CC license, several date from 2026, and one is marked AI-assisted. |
| Wikimedia Commons, Flickr | No own-work battle maps under an allowed license turned up. |
| The Met | Not for license: its object pages refuse scripted requests and its search API rate-limited the research, so per-work evidence could not be checked as directly. |
| Pixabay, Unsplash, Pexels | Their own licenses, excluded by rule. |
| Openverse and search engines | Aggregators: each result would need tracing to its source, which the museums' own APIs make unnecessary. |
| Pixel-art and isometric packs (Liberated Pixel Cup, Kenney's flat sets) | Pass on license but do not match the stamps' top-down painted look. |
| Bleed's catapult | The page says CC BY 3.0, but the license file in its zip forbids distribution without permission. |

Every rejected work and source, with its reason, is in the candidate list's `rejected` section (224 entries).

## 11. Questions for the project owner

1. **The style and the list.** Approve the contact sheets in `~/Desktop/screenshots/raccoon-vtt/starter-art/`, dropping any work by its number. Recommended: approve all 134 pictures and the 4 passing maps.
2. **Dyson Logos's CC BY 4.0 maps (M-04 to M-09).** Each map's own post, live and in a Wayback snapshot from before 2022, ends: "For those that want/need a Creative Commons license, it would look something like this: Cartography by Dyson Logos is licensed under a Creative Commons Attribution 4.0 International License". His Commercial Maps page said in 2019: "If you require a further license, they are ALSO released under the Creative Commons license" (https://web.archive.org/web/20190430123109/https://dysonlogos.blog/maps/commercial-maps/). Today that page gives a custom license and reserves moral rights, but a CC BY 4.0 grant cannot be withdrawn, and it already waives moral rights as far as the licensed use needs. The app changes the maps only by resizing. Recommended: accept. They are the best battle maps found.
3. **Sine Nomine's public domain maps (M-10 to M-17).** Kevin Crawford bought full rights and released them. Scarlet Heroes, read on the publisher's own DriveThruRPG page (Wayback 2014-03-28): "I am releasing all the art from that book into the public domain." Spears of the Dawn (2013-01-22), read only as quoted on OpenGameArt: "also in the public domain". A plain dedication by the rights holder, not CC0 by name. Recommended: accept the five Scarlet Heroes maps, whose statement is on the publisher's page, and leave the three Spears of the Dawn maps out unless the pack's own readme turns up. If accepted, the same packs hold many fantasy illustrations that could later fill a Fantasy group.
4. **Warlock's Gauntlet sprites.** The license on these packs is stated by the submitter, Liosan, the project's lead, who wrote in 2013 that the artists "agreed to license it as CC for use in the WG project". The rule asks for the rights holder's own statement. The 15 shipped bush, fern, plant, campfire, woodpile, wheel and bucket stamps rest on the same statement, so one answer covers both. Recommended: accept, since the statement is the project's own and dates from 2013. If not, the shipped 15 need the same review.
5. **Poly Haven dates.** Six shipped stamp models (chest, crate, fire pit, bookshelf, sapling, stones) were published by Poly Haven after 2021, so they would fail this research's date rule. Poly Haven publishes scans and hand-made models under CC0, but its body of work does not predate 2022. Keep them, or replace them?
6. **Saint subjects.** Keep C-03 and C-04 (Saint George and the dragon) and C-07 (demons around Saint Anthony)? Recommended: keep, since the creatures are the subject.
7. **Colors by creature type** for the SRD tokens, rather than every disk the default dark gray? Recommended: by type.
8. **The dragon turtle's id.** Fix `dragon-tur-t-le` with a migration of `srdImages` keys, as a separate small change? Recommended: yes.

## 12. Build split and tests

One lane, three commits:

1. The SRD defaults: the table, the fallback in `monsterImage`, and their tests.
2. The build script, the catalog, the files and the credits.
3. The browser and its three doors, with the server route.

Tests, beyond the catalog and credit tests in section 8:

- The route's permissions by kind, and its refusal of an unknown key or a use the work lacks.
- A credit stored from the catalog, never from the request.
- A map scene created at the catalog's cell size.
- A second pick of one work reusing one asset.
- Export and import keeping the credit.
- The e2e files the three doors touch.

## 13. The evidence, and how it was checked

- **The candidate list** holds every work with its evidence, by category, and every rejected work and source with its reason. It stays outside the repository until the owner approves it, then becomes `scripts/starter-art.json` (section 7).
- **Contact sheets**, one per category, number every work as the list does, and mark held works with an H. The SRD token sheets show all 330 disks as the app draws them.
- **Per work**: the title, maker, date, the source page, the license in the source's own words, a Wayback Machine snapshot of the page (saved where none existed), the date checked (2026-10-18), the human-made evidence, the planned changes and the size after them. Every museum work's license was read on its own object page as well as in the API, not just a sample.
- **The lead's review** after the category research moved the three Poly Haven models without a pre-2022 snapshot to rejected, and held the Warlock's Gauntlet sprites, both recorded in the list with the reason.
- **A second agent** checks every work's evidence independently before anything is built. A work it cannot confirm is dropped, not argued.
