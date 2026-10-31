import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { encodeSteps, encodeWithin, renderSize, type EncodeStep } from "./encode.ts";
import { DECODERS, IMAGE_FAILURES, MAX_IMAGE_PIXELS, PDF_OPTIONS, PDFJS_FOLDER, PDFJS_VERSION, imageFailure } from "./options.ts";
import { isDynamicXfa } from "./reader.ts";

const PDFJS = new URL("../../../../node_modules/pdfjs-dist/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, PDFJS), "utf8");

describe("PDF_OPTIONS (docs/design-v1-pdf-handouts.md 4.2.4)", () => {
  test("no WebAssembly, no XFA, warnings on, the decoders from the app's folder, nothing else fetched, and images bounded", () => {
    assert.deepEqual(PDF_OPTIONS, {
      useWasm: false,
      enableXfa: false,
      verbosity: 1,
      wasmUrl: "/pdfjs/6.4.299/",
      maxImageSize: 40_000_000,
      canvasMaxAreaInBytes: 2048 * 2048 * 4,
      stopAtErrors: false,
    });
    for (const unset of ["cMapUrl", "standardFontDataUrl", "iccUrl", "isEvalSupported", "url"]) assert.equal(unset in PDF_OPTIONS, false, unset);
    assert.ok(MAX_IMAGE_PIXELS > 8.5 * 600 * 11 * 600, "a 600 dpi Letter scan fits");
  });

  test("the pin is the installed pdf.js, whose warning level is the one set, and the folder is named by it", async () => {
    assert.equal((JSON.parse(read("package.json")) as { version: string }).version, PDFJS_VERSION);
    assert.equal(PDFJS_FOLDER, `/pdfjs/${PDFJS_VERSION}/`);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    assert.equal(PDF_OPTIONS.verbosity, pdfjs.VerbosityLevel.WARNINGS);
    for (const name of DECODERS) assert.ok(read(`wasm/${name}`).includes("export default"), name);
  });

  test("the installed pdf.js and its decoders hold no eval and no new Function, so an upgrade that brought one back fails here", () => {
    const evalLike = [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /(^|[^.\w$])Function\s*\(\s*["'`]/];
    for (const file of ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "build/pdf.mjs", "build/pdf.worker.mjs", ...DECODERS.map((name) => `wasm/${name}`)]) {
      const source = read(file);
      for (const pattern of evalLike) assert.equal(pattern.test(source), false, `${file}: ${pattern}`);
    }
  });
});

describe("IMAGE_FAILURES (docs/design-v1-pdf-handouts.md 4.2.1)", () => {
  test("each matches a warning the pinned pdf.js writes, in its built worker as shipped", () => {
    const texts = ["Unable to decode image", "Unable to decode inline image", "#getJsModule: ", "#instantiateWasm: ", "Image exceeded maximum allowed size and was removed."];
    for (const file of ["build/pdf.worker.mjs", "build/pdf.worker.min.mjs"]) {
      const source = read(file);
      for (const text of texts) assert.ok(source.includes(text), `${file}: ${text}`);
      // warn() writes "Warning: " before each.
      assert.ok(source.includes("console.warn(`Warning: ${"), `${file}: warn() still writes through console.warn`);
    }
    for (const text of texts) assert.ok(IMAGE_FAILURES.some((p) => p.test(`Warning: ${text} "the rest"`)), text);
  });

  test("pdf.js writes each when it happens, and only those lines fail a page", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("legacy/build/pdf.worker.mjs", PDFJS).href;
    const decoders = new URL("wasm/", PDFJS).pathname;
    const warnings = async (data: Uint8Array, options: Record<string, unknown> = {}): Promise<string[]> => {
      const lines: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
      try {
        const task = pdfjs.getDocument({ data, useWasm: false, verbosity: 1, wasmUrl: decoders, ...options });
        const doc = await task.promise;
        await (await doc.getPage(1)).getOperatorList();
        await task.destroy();
      } finally {
        console.warn = warn;
      }
      return lines;
    };
    const failures = (lines: string[]) => lines.filter((line) => imageFailure([line], true) !== null);
    // A JPEG 2000 image with no size marker: its data cannot be decoded.
    const broken = await warnings(imagePdf("JPXDecode", new TextEncoder().encode("not an image")));
    assert.equal(failures(broken).length, 1, broken.join("\n"));
    assert.match(failures(broken)[0]!, /^Warning: Unable to decode image/);
    // A decoder that cannot load, then the image it should have decoded.
    const missing = await warnings(imagePdf("JBIG2Decode", new TextEncoder().encode("bits")), { wasmUrl: "/nowhere/" });
    assert.deepEqual(failures(missing).map((line) => line.slice(0, 25)), ["Warning: #getJsModule: Er", "Warning: Unable to decode"]);
    // An image larger than maxImageSize, dropped.
    const large = await warnings(imagePdf(null, new Uint8Array(100).fill(128)), { maxImageSize: 50 });
    assert.deepEqual(failures(large), ["Warning: Image exceeded maximum allowed size and was removed."]);
    // An inline image whose data cannot be decoded, and the line before it, which is no failure.
    const inline = await warnings(pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>", stream("<< /Length LEN >>", "q 100 0 0 100 0 0 cm BI /W 4 /H 4 /CS /G /BPC 8 /F /DCT ID garbage EI Q")]));
    assert.equal(inline.length, 2, inline.join("\n"));
    assert.deepEqual(failures(inline).map((line) => line.slice(0, 38)), ["Warning: Unable to decode inline image"]);
    // A page that draws whole warns nothing.
    assert.deepEqual(await warnings(imagePdf(null, new Uint8Array(100).fill(128))), []);
  });
});

describe("XFA forms (docs/design-v1-pdf-handouts.md 4.1.3)", () => {
  test("a dynamic XFA form is refused, and a hybrid form and an ordinary PDF open, by the flags pdf.js reports", async () => {
    assert.equal(isDynamicXfa({ IsXFAPresent: true, IsAcroFormPresent: false }), true);
    assert.equal(isDynamicXfa({ IsXFAPresent: true, IsAcroFormPresent: true }), false, "a hybrid form draws its AcroForm");
    assert.equal(isDynamicXfa({ IsXFAPresent: false, IsAcroFormPresent: true }), false);
    assert.equal(isDynamicXfa({}), false);
    // The pinned pdf.js reports both flags for a form with an XFA entry and for one without.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("legacy/build/pdf.worker.mjs", PDFJS).href;
    const info = async (form: string) => {
      // Object 4 is the XFA packet, object 5 a text field.
      const data = pdf([`<< /Type /Catalog /Pages 2 0 R ${form} >>`, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>", stream("<< /Length LEN >>", "<xdp:xdp/>"), "<< /FT /Tx /T (name) >>"]);
      const task = pdfjs.getDocument({ data, useWasm: false, enableXfa: false, verbosity: 0 });
      const doc = await task.promise;
      const meta = (await doc.getMetadata()).info as Record<string, unknown>;
      await task.destroy();
      return meta;
    };
    assert.equal(isDynamicXfa(await info("/AcroForm << /XFA 4 0 R >>")), true, "XFA alone is a dynamic form");
    assert.equal(isDynamicXfa(await info("/AcroForm << /Fields [5 0 R] /XFA 4 0 R >>")), false, "XFA beside fields of its own is a hybrid form");
    assert.equal(isDynamicXfa(await info("/AcroForm << /Fields [5 0 R] >>")), false);
    assert.equal(isDynamicXfa(await info("")), false);
  });
});

describe("drawing size (docs/design-v1-pdf-handouts.md 4.2.2)", () => {
  test("the long side 2048 px whatever the paper, each side at least 1 px", () => {
    assert.deepEqual(renderSize(612, 792), { scale: 2048 / 792, width: 1583, height: 2048 }, "Letter, portrait");
    assert.deepEqual(renderSize(792, 612), { scale: 2048 / 792, width: 2048, height: 1583 }, "Letter, landscape");
    assert.deepEqual(renderSize(252, 144), { scale: 2048 / 252, width: 2048, height: 1170 }, "a business card draws larger");
    assert.deepEqual(renderSize(14_400, 7_200), { scale: 2048 / 14_400, width: 2048, height: 1024 }, "a 200 inch poster draws smaller");
    assert.deepEqual(renderSize(72, 3_600), { scale: 2048 / 3_600, width: 41, height: 2048 }, "a 1 by 50 inch strip");
    assert.equal(renderSize(1, 100_000).width, 1);
  });
});

describe("encoding a page under the upload cap (docs/design-v1-pdf-handouts.md 4.1.4)", () => {
  /** A page that encodes to `sizes(step)` bytes, as a browser that can or cannot write WebP. */
  function source(sizes: (step: EncodeStep) => number, webp = true, width = 1584, height = 2048) {
    const asked: string[] = [];
    return {
      asked,
      width,
      height,
      async encode(step: EncodeStep) {
        asked.push(`${step.type.slice(6)} ${step.quality} ${step.longSide}`);
        // A browser that cannot write WebP hands back PNG, its default, as canvas.toBlob does.
        return new Blob([new Uint8Array(sizes(step))], { type: webp || step.type !== "image/webp" ? step.type : "image/png" });
      },
    };
  }

  test("WebP at 0.9 when it fits", async () => {
    const s = source(() => 300_000);
    const out = await encodeWithin(s, 10 * 1024 * 1024);
    assert.deepEqual(s.asked, ["webp 0.9 2048"]);
    assert.equal(out?.blob.type, "image/webp");
    assert.deepEqual([out?.width, out?.height], [1584, 2048]);
  });

  test("a browser that hands back another type than WebP is asked for JPEG at 0.92, never PNG", async () => {
    const s = source(() => 400_000, false);
    const out = await encodeWithin(s, 10 * 1024 * 1024);
    assert.deepEqual(s.asked, ["webp 0.9 2048", "jpeg 0.92 2048"]);
    assert.equal(out?.blob.type, "image/jpeg");
  });

  test("too large: lower quality, then smaller sizes, until it fits, or nothing at the smallest", async () => {
    const cap = 1_000;
    const shrinking = source((step) => (step.longSide === 1600 ? 900 : 5_000));
    const out = await encodeWithin(shrinking, cap);
    assert.deepEqual(shrinking.asked, ["webp 0.9 2048", "webp 0.8 2048", "webp 0.7 2048", "webp 0.7 1600"]);
    assert.deepEqual([out?.width, out?.height], [1238, 1600]);
    const never = source(() => 5_000);
    assert.equal(await encodeWithin(never, cap), null);
    assert.deepEqual(never.asked.at(-1), "webp 0.7 1200");
    assert.deepEqual(encodeSteps("image/jpeg").map((s) => s.quality), [0.92, 0.8, 0.7, 0.7, 0.7]);
  });
});

/** A PDF of the given objects, numbered from 1 in order, with a cross-reference table and a trailer. */
function pdf(objects: (string | { dict: string; data: Uint8Array })[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.7\n")];
  const offsets: number[] = [];
  let position = parts[0]!.length;
  objects.forEach((object, i) => {
    offsets.push(position);
    const body =
      typeof object === "string"
        ? [encoder.encode(`${i + 1} 0 obj\n${object}\nendobj\n`)]
        : [encoder.encode(`${i + 1} 0 obj\n${object.dict.replace("LEN", String(object.data.length))}\nstream\n`), object.data, encoder.encode("\nendstream\nendobj\n")];
    for (const part of body) {
      parts.push(part);
      position += part.length;
    }
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(encoder.encode(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function stream(dict: string, content: string | Uint8Array): { dict: string; data: Uint8Array } {
  return { dict, data: typeof content === "string" ? new TextEncoder().encode(content) : content };
}

/** One 100 pt page drawing one 10 x 10 gray image, with `filter` on its data, or none. */
function imagePdf(filter: string | null, data: Uint8Array): Uint8Array {
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    stream("<< /Length LEN >>", "q 100 0 0 100 0 0 cm /Im0 Do Q"),
    stream(`<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceGray /BitsPerComponent 8${filter ? ` /Filter /${filter}` : ""} /Length LEN >>`, data),
  ]);
}
