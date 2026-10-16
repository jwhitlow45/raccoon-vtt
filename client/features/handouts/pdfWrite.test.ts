import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { pageSizePt, pdfTextString, writePdf, type PdfImagePage } from "./pdfWrite.ts";

/*
 * The PDF a handout of pages downloads as (docs/design-v1-pdf-handouts.md
 * section 6). Its structure is read back here byte by byte, and by pdf.js
 * itself where pdfjs-dist is installed, through its legacy build, which
 * pdf.js documents for Node.
 */

const TITLE = "Strange letter: Þórr's 🐉 note";

/** A real JPEG of one color, as a canvas would encode a page. */
async function jpegPage(width: number, height: number, rgb: [number, number, number]): Promise<PdfImagePage> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { jpeg: new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), width, height };
}

async function pages(): Promise<PdfImagePage[]> {
  return [await jpegPage(1584, 2048, [200, 40, 40]), await jpegPage(2048, 1584, [40, 160, 60]), await jpegPage(1448, 2048, [40, 70, 200])];
}

/** The file as bytes and as Latin-1 text, where each byte is one character, so text offsets are byte offsets. */
async function read(blob: Blob): Promise<{ bytes: Uint8Array; text: string }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, text: Buffer.from(bytes).toString("latin1") };
}

describe("writePdf", () => {
  test("every cross-reference offset points at its object, and startxref at the table", async () => {
    const { text } = await read(writePdf(await pages(), TITLE));
    assert.ok(text.startsWith("%PDF-1.4\n%"), "the header");
    assert.ok(text.endsWith("%%EOF\n"));
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    assert.equal(text.slice(start, start + 5), "xref\n");
    const head = /^xref\n0 (\d+)\n/.exec(text.slice(start));
    assert.ok(head);
    const count = Number(head[1]);
    assert.equal(count, 4 + 3 * 3);
    const entries = text.slice(start + head[0].length).split("\n").slice(0, count);
    assert.equal(entries[0], "0000000000 65535 f ");
    for (let n = 1; n < count; n++) {
      const entry = entries[n]!;
      assert.equal(entry.length + 1, 20, `entry ${n} is not 20 bytes`);
      const offset = Number(entry.slice(0, 10));
      assert.equal(text.slice(offset, offset + `${n} 0 obj`.length), `${n} 0 obj`, `object ${n}'s offset`);
    }
    assert.match(text, /trailer\n<< \/Size 13 \/Root 1 0 R \/Info 3 0 R >>/);
  });

  test("its pages in order, each with its long side 792 points and its image as the JPEG it was given", async () => {
    const input = await pages();
    const { bytes, text } = await read(writePdf(input, TITLE));
    assert.match(text, /\/Type \/Pages \/Kids \[4 0 R 7 0 R 10 0 R\] \/Count 3/);
    const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.deepEqual(boxes, [
      [612.56, 792],
      [792, 612.56],
      [559.97, 792],
    ]);
    const images = [...text.matchAll(/\/Width (\d+) \/Height (\d+) \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g)];
    assert.equal(images.length, 3);
    for (const [i, m] of images.entries()) {
      const page = input[i]!;
      assert.deepEqual([Number(m[1]), Number(m[2])], [page.width, page.height]);
      const from = m.index + m[0].length;
      const jpeg = new Uint8Array(await page.jpeg.arrayBuffer());
      assert.equal(Number(m[3]), jpeg.length);
      assert.deepEqual(bytes.slice(from, from + jpeg.length), jpeg, `page ${i + 1}'s image was changed`);
      assert.equal(text.slice(from + jpeg.length, from + jpeg.length + "\nendstream".length), "\nendstream");
    }
  });

  test("the title as UTF-16 hex, so every character survives", async () => {
    const { text } = await read(writePdf(await pages(), TITLE));
    const hex = /\/Title <FEFF([0-9A-F]*)>/.exec(text)?.[1] ?? "";
    let title = "";
    for (let i = 0; i < hex.length; i += 4) title += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    assert.equal(title, TITLE);
    assert.equal(pdfTextString("A"), "<FEFF0041>");
  });

  test("a page's size in points keeps its shape, its long side a Letter page's", () => {
    assert.deepEqual(pageSizePt(1584, 2048), { width: 612.56, height: 792 });
    assert.deepEqual(pageSizePt(2048, 1024), { width: 792, height: 396 });
    assert.deepEqual(pageSizePt(41, 2048), { width: 15.86, height: 792 });
  });
});

/*
 * pdf.js reads the file back: its page count, each page's size, the title,
 * and each page's operator list painting one image of that page's pixel
 * size. pdfjs-dist arrives with the PDF upload's part of the build, so on a
 * checkout without it this part is skipped, by name.
 */
type PdfJs = {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
  OPS: Record<string, number>;
};
type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{ view: number[]; getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }> }>;
  getMetadata(): Promise<{ info: { Title?: string } }>;
};
const PDFJS = "pdfjs-dist/legacy/build/pdf.mjs";
const pdfjs = (await import(PDFJS).catch(() => null)) as PdfJs | null;

describe("writePdf read back by pdf.js", { skip: pdfjs ? false : "pdfjs-dist is not installed" }, () => {
  test("pdf.js reads every page, its size, the title, and one image of the page's pixels on each", async () => {
    const input = await pages();
    const data = new Uint8Array(await writePdf(input, TITLE).arrayBuffer());
    const task = pdfjs!.getDocument({ data });
    const doc = await task.promise;
    try {
      assert.equal(doc.numPages, 3);
      assert.equal((await doc.getMetadata()).info.Title, TITLE);
      for (let i = 0; i < 3; i++) {
        const page = await doc.getPage(i + 1);
        const size = pageSizePt(input[i]!.width, input[i]!.height);
        assert.deepEqual(page.view, [0, 0, size.width, size.height]);
        const ops = await page.getOperatorList();
        const painted = ops.fnArray.flatMap((fn, k) => (fn === pdfjs!.OPS.paintImageXObject ? [ops.argsArray[k]!] : []));
        assert.equal(painted.length, 1, `page ${i + 1} paints ${painted.length} images`);
        assert.deepEqual(painted[0]!.slice(1, 3), [input[i]!.width, input[i]!.height]);
      }
    } finally {
      await task.destroy();
    }
  });
});
