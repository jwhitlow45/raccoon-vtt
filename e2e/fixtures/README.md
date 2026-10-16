# PDF fixtures

Files for `e2e/pdf.e2e.ts` (docs/design-v1-pdf-handouts.md 11.3) that `e2e/pdfFixture.ts` cannot write. Each is one page. Every file here was made for these tests and is under the project's license, the GNU AGPL v3.0, apart from the font noted below.

## password.pdf

One Letter page from `pdfOf([LETTER], "Locked letter")` in `e2e/pdfFixture.ts`, encrypted with qpdf 12.2.0. The password is `raccoon`. The upload must refuse it without uploading anything.

```sh
qpdf --encrypt --user-password=raccoon --owner-password=raccoon --bits=256 -- plain.pdf password.pdf
```

## The scanner fixtures: jbig2.pdf, ccitt.pdf and jpx.pdf

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

## embedded-font.pdf and embedded-font.png

A 6 x 3 inch page with "Quick&Raggy" in Space Grotesk at weight 500, 72 px on 120 px lines, in a 480 x 120 px box 48 px from the page's top-left corner (CSS pixels, 576 x 288 to the page). Chrome printed it from HTML with Playwright's `page.pdf()`, which embeds the font as a TrueType subset (`CIDFontType2` with `FontFile2`). Chrome embeds a variable font's other weights as Type 3 glyph drawings, so the font was first made static with fontTools 4.67.0:

```sh
fonttools varLib.instancer SpaceGrotesk-VariableFont_wght.ttf wght=500 --static -o font.ttf
```

`embedded-font.png` is Chrome's screenshot of the same box at twice its CSS size, the reference the stored page's text box is compared with. `fontBoxDistance` brings both to 240 x 60 gray pixels. The same words in Helvetica or Arial are about 37 gray levels away on average, so a page drawn in a stand-in font fails.

Space Grotesk is copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk) and licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). The license allows embedding the font in documents. The PDF holds only the subset of glyphs its words use.
