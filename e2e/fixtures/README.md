# Fixtures

Files the e2e tests read that no test can write as it runs. Every file here was made for these tests and is under the project's license, the GNU AGPL v3.0, apart from the font noted below.

## Animated map videos: map-loop.webm and map-loop.mp4

For `e2e/animmap.e2e.ts` (docs/design/design-v1-animated-maps.md 12): a VP9 WebM and an H.264 MP4, each 640 x 360, 2 s long at 30 frames a second, with no sound. Both show the same test pattern, drawn on a canvas: seven color bars, a white square that crosses a dark band below them, and each frame's number. Chrome's MediaRecorder recorded the canvas, and `scripts/video-fixtures.ts` rebuilt each recording as a plain file with the server's own test writer (`server/assets/video/videoTestutil.ts`), since a recording is not one: its WebM is written as it streams and its MP4 is fragmented, both of which the server refuses. The rebuild keeps every frame as Chrome encoded it and times the first 60 from the first key frame at exactly 30 a second. The script then checks that each file passes the server's header check and plays and loops in Chrome, and that a copy with identifying text added still plays once the check has cleared it.

```sh
node scripts/video-fixtures.ts
```

It needs Google Chrome, which Playwright launches as the `chrome` channel. A new run records new frames, so the files' bytes change while what they show stays the same, and it makes the videos below again from the new loops.

## Turned, stretched and cropped videos, and an iPhone MOV

For the `amr` steps in `e2e/animmap.e2e.ts` (docs/design/design-v1-video-turns.md 14): the loops' own frames under other headers, written by the same script and the same test writer from the loops here, with no new recording and no downloaded video. Each shows the loop's pattern, whose bars and dark strip tell all eight orientations apart.

- `map-turn-90.mp4`: the 90 row with no translation, as Android's MediaMuxer writes a portrait video. Drawn 360 × 640.
- `map-turn-180.mp4`: the 180 row moved back into view by the picture's width and height, as Apple writes it.
- `map-turn-270-mirror.mp4`: 270 and then a mirror, as FFmpeg's `-display_rotation 90 -display_hflip` writes it, with no translation. Drawn 360 × 640.
- `map-wide.mp4`: a `pasp` of 4:3 with `tkhd`'s width at 640 × 4/3 rounded in 16.16, as FFmpeg's MP4 mode writes it. Drawn 853 × 360.
- `map-wide.webm`: DisplayWidth 853 and DisplayHeight 360 over the loop's 640 × 360 pixels. Drawn 853 × 360.
- `map-clap.mp4`: a `clap` that crops 8 px off the width. The server refuses it.
- `map-iphone.mov`: an iPhone's Most Compatible MOV as public reports describe one, with made-up strings: the `qt  ` brand, `alis` data references, an `nclc` colour, silent AAC in a version 1 sound entry inside `wave`, a `tapt` at the turned size, two timed metadata tracks holding a face and a place, QuickTime metadata naming a place and a phone, and the 90 row with Apple's translation. Drawn 360 × 640, and stored as an MP4 with none of the strings. Its AAC frames were worked out bit by bit, so no encoder made them.

```sh
node scripts/video-fixtures.ts derived
```

`derived` makes only these, from the loops already here, so the same loops give the same bytes. Either way the script checks that each file meets the server's header check as the design says, that each stored copy plays and loops in Chrome, and that a turned or stretched MP4 stored is byte for byte the stored loop.

## PDF fixtures

Files for `e2e/pdf.e2e.ts` (docs/design/design-v1-pdf-handouts.md 11.3) that `e2e/pdfFixture.ts` cannot write. Each is one page.

### password.pdf

One Letter page from `pdfOf([LETTER], "Locked letter")` in `e2e/pdfFixture.ts`, encrypted with qpdf 12.2.0. The password is `raccoon`. The upload must refuse it without uploading anything.

```sh
qpdf --encrypt --user-password=raccoon --owner-password=raccoon --bits=256 -- plain.pdf password.pdf
```

