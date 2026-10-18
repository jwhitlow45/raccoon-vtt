# Credits

Apart from the raccoon icon, every image RaccoonVTT ships is existing art published under an open license, and none of it is AI generated. Changes to these files are mechanical only: format conversion, resizing, cropping, reducing a line-art map to four gray levels, upscaling pixel art by nearest neighbor, rendering a 3D model from above, and removing a background so an icon can be tinted.

RaccoonVTT's own code is under the GNU Affero General Public License v3.0 (see the README's License section). Everything listed here keeps its own license, named with it.

`shared/credits.ts` holds the same list for the in-app About page. A test (`shared/credits.test.ts`) fails if a file in `public/textures/`, `public/icons/`, `public/stamps/`, `public/starter/` or `public/fonts/` is missing from either one. The token icons are credited by author instead of by file, and the same test fails if a file in `public/game-icons/` is missing from its index or an author in the index is missing from either list.

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

`arrow-down`, `arrow-left`, `arrow-right`, `arrow-up`, `book-open`, `copy-plus`, `crop`, `download`, `eraser`, `external-link`, `eye`, `eye-off`, `focus`, `footprints`, `info`, `lock`, `log-out`, `maximize-2`, `menu`, `minimize-2`, `pencil`, `radar`, `redo-2`, `refresh-cw`, `repeat`, `settings`, `share`, `smartphone`, `trash-2`, `undo-2`, `user-minus`, `users`, `zoom-in`, `zoom-out`.

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

Lucide's license credits the icons it derived from Feather to Feather's own MIT License. Of the icons copied here, these are derived from Feather: `arrow-down`, `arrow-left`, `arrow-right`, `arrow-up`, `download`, `external-link`, `info`, `lock`, `log-out`, `minimize-2`, `share`, `smartphone`, `trash-2`, `zoom-in`, `zoom-out`.

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

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

## Interface font

