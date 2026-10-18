# Credits

Apart from the raccoon icon, every image RaccoonVTT ships is existing art published under an open license, and none of it is AI generated. Changes to these files are mechanical only: format conversion, resizing, cropping, rendering a 3D model from above, and removing a background so an icon can be tinted.

RaccoonVTT's own code is under the GNU Affero General Public License v3.0 (see the README's License section). Everything listed here keeps its own license, named with it.

`shared/credits.ts` holds the same list for the in-app About page. A test (`shared/credits.test.ts`) fails if a file in `public/textures/`, `public/icons/` or `public/stamps/` is missing from either one. The token icons are credited by author instead of by file, and the same test fails if a file in `public/game-icons/` is missing from its index or an author in the index is missing from either list.

## Condition and status icons

From [game-icons.net](https://game-icons.net), licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Taken from the [game-icons/icons](https://github.com/game-icons/icons) repository at commit `82d948812bfe3f269ef8f731dcdb07b08160edc4` by `node scripts/icons.ts effects`.

Changes to every icon: the black background square was removed and the fill set to `currentColor`, so the app can tint it. Each file carries its own attribution in an XML comment.

| File | Icon | Author | Source |
| --- | --- | --- | --- |
| `public/icons/conditions/blinded.svg` | Blindfold | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/blindfold.html |
| `public/icons/conditions/charmed.svg` | Charm | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/charm.html |
| `public/icons/conditions/deafened.svg` | Hearing disabled | Skoll | https://game-icons.net/1x1/skoll/hearing-disabled.html |
| `public/icons/conditions/exhaustion.svg` | Tired eye | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/tired-eye.html |
| `public/icons/conditions/frightened.svg` | Terror | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/terror.html |
| `public/icons/conditions/grappled.svg` | Grab | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/grab.html |
| `public/icons/conditions/incapacitated.svg` | Knockout | Skoll | https://game-icons.net/1x1/skoll/knockout.html |
| `public/icons/conditions/invisible.svg` | Invisible | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/invisible.html |
| `public/icons/conditions/paralyzed.svg` | Frozen body | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/frozen-body.html |
| `public/icons/conditions/petrified.svg` | Stone bust | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/stone-bust.html |
| `public/icons/conditions/poisoned.svg` | Poison bottle | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/poison-bottle.html |
| `public/icons/conditions/prone.svg` | Falling | [sbed](http://opengameart.org/content/95-game-icons) | https://game-icons.net/1x1/sbed/falling.html |
| `public/icons/conditions/restrained.svg` | Manacles | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/manacles.html |
| `public/icons/conditions/stunned.svg` | Star swirl | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/star-swirl.html |
| `public/icons/conditions/unconscious.svg` | Night sleep | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/night-sleep.html |
| `public/icons/statuses/concentrating.svg` | Concentration orb | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/concentration-orb.html |
| `public/icons/statuses/hidden.svg` | Hood | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/hood.html |
| `public/icons/statuses/flying.svg` | Feathered wing | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/feathered-wing.html |
| `public/icons/statuses/dodging.svg` | Dodging | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/dodging.html |
| `public/icons/statuses/raging.svg` | Angry eyes | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/angry-eyes.html |
| `public/icons/statuses/blessed.svg` | Spike halo | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/spiked-halo.html |
| `public/icons/statuses/baned.svg` | Cursed star | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/cursed-star.html |
| `public/icons/statuses/hasted.svg` | Sprint | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/sprint.html |
| `public/icons/statuses/hunters-mark.svg` | Target arrows | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/target-arrows.html |
| `public/icons/statuses/hexed.svg` | Warlock eye | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/warlock-eye.html |
| `public/icons/statuses/heroic-inspiration.svg` | Laurels | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/laurels.html |
| `public/icons/statuses/surprised.svg` | Surprised | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/surprised.html |
| `public/icons/statuses/marked.svg` | Human target | [Delapouite](https://delapouite.com) | https://game-icons.net/1x1/delapouite/human-target.html |
| `public/icons/statuses/readied.svg` | Hourglass | [Lorc](https://lorcblog.blogspot.com) | https://game-icons.net/1x1/lorc/hourglass.html |

## Interface icons

The interface icons marked Lucide in `client/components/Icon.tsx` are path data copied from [Lucide](https://github.com/lucide-icons/lucide) ([lucide.dev](https://lucide.dev)), version 0.525.0, used under the ISC License. The app does not ship the Lucide package. The other icons in that file were drawn for this project. The icons copied, by Lucide's names:

`arrow-down`, `arrow-left`, `arrow-right`, `arrow-up`, `copy-plus`, `crop`, `eraser`, `eye`, `eye-off`, `footprints`, `image`, `lock`, `menu`, `pencil`, `radar`, `redo-2`, `refresh-cw`, `repeat`, `trash-2`, `undo-2`, `user-minus`, `users`, `zoom-in`, `zoom-out`.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Token icons

The icons a token, a character or a monster can wear instead of an uploaded picture come from [game-icons.net](https://game-icons.net). Icons made by Lorc, Delapouite and the 34 other authors below. Available on https://game-icons.net.

They are taken from the [game-icons/icons](https://github.com/game-icons/icons) repository at commit `82d948812bfe3f269ef8f731dcdb07b08160edc4` by `node scripts/game-icons.ts`, which fetches that commit with git and checks its tree hash before it reads a file. All 4,180 icons ship, in `public/game-icons/82d94881/`. The repository's `badges` folder, 59 badge frames rather than icons, does not. 4,055 icons by 33 authors are licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). 125 icons by Viscious Speed, Zeromancer and Various artists are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): the repository's `license.txt` marks the first two, and the icon pages of Various artists (for example https://game-icons.net/1x1/various-artists/infinity.html) say CC0.

Change to every icon: black background square removed.

With 4,180 files, the list of every file is generated rather than written here: `public/game-icons/82d94881/index.json`, written by the same script, names each author with their license and the names of their icons, and each icon is the file `public/game-icons/82d94881/<folder>/<name>.svg`. The picker credits each icon where it is chosen, as "Wolf head by Lorc, CC BY 3.0".

| Author | Folder | License | Icons | Link |
| --- | --- | --- | --- | --- |
| Andy Meneely | `andymeneely` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 2 | http://www.se.rit.edu/~andy/ |
| Aussiesim | `aussiesim` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 52 | none given |
| Carl Olsen | `carl-olsen` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 6 | https://twitter.com/unstoppableCarl |
| Caro Asercion | `caro-asercion` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 127 | none given |
| Cathelineau | `cathelineau` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 29 | none given |
| Catsu | `catsu` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1 | none given |
| DarkZaitzev | `darkzaitzev` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 32 | http://darkzaitzev.deviantart.com |
| Delapouite | `delapouite` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 2,022 | http://delapouite.com |
| Faithtoken | `faithtoken` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 10 | http://fungustoken.deviantart.com |
| Felbrigg | `felbrigg` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 5 | http://blackdogofdoom.blogspot.co.uk |
| GeneralAce135 | `generalace135` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 2 | none given |
| Guard13007 | `guard13007` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 3 | https://guard13007.com |
| HeavenlyDog | `heavenly-dog` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 2 | http://www.gnomosygoblins.blogspot.com |
| Irongamer | `irongamer` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1 | http://ecesisllc.wix.com/home |
| John Colburn | `john-colburn` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1 | http://ninmunanmu.com |
| John Redman | `john-redman` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 3 | http://www.uniquedicetowers.com |
| Kier Heyl | `kier-heyl` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 3 | none given |
| Lorc | `lorc` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1,429 | http://lorcblog.blogspot.com |
| Lord Berandas | `lord-berandas` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 10 | http://berandas.deviantart.com |
| Lucas | `lucasms` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 5 | none given |
| Pepijn Poolman | `pepijn-poolman` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1 | none given |
| Pierre Leducq | `pierre-leducq` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 3 | none given |
| PriorBlue | `priorblue` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 7 | none given |
| Quoting | `quoting` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 12 | none given |
| Rihlsul | `rihlsul` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 3 | none given |
| Sbed | `sbed` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 95 | http://opengameart.org/content/95-game-icons |
| SeregaCthtuf | `seregacthtuf` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 5 | none given |
| Skoll | `skoll` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 172 | none given |
| Sparker | `sparker` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1 | http://citizenparker.com |
| SpencerDub | `spencerdub` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1 | none given |
| Starseeker | `starseeker` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 1 | none given |
| Various artists | `various-artists` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 2 | none given |
| Viscious Speed | `viscious-speed` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 121 | http://viscious-speed.deviantart.com |
| Willdabeast | `willdabeast` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 7 | http://wjbstories.blogspot.com |
| Zajkonur | `zajkonur` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | 2 | none given |
| Zeromancer | `zeromancer` | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 2 | none given |

## Map builder textures

All are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). `node scripts/textures.ts` downloads each original, checks it against a pinned SHA-256, and writes the tile.

Changes, unless the row says otherwise: downscaled from 1024 x 1024 to 256 x 256 with wraparound edges so the tile still repeats without a seam, then converted to WebP.

| File | Original | Author | Source | Changes |
| --- | --- | --- | --- | --- |
| `public/textures/stone.webp` | Grey Stone Path | Amal Kumar | https://polyhaven.com/a/grey_stone_path | as above |
| `public/textures/wood.webp` | Wood Planks | Amal Kumar | https://polyhaven.com/a/wood_planks | as above |
| `public/textures/grass.webp` | Grass 001 | Lennart Demes ([ambientCG](https://ambientcg.com)) | https://ambientcg.com/view?id=Grass001 | as above, from the color map of the 1K JPG set |
| `public/textures/dirt.webp` | Brown Mud Dry | Rob Tuytel | https://polyhaven.com/a/brown_mud_dry | as above |
| `public/textures/cave.webp` | Rock Ground | Rob Tuytel | https://polyhaven.com/a/rock_ground | as above |
| `public/textures/water.webp` | Liquid_Blue_02, from Mini Texture Pack 3: Liquids | [Screaming Brain Studios](https://screamingbrainstudios.itch.io) | https://opengameart.org/content/140-liquid-textures | converted to WebP from the pack's 256 x 256 PNG |
| `public/textures/difficult.webp` | Forest Leaves 02 | Rob Tuytel | https://polyhaven.com/a/forest_leaves_02 | as above |
| `public/textures/rubble.webp` | Gray Rocks | Dimitrios Savva | https://polyhaven.com/a/gray_rocks | as above |

Poly Haven states its license at https://polyhaven.com/license and ambientCG at https://docs.ambientcg.com/license/. The Screaming Brain Studios pack carries a `License.txt` that releases it under CC0 1.0, and its page says the textures were made from scratch with texture software.

Pit, pillar and stairs have no texture. The builder draws them as symbols in code over a stone floor.

## Map stamps

The map builder's stamps in `public/stamps/` are pictures seen from straight above, in one top-down look: Prime_8's trees and stones with their soft shadow, the Warlock's Gauntlet foliage and village elements, and Poly Haven's furniture and rocks rendered from above. `node scripts/stamps.ts` downloads each original from where its author published it, checks it, and each file it takes from an archive, against a pinned SHA-256, and writes the images and their catalog, `shared/stamps.ts`. None of this art was drawn or generated for the app.

Changes, as the About page states them:

- **Cropped and converted to WebP** (the OpenGameArt sprites). Each sprite is cropped to its art, keeping the art centered in a box of the stamp's footprint shape, and re-encoded as WebP at its own resolution. Only `woodpile-long.webp` needed a box larger than the original canvas, by one transparent row.
- **Rendered from above and converted to WebP** (the Poly Haven models). three.js draws each model straight down with an orthographic camera and a fixed light, and a soft shadow is baked under it. The model keeps its true size, 256 px per 5 ft cell (less for the largest rock, to stay within 512 px), centered in a footprint of its size rounded up to the next quarter cell.

### Trees Top-down fake shadow, by Prime_8

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source: https://opengameart.org/content/trees-top-down-fake-shadow, from the archive `trees_192rez_topDown_png.7z`. Cropped and converted to WebP.

| File | Original |
| --- | --- |
| `public/stamps/tree-1.webp` | `RE_00.png` |
| `public/stamps/tree-2.webp` | `RE_01.png` |
| `public/stamps/tree-3.webp` | `RE_02.png` |
| `public/stamps/tree-4.webp` | `RE_03.png` |
| `public/stamps/tree-5.webp` | `RE_04.png` |
| `public/stamps/tree-6.webp` | `RE_05.png` |
| `public/stamps/tree-7.webp` | `RE_06.png` |
| `public/stamps/tree-8.webp` | `RE_07.png` |
| `public/stamps/tree-9.webp` | `RE_08.png` |
| `public/stamps/tree-10.webp` | `RE_12.png` |

### Simple stones, by Prime_8

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source: https://opengameart.org/content/simple-stones, from the archive `SM_set.zip`. Cropped and converted to WebP.

| File | Original |
| --- | --- |
| `public/stamps/rock-1.webp` | `SM_set/SM_001.png` |
| `public/stamps/rock-2.webp` | `SM_set/SM_002.png` |
| `public/stamps/rock-3.webp` | `SM_set/SM_003.png` |
| `public/stamps/rock-4.webp` | `SM_set/SM_004.png` |
| `public/stamps/rock-5.webp` | `SM_set/SM_005.png` |
| `public/stamps/rock-6.webp` | `SM_set/SM_009.png` |
| `public/stamps/rocks-1.webp` | `SM_set/SM_007.png` |
| `public/stamps/rocks-2.webp` | `SM_set/SM_013.png` |

### Top down foliage collection, by the Warlock's Gauntlet artists

[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Source: https://opengameart.org/content/top-down-foliage-collection, submitted by Liosan, from the archive `foliage.zip`. Attribution as the page asks for it: "Warlock's Gauntlet artists - rAum, jackFlower, DrZoliparia, Neil2D". Cropped and converted to WebP.

| File | Original |
| --- | --- |
| `public/stamps/bush-1.webp` | `foliage1.png` |
| `public/stamps/bush-2.webp` | `foliage2_0.png` |
| `public/stamps/bush-3.webp` | `foliage3_0.png` |
| `public/stamps/bush-4.webp` | `foliage5.png` |
| `public/stamps/bush-5.webp` | `foliage7.png` |
| `public/stamps/ferns-1.webp` | `foliage8.png` |
| `public/stamps/ferns-2.webp` | `foliage9.png` |
| `public/stamps/spiky-plant.webp` | `tree-strange.png` |

### Top down village elements, by the Warlock's Gauntlet artists

[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Source: https://opengameart.org/content/top-down-village-elements, submitted by Liosan, each file downloaded from the page. Attribution as the page asks for it: "Warlock's Gauntlet artists - rAum, jackFlower, DrZoliparia, Neil2D". Cropped and converted to WebP.

| File | Original |
| --- | --- |
| `public/stamps/campfire.webp` | `bonefire_four.png` |
| `public/stamps/campfire-embers.webp` | `bonefire_three.png` |
| `public/stamps/campfire-ashes.webp` | `bonefire_five.png` |
| `public/stamps/woodpile.webp` | `wood_stack_one.png` |
| `public/stamps/woodpile-long.webp` | `wood_stack_big.png` |
| `public/stamps/wheel.webp` | `broken_wheel_1.png` |
| `public/stamps/bucket.webp` | `bucket.png` |

### Poly Haven models

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), as Poly Haven states for every asset at https://polyhaven.com/license. Each stamp is rendered from the model's 1k glTF and textures. Where a model is a set of separate meshes, the stamp is one mesh rendered on its own. Rendered from above and converted to WebP.

| File | Model | Mesh | Author | Source |
| --- | --- | --- | --- | --- |
| `public/stamps/barrel.webp` | Wine Barrel 01 | the whole model | James Ray Cock | https://polyhaven.com/a/wine_barrel_01 |
| `public/stamps/chest.webp` | Treasure Chest | the whole model | Rico Cilliers | https://polyhaven.com/a/treasure_chest |
| `public/stamps/crate.webp` | Wooden Crate 01 | the whole model | James Ray Cock | https://polyhaven.com/a/wooden_crate_01 |
| `public/stamps/table.webp` | Wooden Table 01 | the whole model | Ethan Place | https://polyhaven.com/a/WoodenTable_01 |
| `public/stamps/table-round.webp` | Round Wooden Table 01 | the whole model | Ulan Cabanilla | https://polyhaven.com/a/round_wooden_table_01 |
| `public/stamps/bed.webp` | Gothic Bed 01 | the whole model | Kirill Sannikov | https://polyhaven.com/a/GothicBed_01 |
| `public/stamps/bookshelf.webp` | Wooden Bookshelf Worn | the whole model | Ulan Cabanilla | https://polyhaven.com/a/wooden_bookshelf_worn |
| `public/stamps/fire-pit.webp` | Stone Fire Pit | the whole model | Sebastian Platen | https://polyhaven.com/a/stone_fire_pit |
| `public/stamps/young-pine.webp` | Fir Sapling | `fir_sapling_a` | Rob Tuytel (photography) and Rico Cilliers (modeling) | https://polyhaven.com/a/fir_sapling |
| `public/stamps/mossy-rock-1.webp` | Rock Moss Set 01 | `rock_moss_set_01_rock01` | Kless Gyzen | https://polyhaven.com/a/rock_moss_set_01 |
| `public/stamps/mossy-rock-2.webp` | Rock Moss Set 01 | `rock_moss_set_01_rock04` | Kless Gyzen | https://polyhaven.com/a/rock_moss_set_01 |
| `public/stamps/stone-1.webp` | Namaqualand Boulders 01 | `namaqualand_rocks_01_a` | Greg Zaal (photography) and Jenelle van Heerden (modeling) | https://polyhaven.com/a/namaqualand_boulders_01 |
| `public/stamps/stone-2.webp` | Namaqualand Boulders 01 | `namaqualand_rocks_01_b` | Greg Zaal (photography) and Jenelle van Heerden (modeling) | https://polyhaven.com/a/namaqualand_boulders_01 |

## App icon

`public/icon.svg` was drawn as an SVG for this project. `public/icons/app-192.png`, `public/icons/app-512.png`, `public/icons/app-maskable-512.png` and `public/icons/apple-touch-icon-180.png` are rasterized from it by `node scripts/icons.ts`. It is not third-party art.

## Rules content (SRD 5.2.1)

Condition text, monster stat blocks, area spells, the encounter XP budgets, and the SRD names in the passphrase word list come from the [System Reference Document 5.2.1](https://www.dndbeyond.com/srd) by Wizards of the Coast LLC, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The material was converted to JSON and edited. The required notice is in [`shared/srd/NOTICE.md`](shared/srd/NOTICE.md).

## Safety tools

The X-card in the Menu (`client/features/xcard/`) follows the X-Card by John Stavropoulos, "a card with an X on it that participants in a Simulation or Role-Playing Game can use to edit out anything that makes them uncomfortable with no explanations needed", from [Safety Tools for Simulations and Role-Playing Games](https://tinyurl.com/x-card-rpg), licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). RaccoonVTT uses the card's idea in its own words and ships none of its text.

## Common-password list

The server refuses room passwords found on a list of the 10,000 most common passwords from [SecLists](https://github.com/danielmiessler/SecLists) (`Passwords/Common-Credentials/10k-most-common.txt` at commit `913b327317496d062bcc7cace524aaad8a693be2`, shipped as `server/auth/common-passwords.txt`), used under the MIT License:

```
MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