### The scanner fixtures: jbig2.pdf, ccitt.pdf and jpx.pdf

Each holds one 600 x 600 image: white, with a black rectangle from x 150 to 300 and y 120 to 420, counted from the top-left corner. `shapeProblem` in `e2e/pdfFixture.ts` checks it as fractions of the page: a quarter to half of the width, a fifth to seven tenths of the height. The image was written by a few lines of Python as `shape.pbm` (PBM, 1 bit) and `shape.pgm` (PGM, 8 bit gray), then compressed by each scanner codec:

- `jbig2.pdf`: JBIG2 in symbol mode, with jbig2enc 0.30 and its own `jbig2topdf.py`.

  ```sh
  jbig2 -s -p -b shape shape.pbm
  jbig2topdf.py shape > jbig2.pdf
  ```

- `ccitt.pdf`: CCITT Group 4, with libtiff 4.7.0.

  ```sh
  ppm2tiff -c g4 -R 150 shape.pbm shape.tif
  tiff2pdf -o ccitt.pdf shape.tif
  ```

- `jpx.pdf`: JPEG 2000, with OpenJPEG 2.5.3 and img2pdf 0.6.1, which embeds the `.jp2` as it is.

  ```sh
  opj_compress -i shape.pgm -o shape.jp2
  img2pdf -o jpx.pdf shape.jp2
  ```

### embedded-font.pdf and embedded-font.png

A 6 x 3 inch page with "Quick&Raggy" in Space Grotesk at weight 500, 72 px on 120 px lines, in a 480 x 120 px box 48 px from the page's top-left corner (CSS pixels, 576 x 288 to the page). Chrome printed it from HTML with Playwright's `page.pdf()`, which embeds the font as a TrueType subset (`CIDFontType2` with `FontFile2`). Chrome embeds a variable font's other weights as Type 3 glyph drawings, so the font was first made static with fontTools 4.67.0:

```sh
fonttools varLib.instancer SpaceGrotesk-VariableFont_wght.ttf wght=500 --static -o font.ttf
```

`embedded-font.png` is Chrome's screenshot of the same box at twice its CSS size, the reference the stored page's text box is compared with. `fontBoxDistance` brings both to 240 x 60 gray pixels. The same words in Helvetica or Arial are about 37 gray levels away on average, so a page drawn in a stand-in font fails.

Space Grotesk is copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) and licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). The license allows embedding the font in documents. The PDF holds only the subset of glyphs its words use.

## Sound files: sound-*.wav and sound-*.mp3

For `e2e/soundupload.e2e.ts` (docs/design/design-v1-music.md 12). Each is a tone written from scratch by `e2e/fixtures/sounds.ts`, never a recording, and the MP3s come from the encoder the app ships (`@breezystack/lamejs`). The same run writes the same bytes.

```sh
node e2e/fixtures/sounds.ts
```

- `sound-tone.wav`: 1 s of a 1 kHz tone at -20 dBFS, 16-bit stereo at 44.1 kHz. The upload reads it straight from its PCM and converts it.
- `sound-surround.wav`: 0.3 s of a tone on all six channels of 5.1, 24-bit at 48 kHz. Mixed to stereo, then converted at 48 kHz.
- `sound-vbr.mp3`: two whole 1-second streams back to back, at 128 and then 160 kbps, so its bitrate changes. Converted.
- `sound-tagged.mp3`: 2 s at 128 kbps between an ID3v2 tag of 4,096 bytes and an ID3v1 tag. Copied, without either tag.
- `sound-tagged-320.mp3`: 1 s at 320 kbps with the same tags, past the bitrates the room keeps. Converted.

The long files the steps need, a 30-second effect, a 15-minute track, a 10-minute WAV and a 48 kHz MP3 of several minutes, would take hundreds of megabytes here, so the e2e file writes them to a temporary folder with the same script's functions each time it runs.
