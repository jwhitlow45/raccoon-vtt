import sharp, { type Sharp } from "sharp";

/**
 * Small PDFs for the PDF handout tests (docs/design-v1-pdf-handouts.md
 * 11.3), and the checks on the pages a PDF became. Each page is white paper
 * with a band of its own color in its top-left corner and "Page N" in
 * Helvetica, all vector, so the file is a few hundred bytes a page however
 * many pages it has. The band is checked on the page the server stored, so
 * a blank page, a page out of order or a page turned over fails.
 *
 * The fixtures in e2e/fixtures/ are the files this cannot write: a
 * password, an embedded font and the scanners' image codecs. Their README
 * says how each was made.
 */

/** Each page's band, by page number: page N has BANDS[(N - 1) % 5], so neighbours always differ. */
export const BANDS: readonly (readonly [number, number, number])[] = [
  [200, 40, 40],
  [40, 160, 60],
  [40, 70, 200],
  [200, 150, 30],
  [140, 50, 170],
];

/** A page size in points. */
export type PdfPage = { width: number; height: number };

export const LETTER: PdfPage = { width: 612, height: 792 };
export const LETTER_WIDE: PdfPage = { width: 792, height: 612 };
export const A5: PdfPage = { width: 420, height: 595 };

export function bandOf(n: number): readonly [number, number, number] {
  return BANDS[(n - 1) % BANDS.length]!;
}

/**
 * The band's place as fractions of the page, from its top-left corner: a
 * twentieth in from the left and the top, a quarter of the width wide and
 * a twelfth of the height tall. pdf.e2e.ts's `paper` draws the same band,
 * so a page made either way passes the same checks.
 */
export const BAND = { left: 1 / 20, top: 1 / 20, width: 1 / 4, height: 1 / 12 } as const;

/** A number as a PDF writes it: at most two decimals, no trailing zeros. */
function num(x: number): string {
  return String(Math.round(x * 100) / 100);
}

/** A PDF literal string, with its three special characters escaped. */
function literal(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/**
 * A PDF of these pages. Page N draws band N and "Page N". `title` goes in
 * the Info dictionary, where the upload finds the handout's name. `from`
 * numbers the first page, for a range cut from a longer PDF.
 */
export function pdfOf(pages: readonly PdfPage[], title: string | null, from = 1): Buffer {
  const objects: string[] = [];
  const pageRef = (i: number) => 4 + i * 2;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${pageRef(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  pages.forEach(({ width: w, height: h }, i) => {
    const n = from + i;
    const [r, g, b] = bandOf(n).map((c) => num(c / 255));
    // PDF space starts at the bottom-left corner, so the band's top edge is a twentieth down from the top.
    const band = { x: w * BAND.left, y: h - h * BAND.top - h * BAND.height, w: w * BAND.width, h: h * BAND.height };
    const text = `Page ${n}`;
    const size = w / 10;
    // Helvetica's digits and these letters average a little over half an em, enough to centre the line by eye.
    const x = w / 2 - (text.length * size * 0.55) / 2;
    const content = [
      `${r} ${g} ${b} rg ${num(band.x)} ${num(band.y)} ${num(band.w)} ${num(band.h)} re f`,
      `BT /F1 ${num(size)} Tf 0.13 g ${num(x)} ${num(h / 2)} Td ${literal(text)} Tj ET`,
    ].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageRef(i) + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  if (title !== null) objects.push(`<< /Title ${literal(title)} /Producer (raccoon-vtt e2e) >>`);
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  const info = title !== null ? ` /Info ${objects.length} 0 R` : "";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

type Pixels = { data: Buffer; width: number; height: number; channels: number };

async function pixels(image: Buffer): Promise<Pixels> {
  const { data, info } = await sharp(image).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** The color at a point given as fractions of the image's width and height. */
function at(p: Pixels, fx: number, fy: number): [number, number, number] {
  const x = Math.min(p.width - 1, Math.round(p.width * fx));
  const y = Math.min(p.height - 1, Math.round(p.height * fy));
  const k = (y * p.width + x) * p.channels;
  return [p.data[k]!, p.data[k + 1]!, p.data[k + 2]!];
}

function near(got: readonly number[], want: readonly number[], within: number): boolean {
  return got.every((v, c) => Math.abs(v - want[c]!) < within);
}

/**
 * What is wrong with a stored page that should be page `n`, or null: its
 * band's middle must be band n's color, and the same place mirrored into
 * the bottom-right corner must be paper, so a page upside down fails too.
 * WebP and JPEG shift a flat color a little, hence the tolerance.
 */
export async function bandProblem(image: Buffer, n: number): Promise<string | null> {
  const p = await pixels(image);
  const fx = BAND.left + BAND.width / 2;
  const fy = BAND.top + BAND.height / 2;
  const got = at(p, fx, fy);
  if (!near(got, bandOf(n), 40)) return `the band reads ${got.join(",")}, not page ${n}'s ${bandOf(n).join(",")}`;
  const mirrored = at(p, 1 - fx, 1 - fy);
  if (!near(mirrored, [255, 255, 255], 30)) return `the bottom-right corner reads ${mirrored.join(",")}, not paper`;
  return null;
}

/**
 * The scanner fixtures' black shape (e2e/fixtures/README.md): a rectangle
 * from a quarter to half of the page's width and from a fifth to seven
 * tenths of its height. A point inside it is dark, and points beside it,
 * below it and where it would lie turned on its side are paper.
 */
export async function shapeProblem(image: Buffer): Promise<string | null> {
  const p = await pixels(image);
  const inside = at(p, 0.375, 0.45);
  if (!near(inside, [0, 0, 0], 70)) return `the shape's middle reads ${inside.join(",")}, not black`;
  for (const [fx, fy, where] of [
    [0.75, 0.45, "beside it"],
    [0.375, 0.85, "below it"],
    [0.6, 0.3, "where it would lie turned"],
  ] as const) {
    const got = at(p, fx, fy);
    if (!near(got, [255, 255, 255], 70)) return `the page ${where} reads ${got.join(",")}, not paper`;
  }
  return null;
}

/**
 * Where embedded-font.pdf's text box lies on its 6 x 3 inch page, as
 * fractions: 48 CSS px in from the left and the top of a 576 x 288 page,
 * 480 x 120 px.
 */
export const FONT_BOX = { left: 48 / 576, top: 48 / 288, width: 480 / 576, height: 120 / 288 } as const;

/**
 * How far a stored page's text box is from the reference image of it, as
 * the mean difference of gray levels, 0 to 255, both brought to 240 x 60.
 * The same words drawn in a stand-in font, such as Helvetica for the
 * fixture's Space Grotesk, are about 37 away, so a font that failed to load
 * cannot pass for the embedded one.
 */
export async function fontBoxDistance(image: Buffer, reference: Buffer): Promise<number> {
  const meta = await sharp(image).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const box = {
    left: Math.round(width * FONT_BOX.left),
    top: Math.round(height * FONT_BOX.top),
    width: Math.round(width * FONT_BOX.width),
    height: Math.round(height * FONT_BOX.height),
  };
  const gray = (input: Sharp) => input.flatten({ background: "#ffffff" }).greyscale().resize(240, 60, { fit: "fill" }).raw().toBuffer();
  const [a, b] = await Promise.all([gray(sharp(image).extract(box)), gray(sharp(reference))]);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}