The app draws its text in [Inter](https://rsms.me/inter/) by The Inter Project Authors, from the [rsms/inter](https://github.com/rsms/inter) repository's release 4.1, used under the [SIL Open Font License 1.1](https://openfontlicense.org/open-font-license-official-text/).

| File | Original |
| --- | --- |
| `public/fonts/InterVariable-8a540aa8.woff2` | `InterVariable.ttf` from `Inter-4.1.zip` |
| `public/fonts/InterVariable-Italic-7e4680fd.woff2` | `InterVariable-Italic.ttf` from `Inter-4.1.zip` |
| `public/fonts/Inter-LICENSE.txt` | `LICENSE.txt` from `Inter-4.1.zip`, unchanged |

Changes: `node scripts/inter.ts` checks the release's zip against a pinned SHA-256, then subsets each variable font to Latin characters (Basic Latin, Latin-1 Supplement, Latin Extended-A, General Punctuation, the arrows and the minus sign) and converts it to WOFF2 with fonttools. Both variation axes, weight and optical size, are kept. The license ships beside the fonts:

```
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
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

<!-- starter-packs: written by node scripts/starter-art.ts -->
## Starter packs

Art a DM can pick from the Starter tab wherever art is chosen (docs/design-v1-starter-art.md): sets from one artist or project in one style, each under its own license. `node scripts/starter-art.ts` downloads every original from where its author published it, checks it against a pinned SHA-256 in `scripts/starter-art.json`, which also records each pack's license in its page's own words, a Wayback snapshot of that page and the check for AI art, and writes the files, their catalog (`shared/starterArt.ts`) and this section. A picked image keeps its work's credit in the room's library.

The files under CC BY-SA licenses (the Illustrated Bestiary and Flare Portrait Pack Number One) are adaptations, resized and re-encoded, and stay under the same CC BY-SA license as their originals. RaccoonVTT's code is a separate work and is not affected.

### Dyson Logos maps, by Dyson Logos

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: https://dysonlogos.blog/maps/commercial-maps/, and each work's own page below. Snapshot of the license: https://web.archive.org/web/20190430123109/https://dysonlogos.blog/maps/commercial-maps/. Credit the author asks for: Cartography by Dyson Logos. Changes: Resized to 4096 px on the long side where larger, reduced to four gray levels and saved as PNG.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/dyson-logos/dy-01.png`, `public/starter/dyson-logos/thumbs/dy-01.webp` | The Wooden Duck Coaching Inn, by Dyson Logos | https://dysonlogos.blog/2019/04/15/duck-inn/ | CC BY 4.0 | Resized from 6960 x 8352 to 3413 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-02.png`, `public/starter/dyson-logos/thumbs/dy-02.webp` | The Twelve Goats Tavern, by Dyson Logos | https://dysonlogos.blog/2019/05/06/12goats/ | CC BY 4.0 | Resized from 6000 x 6000 to 4096 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-03.png`, `public/starter/dyson-logos/thumbs/dy-03.webp` | The Quiet Margose Tavern, by Dyson Logos | https://dysonlogos.blog/2018/06/04/the-quiet-margose-tavern/ | CC BY 4.0 | Resized from 7948 x 9579 to 3399 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-04.png`, `public/starter/dyson-logos/thumbs/dy-04.webp` | Warrek’s Nest, by Dyson Logos | https://dysonlogos.blog/2015/11/06/friday-map-warreks-nest/ | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-05.png`, `public/starter/dyson-logos/thumbs/dy-05.webp` | Robrus Beach Cave, by Dyson Logos | https://dysonlogos.blog/2019/06/03/black-cave/ | CC BY 4.0 | Resized from 7200 x 7200 to 4096 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-06.png`, `public/starter/dyson-logos/thumbs/dy-06.webp` | Old Cruik Hollow, by Dyson Logos | https://dysonlogos.blog/2018/12/07/old-cruik-hollow/ | CC BY 4.0 | Resized from 4344 x 6720 to 2648 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-07.png`, `public/starter/dyson-logos/thumbs/dy-07.webp` | Black Armoury of the Mad King, by Dyson Logos | https://dysonlogos.blog/2019/05/03/armoury/ | CC BY 4.0 | Resized from 5840 x 7200 to 3322 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-08.png`, `public/starter/dyson-logos/thumbs/dy-08.webp` | Vault of the Blue Golem, by Dyson Logos | https://dysonlogos.blog/2019/02/07/vault-of-the-blue-golem/ | CC BY 4.0 | Resized from 8880 x 8016 to 4096 x 3697, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-09.png`, `public/starter/dyson-logos/thumbs/dy-09.webp` | Release the Kraken on the Ruins under Axehead Mound, by Dyson Logos | https://dysonlogos.blog/2018/04/30/release-the-kraken-on-the-ruins-under-axehead-mound/ | CC BY 4.0 | Resized from 9228 x 10400 to 3634 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-10.png`, `public/starter/dyson-logos/thumbs/dy-10.webp` | Temple of the Seven Heretics, by Dyson Logos | https://dysonlogos.blog/2019/03/11/temple-of-the-seven-heretics/ | CC BY 4.0 | Resized from 13200 x 16208 to 3336 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-11.png`, `public/starter/dyson-logos/thumbs/dy-11.webp` | Oratory of the Eleventh Blessing, by Dyson Logos | https://dysonlogos.blog/2018/06/14/oratory-of-the-eleventh-blessing/ | CC BY 4.0 | Resized from 9374 x 6127 to 4096 x 2677, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-12.png`, `public/starter/dyson-logos/thumbs/dy-12.webp` | The Ruins of Charnesse, by Dyson Logos | https://dysonlogos.blog/2019/04/08/the-ruins-of-charnesse/ | CC BY 4.0 | Resized from 8700 x 5700 to 4096 x 2684, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-13.png`, `public/starter/dyson-logos/thumbs/dy-13.webp` | The Toronin Ruins, by Dyson Logos | https://dysonlogos.blog/2018/03/09/the-toronin-ruins/ | CC BY 4.0 | Resized from 15300 x 10920 to 4096 x 2923, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-14.png`, `public/starter/dyson-logos/thumbs/dy-14.webp` | Brenovale Castle, by Dyson Logos | https://dysonlogos.blog/2019/03/08/brenovale-castle/ | CC BY 4.0 | Resized from 11688 x 9096 to 4096 x 3188, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-15.png`, `public/starter/dyson-logos/thumbs/dy-15.webp` | Brentil Tower, by Dyson Logos | https://dysonlogos.blog/2019/01/07/brentil-tower/ | CC BY 4.0 | Resized from 14173 x 6408 to 4096 x 1852, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-16.png`, `public/starter/dyson-logos/thumbs/dy-16.webp` | Release the Kraken on Sanhelter Keep!, by Dyson Logos | https://dysonlogos.blog/2019/04/27/release-the-kraken-on-sanhelter-keep/ | CC BY 4.0 | Resized from 4440 x 6048 to 3007 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-17.png`, `public/starter/dyson-logos/thumbs/dy-17.webp` | Third-Story Run, by Dyson Logos | https://dysonlogos.blog/2018/01/05/third-story-run/ | CC BY 4.0 | Resized from 9643 x 8935 to 4096 x 3795, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-18.png`, `public/starter/dyson-logos/thumbs/dy-18.webp` | Rosnar Hill, by Dyson Logos | https://dysonlogos.blog/2017/12/12/rosnar-hill/ | CC BY 4.0 | Resized from 13232 x 10505 to 4096 x 3252, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-19.png`, `public/starter/dyson-logos/thumbs/dy-19.webp` | Goblins at Herlihy Farm, by Dyson Logos | https://dysonlogos.blog/2018/08/13/goblins-at-herlihy-farm/ | CC BY 4.0 | Resized from 9677 x 12906 to 3071 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-20.png`, `public/starter/dyson-logos/thumbs/dy-20.webp` | Stony Hill, by Dyson Logos | https://dysonlogos.blog/2018/12/10/stony-hill/ | CC BY 4.0 | Resized from 9528 x 9600 to 4065 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-21.png`, `public/starter/dyson-logos/thumbs/dy-21.webp` | the Hollowstone Bandit Camp, by Dyson Logos | https://dysonlogos.blog/2019/01/14/hollowstone/ | CC BY 4.0 | Resized from 10152 x 7488 to 4096 x 3021, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-22.png`, `public/starter/dyson-logos/thumbs/dy-22.webp` | The Wreck of the Wight’s Shadow, by Dyson Logos | https://dysonlogos.blog/2017/11/14/the-wreck-of-the-wights-shadow/ | CC BY 4.0 | Resized from 9372 x 10091 to 3804 x 4096, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-23.png`, `public/starter/dyson-logos/thumbs/dy-23.webp` | Sirenhearth Docks, by Dyson Logos | https://dysonlogos.blog/2017/10/10/sirenhearth-docks/ | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-24.png`, `public/starter/dyson-logos/thumbs/dy-24.webp` | Circle Crypts of the Ophidian Emperor, by Dyson Logos | https://dysonlogos.blog/2018/10/08/circle-crypts-of-the-ophidian-emperor/ | CC BY 4.0 | Resized from 8841 x 8760 to 4096 x 4058, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-25.png`, `public/starter/dyson-logos/thumbs/dy-25.webp` | Lockhart’s Delve, by Dyson Logos | https://dysonlogos.blog/2018/05/03/lockharts-delve/ | CC BY 4.0 | Resized from 10129 x 7039 to 4096 x 2846, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-26.png`, `public/starter/dyson-logos/thumbs/dy-26.webp` | Crypts and Sewers, by Dyson Logos | https://dysonlogos.blog/2016/04/12/crypts-and-sewers/ | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-27.png`, `public/starter/dyson-logos/thumbs/dy-27.webp` | Forgotten Catacombs, by Dyson Logos | https://dysonlogos.blog/2017/07/07/forgotten-catacombs/ | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-28.png`, `public/starter/dyson-logos/thumbs/dy-28.webp` | Hevlod Manor, by Dyson Logos | https://dysonlogos.blog/2018/10/04/hevlod-manor/ | CC BY 4.0 | Resized from 11559 x 8944 to 4096 x 3169, reduced to four gray levels and saved as PNG. |
| `public/starter/dyson-logos/dy-29.png`, `public/starter/dyson-logos/thumbs/dy-29.webp` | Rose Point Manor, by Dyson Logos | https://dysonlogos.blog/2019/02/11/rose-point-manor/ | CC BY 4.0 | Resized from 4776 x 6072 to 3222 x 4096, reduced to four gray levels and saved as PNG. |

### Scarlet Heroes maps, by Dyson Logos, released by Kevin Crawford (Sine Nomine Publishing)

Public domain dedication. Source: https://www.drivethrurpg.com/product/114894/Scarlet-Heroes-Art-Pack. Snapshot of the license: https://web.archive.org/web/20140328035847/http://rpg.drivethrustuff.com:80/product/114894/Scarlet-Heroes-Art-Pack. On credit: Not required. Sine Nomine Publishing asks, as a courtesy, that the artist, Dyson Logos, is credited. Changes: Converted from TIFF, reduced to four gray levels and saved as PNG.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/scarlet-heroes/sh-01.png`, `public/starter/scarlet-heroes/thumbs/sh-01.webp` | Cavern map, by Dyson Logos, from the Scarlet Heroes Art Pack by Sine Nomine Publishing (Kevin Crawford) | https://www.drivethrurpg.com/product/114894/Scarlet-Heroes-Art-Pack | Public domain dedication | Converted from TIFF, reduced to four gray levels and saved as PNG. |
| `public/starter/scarlet-heroes/sh-02.png`, `public/starter/scarlet-heroes/thumbs/sh-02.webp` | Dungeon map, by Dyson Logos, from the Scarlet Heroes Art Pack by Sine Nomine Publishing (Kevin Crawford) | https://www.drivethrurpg.com/product/114894/Scarlet-Heroes-Art-Pack | Public domain dedication | Converted from TIFF, reduced to four gray levels and saved as PNG. |
| `public/starter/scarlet-heroes/sh-03.png`, `public/starter/scarlet-heroes/thumbs/sh-03.webp` | Estate map, by Dyson Logos, from the Scarlet Heroes Art Pack by Sine Nomine Publishing (Kevin Crawford) | https://www.drivethrurpg.com/product/114894/Scarlet-Heroes-Art-Pack | Public domain dedication | Converted from TIFF, reduced to four gray levels and saved as PNG. |
| `public/starter/scarlet-heroes/sh-04.png`, `public/starter/scarlet-heroes/thumbs/sh-04.webp` | Temple map, by Dyson Logos, from the Scarlet Heroes Art Pack by Sine Nomine Publishing (Kevin Crawford) | https://www.drivethrurpg.com/product/114894/Scarlet-Heroes-Art-Pack | Public domain dedication | Converted from TIFF, reduced to four gray levels and saved as PNG. |
| `public/starter/scarlet-heroes/sh-05.png`, `public/starter/scarlet-heroes/thumbs/sh-05.webp` | Village map, by Dyson Logos, from the Scarlet Heroes Art Pack by Sine Nomine Publishing (Kevin Crawford) | https://www.drivethrurpg.com/product/114894/Scarlet-Heroes-Art-Pack | Public domain dedication | Converted from TIFF, reduced to four gray levels and saved as PNG. |

### Index Card Dungeons, by Majcher Arcana (Marc Majcher)

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: https://majcher.itch.io/index-card-dungeon-project. Snapshot of the license: https://web.archive.org/web/20221130064947/https://majcher.itch.io/index-card-dungeon-project. Changes: Reduced to four gray levels and saved as PNG.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/index-card-dungeons/mj-01.png`, `public/starter/index-card-dungeons/thumbs/mj-01.webp` | The Wellspring Cloister, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-02.png`, `public/starter/index-card-dungeons/thumbs/mj-02.webp` | The Sea Door, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-03.png`, `public/starter/index-card-dungeons/thumbs/mj-03.webp` | The Owlbear Pit, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-04.png`, `public/starter/index-card-dungeons/thumbs/mj-04.webp` | The Azure Sanctuary, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-05.png`, `public/starter/index-card-dungeons/thumbs/mj-05.webp` | The Gardens of Nimazad, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-06.png`, `public/starter/index-card-dungeons/thumbs/mj-06.webp` | Temple of the Red Djinn, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-07.png`, `public/starter/index-card-dungeons/thumbs/mj-07.webp` | Stirge Caverns, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-08.png`, `public/starter/index-card-dungeons/thumbs/mj-08.webp` | The Crypts of Larcast, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-09.png`, `public/starter/index-card-dungeons/thumbs/mj-09.webp` | Tulim's Mound, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |
| `public/starter/index-card-dungeons/mj-10.png`, `public/starter/index-card-dungeons/thumbs/mj-10.webp` | West Fenton, from Index Card Dungeon Project, by Majcher Arcana (Marc Majcher) | https://majcher.itch.io/index-card-dungeon-project | CC BY 4.0 | Reduced to four gray levels and saved as PNG. |

### Cavern Battlemap, by Ferrin

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source: https://opengameart.org/content/cavern-battlemap. Snapshot of the license: https://web.archive.org/web/20151023033357/http://opengameart.org:80/content/cavern-battlemap. Changes: Converted to WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/cavern-battlemap/fe-01.webp`, `public/starter/cavern-battlemap/thumbs/fe-01.webp` | Cavern Battlemap, by Ferrin | https://opengameart.org/content/cavern-battlemap | CC0 1.0 | Converted to WebP. |

### Illustrated Bestiary, by Oozejar (Gourdin Konbo Club)

[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Source: https://gourdin-konbo-club.itch.io/illustrated-bestiary. Snapshot of the license: https://web.archive.org/web/20241110011524/https://gourdin-konbo-club.itch.io/illustrated-bestiary. Changes: Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/illustrated-bestiary/oz-01.webp`, `public/starter/illustrated-bestiary/thumbs/oz-01.webp` | Acolyte, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-02.webp`, `public/starter/illustrated-bestiary/thumbs/oz-02.webp` | Bandit, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-03.webp`, `public/starter/illustrated-bestiary/thumbs/oz-03.webp` | Berserker, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-04.webp`, `public/starter/illustrated-bestiary/thumbs/oz-04.webp` | Hooded Men, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-05.webp`, `public/starter/illustrated-bestiary/thumbs/oz-05.webp` | Dwarf, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-06.webp`, `public/starter/illustrated-bestiary/thumbs/oz-06.webp` | Elf, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-07.webp`, `public/starter/illustrated-bestiary/thumbs/oz-07.webp` | Halfling, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-08.webp`, `public/starter/illustrated-bestiary/thumbs/oz-08.webp` | Goblin, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-09.webp`, `public/starter/illustrated-bestiary/thumbs/oz-09.webp` | Hobgoblin, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-10.webp`, `public/starter/illustrated-bestiary/thumbs/oz-10.webp` | Bugbear, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-11.webp`, `public/starter/illustrated-bestiary/thumbs/oz-11.webp` | Kobold, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-12.webp`, `public/starter/illustrated-bestiary/thumbs/oz-12.webp` | Gnoll, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-13.webp`, `public/starter/illustrated-bestiary/thumbs/oz-13.webp` | Ogre, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-14.webp`, `public/starter/illustrated-bestiary/thumbs/oz-14.webp` | Troll, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-15.webp`, `public/starter/illustrated-bestiary/thumbs/oz-15.webp` | Ettin, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-16.webp`, `public/starter/illustrated-bestiary/thumbs/oz-16.webp` | Fire Giant, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-17.webp`, `public/starter/illustrated-bestiary/thumbs/oz-17.webp` | Frost Giant, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-18.webp`, `public/starter/illustrated-bestiary/thumbs/oz-18.webp` | Minotaur, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-19.webp`, `public/starter/illustrated-bestiary/thumbs/oz-19.webp` | Skeleton, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-20.webp`, `public/starter/illustrated-bestiary/thumbs/oz-20.webp` | Zombie, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-21.webp`, `public/starter/illustrated-bestiary/thumbs/oz-21.webp` | Ghoul, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-22.webp`, `public/starter/illustrated-bestiary/thumbs/oz-22.webp` | Ghost, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-23.webp`, `public/starter/illustrated-bestiary/thumbs/oz-23.webp` | Wight, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-24.webp`, `public/starter/illustrated-bestiary/thumbs/oz-24.webp` | Mummy, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-25.webp`, `public/starter/illustrated-bestiary/thumbs/oz-25.webp` | Vampire, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-26.webp`, `public/starter/illustrated-bestiary/thumbs/oz-26.webp` | Lich, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-27.webp`, `public/starter/illustrated-bestiary/thumbs/oz-27.webp` | Shadow, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-28.webp`, `public/starter/illustrated-bestiary/thumbs/oz-28.webp` | Red Dragon, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-29.webp`, `public/starter/illustrated-bestiary/thumbs/oz-29.webp` | Blue Dragon, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-30.webp`, `public/starter/illustrated-bestiary/thumbs/oz-30.webp` | Green Dragon, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-31.webp`, `public/starter/illustrated-bestiary/thumbs/oz-31.webp` | Black Dragon, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-32.webp`, `public/starter/illustrated-bestiary/thumbs/oz-32.webp` | White Dragon, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-33.webp`, `public/starter/illustrated-bestiary/thumbs/oz-33.webp` | Wyvern, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-34.webp`, `public/starter/illustrated-bestiary/thumbs/oz-34.webp` | Owlbear, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-35.webp`, `public/starter/illustrated-bestiary/thumbs/oz-35.webp` | Basilisk, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-36.webp`, `public/starter/illustrated-bestiary/thumbs/oz-36.webp` | Manticore, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-37.webp`, `public/starter/illustrated-bestiary/thumbs/oz-37.webp` | Griffon, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-38.webp`, `public/starter/illustrated-bestiary/thumbs/oz-38.webp` | Harpy, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-39.webp`, `public/starter/illustrated-bestiary/thumbs/oz-39.webp` | Medusa, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-40.webp`, `public/starter/illustrated-bestiary/thumbs/oz-40.webp` | Hydra, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-41.webp`, `public/starter/illustrated-bestiary/thumbs/oz-41.webp` | Mimic, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-42.webp`, `public/starter/illustrated-bestiary/thumbs/oz-42.webp` | Purple Worm, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-43.webp`, `public/starter/illustrated-bestiary/thumbs/oz-43.webp` | Werewolf, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-44.webp`, `public/starter/illustrated-bestiary/thumbs/oz-44.webp` | Eye Of Terror, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-45.webp`, `public/starter/illustrated-bestiary/thumbs/oz-45.webp` | Mind Lasher, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-46.webp`, `public/starter/illustrated-bestiary/thumbs/oz-46.webp` | Gelatinous Ooze, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-47.webp`, `public/starter/illustrated-bestiary/thumbs/oz-47.webp` | Air Elemental, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-48.webp`, `public/starter/illustrated-bestiary/thumbs/oz-48.webp` | Earth Elemental, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-49.webp`, `public/starter/illustrated-bestiary/thumbs/oz-49.webp` | Fire Elemental, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-50.webp`, `public/starter/illustrated-bestiary/thumbs/oz-50.webp` | Water Elemental, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-51.webp`, `public/starter/illustrated-bestiary/thumbs/oz-51.webp` | Iron Construct, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-52.webp`, `public/starter/illustrated-bestiary/thumbs/oz-52.webp` | Gargoyle, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-53.webp`, `public/starter/illustrated-bestiary/thumbs/oz-53.webp` | Treant, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-54.webp`, `public/starter/illustrated-bestiary/thumbs/oz-54.webp` | Dryad, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-55.webp`, `public/starter/illustrated-bestiary/thumbs/oz-55.webp` | Night Hag, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-56.webp`, `public/starter/illustrated-bestiary/thumbs/oz-56.webp` | Hellhound, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-57.webp`, `public/starter/illustrated-bestiary/thumbs/oz-57.webp` | Wolf, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-58.webp`, `public/starter/illustrated-bestiary/thumbs/oz-58.webp` | Grizzly Bear, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-59.webp`, `public/starter/illustrated-bestiary/thumbs/oz-59.webp` | Giant Scorpion, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |
| `public/starter/illustrated-bestiary/oz-60.webp`, `public/starter/illustrated-bestiary/thumbs/oz-60.webp` | Giant Phase Spider, from Illustrated Bestiary, by Oozejar (Gourdin Konbo Club) | https://gourdin-konbo-club.itch.io/illustrated-bestiary | CC BY-SA 4.0 | Resized from 2048 x 2048 to 1024 x 1024 and converted to WebP. |

### Cute Heroes and Monsters, by Justin Nichol

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: https://opengameart.org/content/cute-heroes, and each work's own page below. Snapshot of the license: https://web.archive.org/web/20220522112338/https://opengameart.org/content/cute-heroes. Changes: Resized to 512 px on the long side and converted to WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/cute-heroes/jn-01.webp`, `public/starter/cute-heroes/thumbs/jn-01.webp` | hero_artificer, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-02.webp`, `public/starter/cute-heroes/thumbs/jn-02.webp` | hero_assassin, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-03.webp`, `public/starter/cute-heroes/thumbs/jn-03.webp` | hero_barbarian, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-04.webp`, `public/starter/cute-heroes/thumbs/jn-04.webp` | hero_bard, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-05.webp`, `public/starter/cute-heroes/thumbs/jn-05.webp` | hero_cleric, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-06.webp`, `public/starter/cute-heroes/thumbs/jn-06.webp` | hero_druid, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-07.webp`, `public/starter/cute-heroes/thumbs/jn-07.webp` | hero_monk, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-08.webp`, `public/starter/cute-heroes/thumbs/jn-08.webp` | hero_paladin, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-09.webp`, `public/starter/cute-heroes/thumbs/jn-09.webp` | hero_ranger, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-10.webp`, `public/starter/cute-heroes/thumbs/jn-10.webp` | hero_rogue, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-11.webp`, `public/starter/cute-heroes/thumbs/jn-11.webp` | hero_warlock, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-12.webp`, `public/starter/cute-heroes/thumbs/jn-12.webp` | hero_warlord, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-13.webp`, `public/starter/cute-heroes/thumbs/jn-13.webp` | hero_warrior, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-14.webp`, `public/starter/cute-heroes/thumbs/jn-14.webp` | hero_wizard, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-15.webp`, `public/starter/cute-heroes/thumbs/jn-15.webp` | hero_gunner, from Cute Heroes, by Justin Nichol | https://opengameart.org/content/cute-heroes | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-16.webp`, `public/starter/cute-heroes/thumbs/jn-16.webp` | npc_adventurer, from Cute NPCs, by Justin Nichol | https://opengameart.org/content/cute-npcs | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-17.webp`, `public/starter/cute-heroes/thumbs/jn-17.webp` | npc_dwarf, from Cute NPCs, by Justin Nichol | https://opengameart.org/content/cute-npcs | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-18.webp`, `public/starter/cute-heroes/thumbs/jn-18.webp` | monster_darkapprentice, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-19.webp`, `public/starter/cute-heroes/thumbs/jn-19.webp` | monster_cabalistnun, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-20.webp`, `public/starter/cute-heroes/thumbs/jn-20.webp` | monster_catkinwarlock, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-21.webp`, `public/starter/cute-heroes/thumbs/jn-21.webp` | monster_goblin, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-22.webp`, `public/starter/cute-heroes/thumbs/jn-22.webp` | monster_goblinveteran, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-23.webp`, `public/starter/cute-heroes/thumbs/jn-23.webp` | boss_goblinbigboss, from Cute Boss Monsters, by Justin Nichol | https://opengameart.org/content/cute-boss-monsters | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-24.webp`, `public/starter/cute-heroes/thumbs/jn-24.webp` | monster_orc, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-25.webp`, `public/starter/cute-heroes/thumbs/jn-25.webp` | monster_orcishberserker, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-26.webp`, `public/starter/cute-heroes/thumbs/jn-26.webp` | monster_deepelf, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-27.webp`, `public/starter/cute-heroes/thumbs/jn-27.webp` | monster_deepelfassassin, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-28.webp`, `public/starter/cute-heroes/thumbs/jn-28.webp` | monster_dragonkinknight, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-29.webp`, `public/starter/cute-heroes/thumbs/jn-29.webp` | monster_dragonkinevoker, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-30.webp`, `public/starter/cute-heroes/thumbs/jn-30.webp` | monster_frogling, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-31.webp`, `public/starter/cute-heroes/thumbs/jn-31.webp` | monster_ratling, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-32.webp`, `public/starter/cute-heroes/thumbs/jn-32.webp` | monster_merfolk, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-33.webp`, `public/starter/cute-heroes/thumbs/jn-33.webp` | monster_giant, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-34.webp`, `public/starter/cute-heroes/thumbs/jn-34.webp` | monster_skygiant, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-35.webp`, `public/starter/cute-heroes/thumbs/jn-35.webp` | monster_minotaur, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-36.webp`, `public/starter/cute-heroes/thumbs/jn-36.webp` | monster_centaur, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-37.webp`, `public/starter/cute-heroes/thumbs/jn-37.webp` | monster_medusa, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-38.webp`, `public/starter/cute-heroes/thumbs/jn-38.webp` | monster_naga, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-39.webp`, `public/starter/cute-heroes/thumbs/jn-39.webp` | monster_werewolfcub, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-40.webp`, `public/starter/cute-heroes/thumbs/jn-40.webp` | monster_doppelganger, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-41.webp`, `public/starter/cute-heroes/thumbs/jn-41.webp` | monster_giantspider, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-42.webp`, `public/starter/cute-heroes/thumbs/jn-42.webp` | monster_ooze, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-43.webp`, `public/starter/cute-heroes/thumbs/jn-43.webp` | boss_cinderdragon, from Cute Boss Monsters, by Justin Nichol | https://opengameart.org/content/cute-boss-monsters | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-44.webp`, `public/starter/cute-heroes/thumbs/jn-44.webp` | monster_dragonwhelp, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-45.webp`, `public/starter/cute-heroes/thumbs/jn-45.webp` | monster_skeleton, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-46.webp`, `public/starter/cute-heroes/thumbs/jn-46.webp` | monster_zombie, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-47.webp`, `public/starter/cute-heroes/thumbs/jn-47.webp` | monster_ghoul, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-48.webp`, `public/starter/cute-heroes/thumbs/jn-48.webp` | monster_wight, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-49.webp`, `public/starter/cute-heroes/thumbs/jn-49.webp` | monster_banshee, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-50.webp`, `public/starter/cute-heroes/thumbs/jn-50.webp` | monster_vampire, from Cute Boss Monsters, by Justin Nichol | https://opengameart.org/content/cute-boss-monsters | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-51.webp`, `public/starter/cute-heroes/thumbs/jn-51.webp` | boss_lich, from Cute Boss Monsters, by Justin Nichol | https://opengameart.org/content/cute-boss-monsters | CC BY 4.0 | Converted to WebP. |
| `public/starter/cute-heroes/jn-52.webp`, `public/starter/cute-heroes/thumbs/jn-52.webp` | monster_demilich, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-53.webp`, `public/starter/cute-heroes/thumbs/jn-53.webp` | boss_witchking, from Cute Boss Monsters, by Justin Nichol | https://opengameart.org/content/cute-boss-monsters | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-54.webp`, `public/starter/cute-heroes/thumbs/jn-54.webp` | monster_imp, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-55.webp`, `public/starter/cute-heroes/thumbs/jn-55.webp` | monster_hellion, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-56.webp`, `public/starter/cute-heroes/thumbs/jn-56.webp` | boss_hagmatriarch, from Cute Boss Monsters, by Justin Nichol | https://opengameart.org/content/cute-boss-monsters | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-57.webp`, `public/starter/cute-heroes/thumbs/jn-57.webp` | monster_treefolk, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-58.webp`, `public/starter/cute-heroes/thumbs/jn-58.webp` | boss_defiledspriggan, from Cute Boss Monsters, by Justin Nichol | https://opengameart.org/content/cute-boss-monsters | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-59.webp`, `public/starter/cute-heroes/thumbs/jn-59.webp` | monster_airelemental, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP, its color profile converted to sRGB. |
| `public/starter/cute-heroes/jn-60.webp`, `public/starter/cute-heroes/thumbs/jn-60.webp` | monster_earthelemental, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-61.webp`, `public/starter/cute-heroes/thumbs/jn-61.webp` | monster_fireelemental, from Cute Monsters F-O, by Justin Nichol | https://opengameart.org/content/cute-monsters-f-o | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-62.webp`, `public/starter/cute-heroes/thumbs/jn-62.webp` | monster_waterelemental, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-63.webp`, `public/starter/cute-heroes/thumbs/jn-63.webp` | monster_sanctumguardian, from Cute Monsters P-Z, by Justin Nichol | https://opengameart.org/content/cute-monsters-p-z | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |
| `public/starter/cute-heroes/jn-64.webp`, `public/starter/cute-heroes/thumbs/jn-64.webp` | monster_bonegolem, from Cute Monsters A-E, by Justin Nichol | https://opengameart.org/content/cute-monsters-a-e | CC BY 4.0 | Resized from 1000 x 1000 to 512 x 512 and converted to WebP. |

### Dungeon Crawl Stone Soup monsters, by The Dungeon Crawl Stone Soup developers and artists

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source: https://github.com/crawl/tiles. Snapshot of the license: https://web.archive.org/web/20220309024431/https://github.com/crawl/tiles. On credit: Not required. The tiles' readme asks, as a courtesy, that the developers and artists are credited and the source named. Changes: Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/dcss-monsters/dc-01.webp` | goblin tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-02.webp` | hobgoblin tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-03.webp` | kobold tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-04.webp` | gnoll tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-05.webp` | orc tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-06.webp` | orc_priest tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-07.webp` | ogre tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-08.webp` | iron_troll tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-09.webp` | hill_giant tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-10.webp` | frost_giant tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-11.webp` | fire_giant tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-12.webp` | ettin tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-13.webp` | harpy tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-14.webp` | manticore tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-15.webp` | griffon tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-16.webp` | basilisk tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-17.webp` | wyvern tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-18.webp` | ice_dragon tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-19.webp` | golden_dragon tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-20.webp` | swamp_dragon tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-21.webp` | hydra5 tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-22.webp` | skeletal_warrior tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-23.webp` | ghoul tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-24.webp` | ghost tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-25.webp` | wight tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-26.webp` | vampire tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-27.webp` | lich tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-28.webp` | shadow tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-29.webp` | shadow_wraith tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-30.webp` | great_orb_of_eyes tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-31.webp` | jelly tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-32.webp` | spider tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-33.webp` | scorpion tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-34.webp` | wolf tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-35.webp` | black_bear tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-36.webp` | bat tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-37.webp` | adder tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-38.webp` | anaconda tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-39.webp` | hell_hound tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-40.webp` | quasit tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-41.webp` | red_devil tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-42.webp` | balrug tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-43.webp` | air_elemental tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-44.webp` | earth_elemental tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-45.webp` | fire_elemental tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-46.webp` | water_elemental tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-47.webp` | iron_golem tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-48.webp` | flesh_golem tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-49.webp` | treant tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-50.webp` | dryad tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-51.webp` | merfolk tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-52.webp` | naga tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-53.webp` | angel tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-54.webp` | human tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-55.webp` | dwarf tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-56.webp` | elf tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-57.webp` | halfling tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-58.webp` | necromancer tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-59.webp` | death_knight tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-60.webp` | hell_knight tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |
| `public/starter/dcss-monsters/dc-61.webp` | deep_elf_priest tile, Dungeon Crawl Stone Soup tiles (release Nov-2015), by the Dungeon Crawl Stone Soup developers and artists | https://github.com/crawl/tiles | CC0 1.0 | Upscaled 8 times from 32 x 32 px with nearest neighbor and converted to lossless WebP. |

### Lemurs Fantasy Portraits, by Jon Aspeheim

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: https://jonaspeheim.itch.io/lemurs-portraits. Snapshot of the license: https://web.archive.org/web/20250605083000/https://jonaspeheim.itch.io/lemurs-portraits. Changes: Converted to WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/lemurs-portraits/lm-01.webp`, `public/starter/lemurs-portraits/thumbs/lm-01.webp` | dwarf_05, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-02.webp`, `public/starter/lemurs-portraits/thumbs/lm-02.webp` | dwarf_06, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-03.webp`, `public/starter/lemurs-portraits/thumbs/lm-03.webp` | dwarf_11, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-04.webp`, `public/starter/lemurs-portraits/thumbs/lm-04.webp` | dwarf_04, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-05.webp`, `public/starter/lemurs-portraits/thumbs/lm-05.webp` | dwarf_10, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-06.webp`, `public/starter/lemurs-portraits/thumbs/lm-06.webp` | dwarf_09, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-07.webp`, `public/starter/lemurs-portraits/thumbs/lm-07.webp` | elf_09, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-08.webp`, `public/starter/lemurs-portraits/thumbs/lm-08.webp` | elf_06, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-09.webp`, `public/starter/lemurs-portraits/thumbs/lm-09.webp` | elf_04, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-10.webp`, `public/starter/lemurs-portraits/thumbs/lm-10.webp` | elf_08, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-11.webp`, `public/starter/lemurs-portraits/thumbs/lm-11.webp` | elf_02, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-12.webp`, `public/starter/lemurs-portraits/thumbs/lm-12.webp` | elf_12, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-13.webp`, `public/starter/lemurs-portraits/thumbs/lm-13.webp` | halfling_02, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-14.webp`, `public/starter/lemurs-portraits/thumbs/lm-14.webp` | halfling_03, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-15.webp`, `public/starter/lemurs-portraits/thumbs/lm-15.webp` | halfling_06, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-16.webp`, `public/starter/lemurs-portraits/thumbs/lm-16.webp` | gnome_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-17.webp`, `public/starter/lemurs-portraits/thumbs/lm-17.webp` | gnome_02, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-18.webp`, `public/starter/lemurs-portraits/thumbs/lm-18.webp` | gnome_04, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-19.webp`, `public/starter/lemurs-portraits/thumbs/lm-19.webp` | demon_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-20.webp`, `public/starter/lemurs-portraits/thumbs/lm-20.webp` | demon_02, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-21.webp`, `public/starter/lemurs-portraits/thumbs/lm-21.webp` | cat_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-22.webp`, `public/starter/lemurs-portraits/thumbs/lm-22.webp` | goblin_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-23.webp`, `public/starter/lemurs-portraits/thumbs/lm-23.webp` | goblin_03, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-24.webp`, `public/starter/lemurs-portraits/thumbs/lm-24.webp` | goblin_04, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-25.webp`, `public/starter/lemurs-portraits/thumbs/lm-25.webp` | orc_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-26.webp`, `public/starter/lemurs-portraits/thumbs/lm-26.webp` | orc_02, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-27.webp`, `public/starter/lemurs-portraits/thumbs/lm-27.webp` | orc_03, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-28.webp`, `public/starter/lemurs-portraits/thumbs/lm-28.webp` | skeleton_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-29.webp`, `public/starter/lemurs-portraits/thumbs/lm-29.webp` | zombie_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-30.webp`, `public/starter/lemurs-portraits/thumbs/lm-30.webp` | vampire_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-31.webp`, `public/starter/lemurs-portraits/thumbs/lm-31.webp` | ghost_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-32.webp`, `public/starter/lemurs-portraits/thumbs/lm-32.webp` | ghost_02, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-33.webp`, `public/starter/lemurs-portraits/thumbs/lm-33.webp` | human_01, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-34.webp`, `public/starter/lemurs-portraits/thumbs/lm-34.webp` | human_08, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-35.webp`, `public/starter/lemurs-portraits/thumbs/lm-35.webp` | human_09, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-36.webp`, `public/starter/lemurs-portraits/thumbs/lm-36.webp` | human_11, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-37.webp`, `public/starter/lemurs-portraits/thumbs/lm-37.webp` | human_12, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-38.webp`, `public/starter/lemurs-portraits/thumbs/lm-38.webp` | human_15, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-39.webp`, `public/starter/lemurs-portraits/thumbs/lm-39.webp` | human_17, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-40.webp`, `public/starter/lemurs-portraits/thumbs/lm-40.webp` | human_18, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-41.webp`, `public/starter/lemurs-portraits/thumbs/lm-41.webp` | human_20, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-42.webp`, `public/starter/lemurs-portraits/thumbs/lm-42.webp` | human_21, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-43.webp`, `public/starter/lemurs-portraits/thumbs/lm-43.webp` | human_22, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-44.webp`, `public/starter/lemurs-portraits/thumbs/lm-44.webp` | human_23, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-45.webp`, `public/starter/lemurs-portraits/thumbs/lm-45.webp` | human_25, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-46.webp`, `public/starter/lemurs-portraits/thumbs/lm-46.webp` | human_29, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-47.webp`, `public/starter/lemurs-portraits/thumbs/lm-47.webp` | human_31, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-48.webp`, `public/starter/lemurs-portraits/thumbs/lm-48.webp` | human_32, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-49.webp`, `public/starter/lemurs-portraits/thumbs/lm-49.webp` | human_33, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-50.webp`, `public/starter/lemurs-portraits/thumbs/lm-50.webp` | human_34, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-51.webp`, `public/starter/lemurs-portraits/thumbs/lm-51.webp` | human_36, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-52.webp`, `public/starter/lemurs-portraits/thumbs/lm-52.webp` | human_39, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-53.webp`, `public/starter/lemurs-portraits/thumbs/lm-53.webp` | human_44, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-54.webp`, `public/starter/lemurs-portraits/thumbs/lm-54.webp` | human_45, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-55.webp`, `public/starter/lemurs-portraits/thumbs/lm-55.webp` | human_46, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-56.webp`, `public/starter/lemurs-portraits/thumbs/lm-56.webp` | human_47, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-57.webp`, `public/starter/lemurs-portraits/thumbs/lm-57.webp` | human_48, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |
| `public/starter/lemurs-portraits/lm-58.webp`, `public/starter/lemurs-portraits/thumbs/lm-58.webp` | human_49, from Lemurs Fantasy Portraits, by Jon Aspeheim | https://jonaspeheim.itch.io/lemurs-portraits | CC BY 4.0 | Converted to WebP. |

### Fantasy RPG Portraits, by Joseph Hewitt

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1. Snapshot of the license: https://web.archive.org/web/20200919151336/https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1. Changes: Converted to WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/hewitt-portraits/jh-01.webp`, `public/starter/hewitt-portraits/thumbs/jh-01.webp` | Adventurer, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-02.webp`, `public/starter/hewitt-portraits/thumbs/jh-02.webp` | Armor, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-03.webp`, `public/starter/hewitt-portraits/thumbs/jh-03.webp` | Knight, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-04.webp`, `public/starter/hewitt-portraits/thumbs/jh-04.webp` | Human_007, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-05.webp`, `public/starter/hewitt-portraits/thumbs/jh-05.webp` | Human_006, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-06.webp`, `public/starter/hewitt-portraits/thumbs/jh-06.webp` | Human_002, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-07.webp`, `public/starter/hewitt-portraits/thumbs/jh-07.webp` | Human_003, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-08.webp`, `public/starter/hewitt-portraits/thumbs/jh-08.webp` | Human_001, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-09.webp`, `public/starter/hewitt-portraits/thumbs/jh-09.webp` | Human_004, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-10.webp`, `public/starter/hewitt-portraits/thumbs/jh-10.webp` | Human_005, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-11.webp`, `public/starter/hewitt-portraits/thumbs/jh-11.webp` | Human_008, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-12.webp`, `public/starter/hewitt-portraits/thumbs/jh-12.webp` | Wizard_001, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-13.webp`, `public/starter/hewitt-portraits/thumbs/jh-13.webp` | NatureWitch, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-14.webp`, `public/starter/hewitt-portraits/thumbs/jh-14.webp` | Hood_001, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-15.webp`, `public/starter/hewitt-portraits/thumbs/jh-15.webp` | Hood_002, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-16.webp`, `public/starter/hewitt-portraits/thumbs/jh-16.webp` | Dwarf_001, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-17.webp`, `public/starter/hewitt-portraits/thumbs/jh-17.webp` | Dwarf_002, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-18.webp`, `public/starter/hewitt-portraits/thumbs/jh-18.webp` | Dwarf_003, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-19.webp`, `public/starter/hewitt-portraits/thumbs/jh-19.webp` | Dwarf_004, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-20.webp`, `public/starter/hewitt-portraits/thumbs/jh-20.webp` | Elf_001, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-21.webp`, `public/starter/hewitt-portraits/thumbs/jh-21.webp` | Elf_002, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-22.webp`, `public/starter/hewitt-portraits/thumbs/jh-22.webp` | Elf_003, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-23.webp`, `public/starter/hewitt-portraits/thumbs/jh-23.webp` | Elf_004, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-24.webp`, `public/starter/hewitt-portraits/thumbs/jh-24.webp` | Orc_001, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |
| `public/starter/hewitt-portraits/jh-25.webp`, `public/starter/hewitt-portraits/thumbs/jh-25.webp` | Orc_002, from Joseph Hewitt's Fantasy RPG Portrait Set 1, by Joseph Hewitt | https://opengameart.org/content/joseph-hewitts-fantasy-rpg-portrait-set-1 | CC BY 4.0 | Converted to WebP. |

### Flare Hero Portraits, by Justin Nichol, for the Flare project

[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) and [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Source: https://opengameart.org/content/flare-portrait-pack-number-one, and each work's own page below. Snapshot of the license: https://web.archive.org/web/20220527190632/https://opengameart.org/content/flare-portrait-pack-number-one. Changes: Resized to 1024 px on the long side where larger and converted to WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/flare-portraits/fl-01.webp`, `public/starter/flare-portraits/thumbs/fl-01.webp` | FlareMaleHero1, from Flare Portrait Pack (Number One), by Justin Nichol | https://opengameart.org/content/flare-portrait-pack-number-one | CC BY-SA 3.0 | Resized from 2400 x 2400 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-02.webp`, `public/starter/flare-portraits/thumbs/fl-02.webp` | FlareMaleHero2, from Flare Portrait Pack (Number One), by Justin Nichol | https://opengameart.org/content/flare-portrait-pack-number-one | CC BY-SA 3.0 | Resized from 2400 x 2400 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-03.webp`, `public/starter/flare-portraits/thumbs/fl-03.webp` | FlareMaleHero3, from Flare Portrait Pack (Number One), by Justin Nichol | https://opengameart.org/content/flare-portrait-pack-number-one | CC BY-SA 3.0 | Resized from 2400 x 2400 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-04.webp`, `public/starter/flare-portraits/thumbs/fl-04.webp` | FlareFemaleHero1, from Flare Portrait Pack (Number One), by Justin Nichol | https://opengameart.org/content/flare-portrait-pack-number-one | CC BY-SA 3.0 | Resized from 2400 x 2400 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-05.webp`, `public/starter/flare-portraits/thumbs/fl-05.webp` | FlareFemaleHero2, from Flare Portrait Pack (Number One), by Justin Nichol | https://opengameart.org/content/flare-portrait-pack-number-one | CC BY-SA 3.0 | Resized from 2400 x 2400 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-06.webp`, `public/starter/flare-portraits/thumbs/fl-06.webp` | FlareFemaleHero3, from Flare Portrait Pack (Number One), by Justin Nichol | https://opengameart.org/content/flare-portrait-pack-number-one | CC BY-SA 3.0 | Resized from 2400 x 2400 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-07.webp`, `public/starter/flare-portraits/thumbs/fl-07.webp` | FlareFemale3, from Flare Portrait Pack (Female Edition), by Justin Nichol and the Flare Project | https://opengameart.org/content/flare-portrait-pack-female-edition | CC BY 3.0 | Resized from 2000 x 2000 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-08.webp`, `public/starter/flare-portraits/thumbs/fl-08.webp` | FlareFemale4, from Flare Portrait Pack (Female Edition), by Justin Nichol and the Flare Project | https://opengameart.org/content/flare-portrait-pack-female-edition | CC BY 3.0 | Resized from 2000 x 2000 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-09.webp`, `public/starter/flare-portraits/thumbs/fl-09.webp` | FlareFemale5, from Flare Portrait Pack (Female Edition), by Justin Nichol and the Flare Project | https://opengameart.org/content/flare-portrait-pack-female-edition | CC BY 3.0 | Resized from 2000 x 2000 to 1024 x 1024 and converted to WebP. |
| `public/starter/flare-portraits/fl-10.webp`, `public/starter/flare-portraits/thumbs/fl-10.webp` | FlareFemale6, from Flare Portrait Pack (Female Edition), by Justin Nichol and the Flare Project | https://opengameart.org/content/flare-portrait-pack-female-edition | CC BY 3.0 | Resized from 2000 x 2000 to 1024 x 1024 and converted to WebP. |

### Warlock's Gauntlet: ruins, wrecks, bones and woods, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan

[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Source: https://opengameart.org/content/top-down-dead-things, and each work's own page below. Snapshot of the license: https://web.archive.org/web/20130926121620/http://opengameart.org/content/top-down-dead-things. Credit the author asks for: Warlock's Gauntlet artists - rAum, jackFlower, DrZoliparia, Neil2D. Changes: Cropped and converted to WebP.

| File | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/stamps/wg-monster-skeleton.webp` | beast_skeleton, from Top down dead things, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-dead-things | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-giant-skull.webp` | beast_skull_two, from Top down dead things, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-dead-things | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-giant-skull-mossy.webp` | beast_skull_one, from Top down dead things, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-dead-things | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-beast-skeleton-lying.webp` | desert_skeleton_002, from Top down dead things, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-dead-things | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-skeleton.webp` | skeleton_10, from Top down dead things, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-dead-things | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-scattered-bones.webp` | bones, from Top down dead things, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-dead-things | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-fallen-tree.webp` | trunk_one, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-log.webp` | trunk_two, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-mossy-log.webp` | trunk_three, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-giant-fallen-tree.webp` | trunk_large, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-broken-tree.webp` | tree_broken, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-stump.webp` | tree_bark_one, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-two-stumps.webp` | tree_bark_two, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-grassy-mound-with-burrow.webp` | bush_whole, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-grass-patch.webp` | bush_3, from Top down pixerly tree trunks and bushes, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-pixerly-tree-trunks-and-bushes | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-ruined-hut.webp` | cote_broken_one_0, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-ruined-hut-2.webp` | cote_broken_two, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-damaged-hut.webp` | cote_one, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-ruined-shed.webp` | shed_broken_two, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-collapsed-shed.webp` | shed_crash_two_0, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-longboat.webp` | ship_three, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-shipwreck-small.webp` | ship_two, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-shipwreck-overgrown.webp` | ship_one, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-shipwreck-broken-in-two.webp` | ship_crash_wreck, from Top down ruined buildings and shipwrecks, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-ruined-buildings-and-shipwrecks | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-campfire-unlit.webp` | bonefire_one, from Top down village elements, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-village-elements | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-fire-ring-empty.webp` | bonefire_two, from Top down village elements, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-village-elements | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-dead-tree-1.webp` | deadtree1_0, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-dead-tree-2.webp` | deadtree2, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-dead-tree-3.webp` | deadtree3, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-palm-tree-1.webp` | palmtree1, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-palm-tree-2.webp` | palmtree3, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-palm-tree-3.webp` | palmtree4, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-palm-tree-4.webp` | palmtree6, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-leafy-tree-1.webp` | tree1_4, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-leafy-tree-2.webp` | tree3, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-leafy-tree-3.webp` | tree6, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-leafy-tree-4.webp` | tree9, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-thicket-1.webp` | foliage4, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-thicket-2.webp` | foliage6, from Top down foliage collection, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-foliage-collection | CC BY 3.0 | Cropped and converted to WebP. |
| `public/stamps/wg-pond.webp` | oasis01, from Top down animated oasis, by Warlock's Gauntlet artists (rAum, jackFlower, DrZoliparia, Neil2D), submitted by Liosan | https://opengameart.org/content/top-down-animated-oasis | CC BY 3.0 | Cropped and converted to WebP. |

### Poly Haven props, by Poly Haven's artists, named per model

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source: https://polyhaven.com/license, and each work's own page below. Snapshot of the license: https://web.archive.org/web/20210721090702/https://polyhaven.com/license. Changes: Rendered from above and converted to WebP.

| File | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/stamps/ph-bench.webp` | Painted Wooden Bench, by Kirill Sannikov | https://polyhaven.com/a/painted_wooden_bench | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-settle.webp` | Painted Wooden Sofa, by Kirill Sannikov | https://polyhaven.com/a/painted_wooden_sofa | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-high-backed-chair.webp` | Wooden Chair 01, by Jake Mobley | https://polyhaven.com/a/WoodenChair_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-armchair.webp` | Green Chair 01, by Kirill Sannikov | https://polyhaven.com/a/GreenChair_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-rocking-chair.webp` | Rockingchair 01, by Jorge Camacho | https://polyhaven.com/a/Rockingchair_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-ladder-back-chair.webp` | Painted Wooden Chair 02, by Kirill Sannikov | https://polyhaven.com/a/painted_wooden_chair_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-box-chair.webp` | Gallinera Chair, by Ulan Cabanilla | https://polyhaven.com/a/gallinera_chair | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-stool.webp` | Wooden Stool 01, by Kuutti Siitonen | https://polyhaven.com/a/wooden_stool_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-camp-stool.webp` | Folding Wooden Stool, by Ulan Cabanilla | https://polyhaven.com/a/folding_wooden_stool | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-square-stool.webp` | Painted Wooden Stool, by Kirill Sannikov | https://polyhaven.com/a/painted_wooden_stool | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-long-table.webp` | Painted Wooden Table, by Kirill Sannikov | https://polyhaven.com/a/painted_wooden_table | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-table-with-benches.webp` | Wooden Picnic Table, by Ulan Cabanilla | https://polyhaven.com/a/wooden_picnic_table | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-carved-square-table.webp` | Gothic Coffee Table, by Ulan Cabanilla | https://polyhaven.com/a/gothic_coffee_table | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-small-round-table.webp` | Round Wooden Table 02, by Ulan Cabanilla | https://polyhaven.com/a/round_wooden_table_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-small-table.webp` | Wooden Table 02, by Serhii Khromov | https://polyhaven.com/a/wooden_table_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-low-table.webp` | Gallinera Table, by Ulan Cabanilla | https://polyhaven.com/a/gallinera_table | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-broken-barrel.webp` | Wooden Barrels 01, by James Ray Cock | https://polyhaven.com/a/wooden_barrels_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-long-crate.webp` | Wooden Crate 02, by James Ray Cock (modeling) and Jurita Burger (graphic design) | https://polyhaven.com/a/wooden_crate_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-wooden-bucket.webp` | Wooden Bucket 01, by James Ray Cock | https://polyhaven.com/a/wooden_bucket_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-washtub.webp` | Wooden Bucket 02, by James Ray Cock | https://polyhaven.com/a/wooden_bucket_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-basket.webp` | Wicker Basket 01, by Kuutti Siitonen | https://polyhaven.com/a/wicker_basket_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-lidded-basket.webp` | Wicker Basket 02, by Kuutti Siitonen | https://polyhaven.com/a/wicker_basket_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-iron-bed-frame.webp` | Old Bed Frame, by Luca B | https://polyhaven.com/a/old_bed_frame | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-candelabra.webp` | Brass Candleholders, by Tina | https://polyhaven.com/a/brass_candleholders | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-candlestick.webp` | Wooden Candlestick, by Josh Dean | https://polyhaven.com/a/wooden_candlestick | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-lantern.webp` | Wooden Lantern 01, by James Ray Cock | https://polyhaven.com/a/wooden_lantern_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-brass-pot.webp` | Brass Pot 01, by Rico Cilliers | https://polyhaven.com/a/brass_pot_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-stew-pot.webp` | Ceramic Pot, by Aron Łyczek | https://polyhaven.com/a/ceramic_pot | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-goblets.webp` | Brass Goblets, by Tina | https://polyhaven.com/a/brass_goblets | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-statue.webp` | Gothic Statue, by Benny Weimer | https://polyhaven.com/a/gothic_statue | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-chessboard.webp` | Chess Set, by Riley Queen | https://polyhaven.com/a/chess_set | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-cannon.webp` | Cannon 01, by Yann Kervran (Rigging) and James Ray Cock (Modeling & Texturing) | https://polyhaven.com/a/cannon_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-pier-section.webp` | Modular Wooden Pier, by Rico Cilliers | https://polyhaven.com/a/modular_wooden_pier | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-mossy-stump.webp` | Tree Stump 01, by Rob Tuytel | https://polyhaven.com/a/tree_stump_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-wide-stump.webp` | Tree Stump 02, by Rob Tuytel | https://polyhaven.com/a/tree_stump_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-thin-log.webp` | Dead Tree Trunk, by Rob Tuytel | https://polyhaven.com/a/dead_tree_trunk | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-fallen-trunk.webp` | Dead Tree Trunk 02, by Jenelle van Heerden (Photography) and Rico Cilliers (processing) | https://polyhaven.com/a/dead_tree_trunk_02 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-root-mound.webp` | Root Cluster 01, by Jenelle van Heerden (Photography) and Rico Cilliers (photography, processing) | https://polyhaven.com/a/root_cluster_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-boulder.webp` | Boulder 01, by Rico Cilliers | https://polyhaven.com/a/boulder_01 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-large-boulder-1.webp` | Namaqualand Boulder 03, by Jenelle van Heerden (modeling) and Dario Barresi (Photography) | https://polyhaven.com/a/namaqualand_boulder_03 | CC0 1.0 | Rendered from above and converted to WebP. |
| `public/stamps/ph-large-boulder-2.webp` | Namaqualand Boulder 04, by Jenelle van Heerden | https://polyhaven.com/a/namaqualand_boulder_04 | CC0 1.0 | Rendered from above and converted to WebP. |

### Flat greyscale props, by Mark Gosbell

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source: https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets, and each work's own page below. Snapshot of the license: https://web.archive.org/web/20210422204341/https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets. On credit: Optional: created by Mark Gosbell. Changes: Converted to WebP.

| File | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/stamps/gb-barrel.webp` | barrel1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-barrel-open.webp` | barreltwo1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-crate.webp` | crate1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-crate-2.webp` | cratetwo1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-open-crate.webp` | opencrate1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-chest.webp` | chest1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-chest-dark.webp` | chesttwo1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-sack.webp` | sack1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-sack-2.webp` | sacktwo1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-pot.webp` | pot1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-treasure-pile.webp` | treasurepile1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-treasure-hoard.webp` | treasurepile2x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-table.webp` | table1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-long-table.webp` | table1x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-long-table-rough.webp` | table1x2-rough, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-round-table.webp` | TableCircle1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-round-table-large.webp` | tableCircleRough2x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-chair.webp` | Chair1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-bed.webp` | bed1x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-bed-unmade.webp` | bedtwo1x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-double-bed.webp` | beddouble2x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-bathtub.webp` | bath1x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-bookcase.webp` | bookcase1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-dresser.webp` | dresser1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-hay-bales.webp` | hay2x2, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-campfire.webp` | campfire1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-round-pit.webp` | Pitcircle1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-square-pit.webp` | Pit1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-stairs-down.webp` | stairs1x1, from 70+ Free Flat Greyscale Dungeon Assets, by Mark Gosbell | https://markgosbell.itch.io/70-free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-spiral-stairs.webp` | stairspiral-1x1, from Free Flat Greyscale Dungeon Assets 2, by Mark Gosbell | https://markgosbell.itch.io/free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-ritual-star.webp` | star-2x2, from Free Flat Greyscale Dungeon Assets 2, by Mark Gosbell | https://markgosbell.itch.io/free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-slime-pool.webp` | goopblood-2x2, from Free Flat Greyscale Dungeon Assets 2, by Mark Gosbell | https://markgosbell.itch.io/free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-floor-crack.webp` | crack-2x2, from Free Flat Greyscale Dungeon Assets 2, by Mark Gosbell | https://markgosbell.itch.io/free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-woven-rug.webp` | rug-2x2, from Free Flat Greyscale Dungeon Assets 2, by Mark Gosbell | https://markgosbell.itch.io/free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-round-rug.webp` | rug3-2x2, from Free Flat Greyscale Dungeon Assets 2, by Mark Gosbell | https://markgosbell.itch.io/free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-bordered-rug.webp` | rug4-2x2, from Free Flat Greyscale Dungeon Assets 2, by Mark Gosbell | https://markgosbell.itch.io/free-flat-greyscale-dungeon-assets | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-tent.webp` | tent-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-round-tent.webp` | Teepee-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-plank-bridge.webp` | Bridge-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-log.webp` | log-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-stump.webp` | Stump-1x1, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-large-rock.webp` | Rock-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-rock.webp` | Rock4-1x1, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-bush.webp` | Bush1-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-bush-spiky.webp` | Bush3-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-hole.webp` | hole-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-chasm.webp` | deepcrack-4x4, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-mushrooms.webp` | mushroom1-1x1, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-flowers.webp` | flowers1-1x1, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |
| `public/stamps/gb-fern.webp` | plant3-2x2, from 50 Free Nature Assets Flat Greyscale, by Mark Gosbell | https://markgosbell.itch.io/50-free-nature-assets-flat-greyscale | CC0 1.0 | Converted to WebP. |

### Historical art, by Various artists, from the open access collections of the Art Institute of Chicago and the Cleveland Museum of Art

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). Source: https://www.artic.edu/open-access/open-access-images, and each work's own page below. Snapshot of the license: https://web.archive.org/web/20260912052826/https://www.artic.edu/open-access/open-access-images. Changes: Resized to 1600 px on the long side where larger and converted to WebP.

| Files | Work | Source | License | Changes |
| --- | --- | --- | --- | --- |
| `public/starter/historical-art/p-01.webp`, `public/starter/historical-art/thumbs/p-01.webp` | Michele Tosini (Michele di Ridolfo; Italian, 1503–1577). Portrait of a Lady, c. 1555. The Art Institute of Chicago. | https://www.artic.edu/artworks/111639/portrait-of-a-lady | CC0 1.0 | Resized from 1686 x 2184 to 1235 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-02.webp`, `public/starter/historical-art/thumbs/p-02.webp` | Bartolomeo Veneto (Italian, 1531). Portrait of a Man, c. 1510s. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1940.539 | CC0 1.0 | Resized from 2485 x 3400 to 1169 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-03.webp`, `public/starter/historical-art/thumbs/p-03.webp` | Unknown artist (India, Mughal, 18th century). Oval portrait of a woman in a Chaghtai hat, c. 1740–50. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1920.1967 | CC0 1.0 | Resized from 2835 x 3400 to 1081 x 1296 and converted to WebP. |
| `public/starter/historical-art/p-05.webp`, `public/starter/historical-art/thumbs/p-05.webp` | Unknown artist (China, Ming dynasty (1368-1644) - Qing dynasty (1644-1911)). Portrait of an Official, 1600s–1700s. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1982.35 | CC0 1.0 | Resized from 2151 x 3400 to 1012 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-07.webp`, `public/starter/historical-art/thumbs/p-07.webp` | Tanzio da Varallo (Italian, c. 1575/80–1635). Portrait of a Man, c. 1620. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1985.143 | CC0 1.0 | Resized from 2515 x 3400 to 1184 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-08.webp`, `public/starter/historical-art/thumbs/p-08.webp` | Rembrandt van Rijn (Dutch, 1606–1669). Old Man with a Gold Chain, 1631. The Art Institute of Chicago. | https://www.artic.edu/artworks/95998/old-man-with-a-gold-chain | CC0 1.0 | Resized from 1686 x 1837 to 1468 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-10.webp`, `public/starter/historical-art/thumbs/p-10.webp` | Utagawa Kuniyoshi, Japanese, 1797-1861. Hu Sanniang (Ko Sanjo Ichijosei), from the series "One Hundred and Eight Heroes of the Popular Water Margin (Tsuzoku Suikoden goketsu hyakuhachinin no hitori)", c. 1827/30. The Art Institute of Chicago. | https://www.artic.edu/artworks/130719/hu-sanniang-ko-sanjo-ichijosei-from-the-series-one-hundred-and-eight-heroes-of-the-popular-water-margin-tsuzoku-suikoden-goketsu-hyakuhachinin-no-hitori | CC0 1.0 | Resized from 1686 x 2479 to 793 x 1166 and converted to WebP. |
| `public/starter/historical-art/p-12.webp`, `public/starter/historical-art/thumbs/p-12.webp` | Giovanni Domenico Tiepolo (Italian, 1727–1804). Head of a Philosopher, 1758–64. The Art Institute of Chicago. | https://www.artic.edu/artworks/90024/head-of-a-philosopher | CC0 1.0 | Resized from 1686 x 2178 to 1239 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-13.webp`, `public/starter/historical-art/thumbs/p-13.webp` | Utagawa Kuniyoshi, Japanese, 1797–1861. Wu Yong (Chitasei Goyo), from the series "One Hundred and Eight Heroes of the Popular Water Margin (Tsuzoku Suikoden goketsu hyakuhachinin no hitori)", c. 1827/30. The Art Institute of Chicago. | https://www.artic.edu/artworks/60462/wu-yong-chitasei-goyo-from-the-series-one-hundred-and-eight-heroes-of-the-popular-water-margin-tsuzoku-suikoden-goketsu-hyakuhachinin-no-hitori | CC0 1.0 | Resized from 1686 x 2446 to 993 x 1440 and converted to WebP. |
| `public/starter/historical-art/p-18.webp`, `public/starter/historical-art/thumbs/p-18.webp` | Unknown artist (France, Provence, 15th century). Portrait of a Man, c. 1450. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1916.811 | CC0 1.0 | Resized from 2585 x 3400 to 1216 x 1600 and converted to WebP, its color profile converted to sRGB. |
| `public/starter/historical-art/p-20.webp`, `public/starter/historical-art/thumbs/p-20.webp` | Gustave Courbet (French, 1819–1877). Mère Grégoire, 1855, reworked 1857–59. The Art Institute of Chicago. | https://www.artic.edu/artworks/4428/mere-gregoire | CC0 1.0 | Resized from 1686 x 2257 to 1195 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-21.webp`, `public/starter/historical-art/thumbs/p-21.webp` | Dirck van Baburen (Dutch, c. 1595–1624). Violin Player with a Wine Glass, 1623. The Cleveland Museum of Art. | https://www.clevelandart.org/art/2018.25 | CC0 1.0 | Resized from 2855 x 3400 to 1344 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-24.webp`, `public/starter/historical-art/thumbs/p-24.webp` | Unknown artist (India, Deccan, 17th century). An African lyre player, c. 1640–60. The Cleveland Museum of Art. | https://www.clevelandart.org/art/2013.289.a | CC0 1.0 | Resized from 2438 x 3400 to 1147 x 1600 and converted to WebP. |
| `public/starter/historical-art/p-28.webp`, `public/starter/historical-art/thumbs/p-28.webp` | Samuel Lovett Waldo (American, 1783–1861). "Old Pat," The Independent Beggar, c. 1819. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1916.998 | CC0 1.0 | Resized from 2593 x 3400 to 1220 x 1600 and converted to WebP. |
| `public/starter/historical-art/c-01.webp`, `public/starter/historical-art/thumbs/c-01.webp` | Kamisaka Sekka (Japanese, 1866–1942). Flowers of a Hundred Worlds (Momoyogusa): Dragon (Ryū), 1909–10. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1988.23.3.7 | CC0 1.0 | Resized from 3400 x 2310 to 1600 x 1087 and converted to WebP. |
| `public/starter/historical-art/c-02.webp`, `public/starter/historical-art/thumbs/c-02.webp` | Arthur Rackham (British, 1867–1939). The Green Dragon, 1910. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1954.652 | CC0 1.0 | Resized from 2327 x 3400 to 887 x 1296 and converted to WebP. |
| `public/starter/historical-art/c-09.webp`, `public/starter/historical-art/thumbs/c-09.webp` | Totoya Hokkei Japanese, 1780-1850. Raiko (Minamoto no Yorimitsu) and the demon kite, c. 1825. The Art Institute of Chicago. | https://www.artic.edu/artworks/81011/raiko-minamoto-no-yorimitsu-and-the-demon-kite | CC0 1.0 | Resized from 1686 x 1935 to 1129 x 1296 and converted to WebP. |
| `public/starter/historical-art/c-14.webp`, `public/starter/historical-art/thumbs/c-14.webp` | Katsushika Hokusai 葛飾 北斎 (Japanese, 1760-1849). Kohada Koheiji, from the series "One Hundred Ghost Tales (Hyaku monogatari)", 1831-32. The Art Institute of Chicago. | https://www.artic.edu/artworks/47398/kohada-koheiji-from-the-series-one-hundred-ghost-tales-hyaku-monogatari | CC0 1.0 | Resized from 1686 x 2345 to 1035 x 1440 and converted to WebP. |
| `public/starter/historical-art/c-15.webp`, `public/starter/historical-art/thumbs/c-15.webp` | Katsushika Hokusai 葛飾 北斎 (Japanese, 1760-1849). Oiwa (Oiwa-san), from the series "One Hundred Ghost Tales (Hyaku monogatari)", 1831-32. The Art Institute of Chicago. | https://www.artic.edu/artworks/47403/oiwa-oiwa-san-from-the-series-one-hundred-ghost-tales-hyaku-monogatari | CC0 1.0 | Resized from 1686 x 2263 to 1192 x 1600 and converted to WebP. |
| `public/starter/historical-art/c-16.webp`, `public/starter/historical-art/thumbs/c-16.webp` | Katsushika Hokusai 葛飾 北斎 (Japanese, 1760-1849). The Mansion of the Plates (Sara yashiki), from the series "One Hundred Ghost Tales (Hyaku monogatari)", 1831-32. The Art Institute of Chicago. | https://www.artic.edu/artworks/47407/the-mansion-of-the-plates-sara-yashiki-from-the-series-one-hundred-ghost-tales-hyaku-monogatari | CC0 1.0 | Resized from 1686 x 2298 to 1057 x 1440 and converted to WebP. |
| `public/starter/historical-art/c-17.webp`, `public/starter/historical-art/thumbs/c-17.webp` | Katsukawa Shunsho 勝川 春章 (Japanese, 1726-1792). Ichikawa Danjūrō V as a Skeleton, Spirit of the Renegade Monk Seigen, and Iwai Hanshirō IV as the Cherry Princess, in “Flower of Edo: An Ichikawa Saga” (Edo no Hana Mimasu Soga), c.1783. The Art Institute of Chicago. | https://www.artic.edu/artworks/88304/ichikawa-danjur%C5%8D-v-as-a-skeleton-spirit-of-the-renegade-monk-seigen-and-iwai-hanshir%C5%8D-iv-as-the-cherry-princess-in-flower-of-edo-an-ichikawa-saga-edo-no-hana-mimasu-soga | CC0 1.0 | Resized from 1686 x 1825 to 1197 x 1296 and converted to WebP. |
| `public/starter/historical-art/c-19.webp`, `public/starter/historical-art/thumbs/c-19.webp` | Martin Schongauer (German, c. 1450–1491). The Griffin, c. 1480–90. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1926.466 | CC0 1.0 | Resized from 3135 x 3400 to 1195 x 1296 and converted to WebP, its color profile converted to sRGB. |
| `public/starter/historical-art/c-20.webp`, `public/starter/historical-art/thumbs/c-20.webp` | Odilon Redon French, 1840-1916. Spider, 1887. The Art Institute of Chicago. | https://www.artic.edu/artworks/79406/spider | CC0 1.0 | Resized from 1686 x 2191 to 1231 x 1600 and converted to WebP. |
| `public/starter/historical-art/c-21.webp`, `public/starter/historical-art/thumbs/c-21.webp` | Charles Meryon (French, 1821-1868) printed by Auguste Delâtre (French, 1822-1907). The Vampire, 1853. The Art Institute of Chicago. | https://www.artic.edu/artworks/28824/the-vampire | CC0 1.0 | Resized from 1686 x 2296 to 1175 x 1600 and converted to WebP. |
| `public/starter/historical-art/l-01.webp`, `public/starter/historical-art/thumbs/l-01.webp` | Attributed to Domenico Gargiulo (Micco Spadaro; Italian, 1609–1675). Landscape with Rock and Fortress, c. 1645. The Art Institute of Chicago. | https://www.artic.edu/artworks/8097/landscape-with-rock-and-fortress | CC0 1.0 | Resized from 1686 x 1066 to 1600 x 1012 and converted to WebP. |
| `public/starter/historical-art/l-03.webp`, `public/starter/historical-art/thumbs/l-03.webp` | Frederic Edwin Church (American, 1826–1900). The Monastery of San Pedro (Our Lady of the Snows), 1879. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1915.684 | CC0 1.0 | Resized from 3400 x 2186 to 1600 x 1029 and converted to WebP. |
| `public/starter/historical-art/l-07.webp`, `public/starter/historical-art/thumbs/l-07.webp` | Giovanni Battista Piranesi Italian, 1720-1778. The Drawbridge, plate 7 from Imaginary Prisons, 1761. The Art Institute of Chicago. | https://www.artic.edu/artworks/7358/the-drawbridge-plate-7-from-imaginary-prisons | CC0 1.0 | Resized from 1686 x 2252 to 1078 x 1440 and converted to WebP. |
| `public/starter/historical-art/l-09.webp`, `public/starter/historical-art/thumbs/l-09.webp` | Pietro di Gottardo Gonzaga Italian, 1751-1831. Subterranean Mausoleum, 1780/1790. The Art Institute of Chicago. | https://www.artic.edu/artworks/74182/subterranean-mausoleum | CC0 1.0 | Resized from 1686 x 1239 to 1440 x 1058 and converted to WebP. |
| `public/starter/historical-art/l-12.webp`, `public/starter/historical-art/thumbs/l-12.webp` | Arnold Böcklin (Swiss, 1827–1901). Ruin by the Sea, 1881. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1979.57 | CC0 1.0 | Resized from 2498 x 3400 to 1176 x 1600 and converted to WebP, its color profile converted to sRGB. |
| `public/starter/historical-art/l-14.webp`, `public/starter/historical-art/thumbs/l-14.webp` | Gustave Doré (French, 1832–1883). Alpine Scene, 1865. The Art Institute of Chicago. | https://www.artic.edu/artworks/28146/alpine-scene | CC0 1.0 | Resized from 1504 x 2250 to 963 x 1440 and converted to WebP. |
| `public/starter/historical-art/l-16.webp`, `public/starter/historical-art/thumbs/l-16.webp` | Albert Bierstadt (American, born Prussia [now Germany], 1830–1902). Mount Vesuvius at Midnight, 1868. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1949.541 | CC0 1.0 | Resized from 3400 x 2394 to 1600 x 1127 and converted to WebP. |
| `public/starter/historical-art/l-19.webp`, `public/starter/historical-art/thumbs/l-19.webp` | Adriaen van Ostade (Dutch, 1610–1685). Merrymakers in an Inn, 1674. The Art Institute of Chicago. | https://www.artic.edu/artworks/117476/merrymakers-in-an-inn | CC0 1.0 | Resized from 1686 x 1925 to 1401 x 1600 and converted to WebP. |
| `public/starter/historical-art/l-22.webp`, `public/starter/historical-art/thumbs/l-22.webp` | William Pether (British, c. 1738–1821), after a painting by Joseph Wright of Derby (British, 1734–1797); published by William Pether. The Alchymist, in Search of the Philosopher's Stone, Discovers Phosphorus, and Prays for the Successful Conclusion of his Operation, as was the Custom of the Ancient Chymical Astrologers, 1775. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1995.2 | CC0 1.0 | Resized from 2679 x 3400 to 1261 x 1600 and converted to WebP. |
| `public/starter/historical-art/l-31.webp`, `public/starter/historical-art/thumbs/l-31.webp` | Thomas Birch American, born England, 1779–1851. Shipwreck near a Rocky Coast, 1833. The Art Institute of Chicago. | https://www.artic.edu/artworks/244013/shipwreck-near-a-rocky-coast | CC0 1.0 | Resized from 1686 x 1105 to 1600 x 1049 and converted to WebP, its color profile converted to sRGB. |
| `public/starter/historical-art/i-01.webp`, `public/starter/historical-art/thumbs/i-01.webp` | Federico Picinino (Italian). Rapier, c.1625–50. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1916.695 | CC0 1.0 | Resized from 2658 x 3400 to 1251 x 1600 and converted to WebP. |
| `public/starter/historical-art/i-06.webp`, `public/starter/historical-art/thumbs/i-06.webp` | Unknown maker (Italy or Germany, early 17th century). Savoyard Helmet (Todenkopf), c. 1600–20. The Cleveland Museum of Art. | https://www.clevelandart.org/art/2013.50 | CC0 1.0 | Resized from 2604 x 3400 to 1225 x 1600 and converted to WebP. |
| `public/starter/historical-art/i-11.webp`, `public/starter/historical-art/thumbs/i-11.webp` | Spanish. Pendant Shaped as a Dragon, c. 1575-c. 1600. The Art Institute of Chicago. | https://www.artic.edu/artworks/119270 | CC0 1.0 | Resized from 1686 x 2108 to 1280 x 1600 and converted to WebP. |
| `public/starter/historical-art/i-15.webp`, `public/starter/historical-art/thumbs/i-15.webp` | German; Alsace. Chest, 14th century. The Art Institute of Chicago. | https://www.artic.edu/artworks/109531 | CC0 1.0 | Resized from 1686 x 1175 to 1600 x 1115 and converted to WebP. |
| `public/starter/historical-art/i-17.webp`, `public/starter/historical-art/thumbs/i-17.webp` | England, London, Richard Gurney and Thomas Cook (English, active 1727-1773). Covered Cup, 1757/58. The Art Institute of Chicago. | https://www.artic.edu/artworks/6475 | CC0 1.0 | Resized from 1686 x 2141 to 1260 x 1600 and converted to WebP. |
| `public/starter/historical-art/i-18.webp`, `public/starter/historical-art/thumbs/i-18.webp` | Iran, Isfahan. Astrolabe, Qajar dynasty (1786–1925), Late 18th century with later additions. The Art Institute of Chicago. | https://www.artic.edu/artworks/90589 | CC0 1.0 | Resized from 1642 x 2250 to 1168 x 1600 and converted to WebP. |
| `public/starter/historical-art/i-19.webp`, `public/starter/historical-art/thumbs/i-19.webp` | Unknown maker (Roman, probably Eastern Mediterranean). Janiform Head Flask, 100–400 CE. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1923.945 | CC0 1.0 | Resized from 3013 x 3400 to 1418 x 1600 and converted to WebP, its color profile converted to sRGB. |
| `public/starter/historical-art/d-01.webp`, `public/starter/historical-art/thumbs/d-01.webp` | Artist unknown, British, 18th century. Recovery Document (Land Title Grant), 1702/14 (Queen Anne period). The Art Institute of Chicago. | https://www.artic.edu/artworks/136136 | CC0 1.0 | Resized from 1686 x 1651 to 1296 x 1269 and converted to WebP. |
| `public/starter/historical-art/d-02.webp`, `public/starter/historical-art/thumbs/d-02.webp` | Unknown Artist, Nowegian, 19th century. Letter of Congratulations to Karna Martensdottir, 1852. The Art Institute of Chicago. | https://www.artic.edu/artworks/10086 | CC0 1.0 | Resized from 1686 x 2231 to 1209 x 1600 and converted to WebP. |
| `public/starter/historical-art/d-07.webp`, `public/starter/historical-art/thumbs/d-07.webp` | Albrecht Dürer, German, 1471-1528. Celestial Map of the Northern Sky with the Twelve Zodiac Signs, 1515. The Art Institute of Chicago. | https://www.artic.edu/artworks/106550 | CC0 1.0 | Resized from 1686 x 2102 to 1155 x 1440 and converted to WebP. |
| `public/starter/historical-art/d-10.webp`, `public/starter/historical-art/thumbs/d-10.webp` | Unknown Artist (English, 19th century), after John Paul Cimerlin (Italian, active c. 1566). Map of the World, 1889. The Art Institute of Chicago. | https://www.artic.edu/artworks/152509 | CC0 1.0 | Resized from 1686 x 1258 to 1600 x 1194 and converted to WebP. |
| `public/starter/historical-art/d-13.webp`, `public/starter/historical-art/thumbs/d-13.webp` | Master ES (German, active 1450–67). The Small Playing Cards:  Second Suit:  Helmets:  Playing Card with King and Helmet, 1450–67. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1949.564 | CC0 1.0 | Resized from 2239 x 3400 to 768 x 1166 and converted to WebP. |
| `public/starter/historical-art/d-15.webp`, `public/starter/historical-art/thumbs/d-15.webp` | Peter Flötner (German, 1485–1546). A gaming board, 1500–1546. The Cleveland Museum of Art. | https://www.clevelandart.org/art/1923.247 | CC0 1.0 | Resized from 3400 x 3334 to 1024 x 1004 and converted to WebP, its color profile converted to sRGB. |

<!-- end of starter-packs -->

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
