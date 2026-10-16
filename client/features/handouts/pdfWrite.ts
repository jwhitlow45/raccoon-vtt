/**
 * A PDF of image pages, written in the browser for Download on a handout
 * of several pages (docs/design-v1-pdf-handouts.md section 6, decision 2).
 *
 * A PDF can hold a JPEG as it is, under the DCTDecode filter, so a PDF of
 * image pages needs no library: a catalog, a page tree, and for each page
 * a page object, a content stream that paints its image, and the image.
 * Then a cross-reference table of every object's byte offset, and a
 * trailer. The result is a Blob made of the text parts and the JPEG blobs
 * as they are, with every offset worked out from their sizes, so the
 * JPEGs of a long handout are never copied into one buffer.
 */

export type PdfImagePage = {
  /** A baseline JPEG, as a canvas encodes it. */
  jpeg: Blob;
  /** Its pixel size. */
  width: number;
  height: number;
};

/** A page's long side in points: a Letter page's 11 inches, so a page prints at a sensible size whatever its pixels. */
export const PDF_LONG_SIDE_PT = 792;

/** The page's size in points, its long side PDF_LONG_SIDE_PT and its shape kept. */
export function pageSizePt(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height, 1);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { width: round((Math.max(width, 1) / long) * PDF_LONG_SIDE_PT), height: round((Math.max(height, 1) / long) * PDF_LONG_SIDE_PT) };
}

/**
 * A text string as a PDF hex string in UTF-16 with its byte order mark, so
 * every character of a title survives, emoji included, and nothing needs
 * escaping.
 */
export function pdfTextString(text: string): string {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return `<${hex}>`;
}

/** The file's parts in order: text, which is all ASCII, and the JPEGs as they are. */
type Part = string | Blob;

function partSize(part: Part): number {
  // Every text part is ASCII, so its length is its size in bytes.
  return typeof part === "string" ? part.length : part.size;
}

/** The PDF of these pages in order, with the handout's title as its Title. */
export function writePdf(pages: readonly PdfImagePage[], title: string): Blob {
  const parts: Part[] = [];
  const offsets: number[] = [];
  let at = 0;
  const push = (part: Part) => {
    parts.push(part);
    at += partSize(part);
  };
  const object = (n: number, ...body: Part[]) => {
    offsets[n] = at;
    push(`${n} 0 obj\n`);
    for (const b of body) push(b);
    push("\nendobj\n");
  };

  // The second line's bytes above 127 tell a transfer program the file is binary, as the PDF spec advises. They are written as bytes, not text.
  parts.push(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]));
  at += 15;

  // Objects 1 to 3, then three for each page: the page, its content stream and its image.
  const pageNumber = (i: number) => 4 + i * 3;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageNumber(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  object(3, `<< /Title ${pdfTextString(title)} /Producer (raccoon-vtt) >>`);
  pages.forEach((page, i) => {
    const n = pageNumber(i);
    const size = pageSizePt(page.width, page.height);
    object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.width} ${size.height}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    // The image fills the page: its unit square scaled to the page's size.
    const draw = `q ${size.width} 0 0 ${size.height} 0 0 cm /Im0 Do Q`;
    object(n + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    object(
      n + 2,
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.size} >>\nstream\n`,
      page.jpeg,
      "\nendstream",
    );
  });

  const count = 4 + pages.length * 3;
  const xref = at;
  // Each entry is exactly 20 bytes, its line ending a space and a newline.
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n] ?? 0).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
