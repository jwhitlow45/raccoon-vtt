import type { Locator, Page } from "playwright-core";
import { PALETTES } from "../../client/lib/theme.ts";

/**
 * The contrast sweep of the light theme (docs/design/design-v1-light-theme.md
 * 9 and 13, lt-3): text at 4.5:1 (3:1 when large), control outlines and
 * focus rings at 3:1, each against the ground it is drawn on.
 *
 * The ground is read from what the browser paints under the element, not
 * from its DOM parents: the toolbar's band on a phone is a sibling drawn
 * behind the buttons, and a floating control's parents hold the board. At
 * the element's middle (a ring's: on its line, on each side) the page's
 * stack of elements is read top to bottom, with pointer events turned on
 * for every element while it is read, since a box that takes no taps still
 * paints. Each box's background color and flat gradient is laid over the
 * next until one is opaque. A stack that reaches the map's canvas or the
 * map's column has the board under it, and a zoomed or panned map can put
 * any art there, so the element is measured twice, over the board's own
 * ground (#16161a) and over white, its translucent grounds laid over each.
 *
 * Named exclusions only: canvas content and images (nothing a stylesheet
 * colors), visually hidden text (a screen reader's), and an off control's
 * words, which the unit tests hold to 3:1 (lib/theme.test.ts). Each
 * exclusion is counted, so a sweep that left out everything still shows.
 * A sign of one or two characters hidden from screen readers, such as the
 * HP mode's "−", is an icon whose meaning its control's name carries, so
 * it is held to 3:1 as a graphic (WCAG 1.4.11), not to 4.5:1 as words.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** The board's own ground and the brightest map art it can hold. */
export const BOARD_GROUNDS = { board: "#16161a", white: "#ffffff" } as const;

/** The fixed dark halo of a ring on the board (lib/theme.ts ringHalo), as the browser writes it. */
export const HALO = "rgba(13, 13, 18, 0.9)";

/** A CSS color as getComputedStyle writes it, or hex. */
export function parseColor(css: string): Rgba {
  const s = css.trim();
  if (s === "transparent" || s === "") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha(rgb[4]) };
  // color-mix() in sRGB computes to color(srgb r g b / a), each part 0 to 1.
  const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: alpha(srgb[4]) };
  throw new Error(`a color the sweep cannot read: ${css}`);
}

function alpha(part: string | undefined): number {
  if (part === undefined) return 1;
  return part.endsWith("%") ? Number(part.slice(0, -1)) / 100 : Number(part);
}

/** `top` laid over `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a + under.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, u: number) => (t * top.a + u * under.a * (1 - top.a)) / a;
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a };
}

function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast of two opaque colors. */
export function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function hex(c: Rgba): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** What the page read for one thing drawn: its color, and the grounds under it from the nearest down, each a list of the colors a gradient may show there. */
export type Sample = {
  kind: "text" | "sign" | "outline" | "ring";
  what: string;
  color: string;
  /** The element's own opacity times its ancestors'. */
  opacity: number;
  grounds: string[][];
  /** The stack reached the board, so it is measured over both board grounds. */
  board: boolean;
  large: boolean;
};

export type Measured = Sample & { least: number; need: number; over: string };

export type Sweep = {
  measured: Measured[];
  failures: string[];
  excluded: Record<string, number>;
};

/** The ratio a sample needs: 4.5:1 for text, 3:1 for large text, outlines and rings. */
function need(s: Sample): number {
  return s.kind === "text" && !s.large ? 4.5 : 3;
}

/** The least contrast of a sample over every ground it can stand on. */
export function measure(s: Sample, page: Rgba): Measured {
  const bases = s.board ? [parseColor(BOARD_GROUNDS.board), parseColor(BOARD_GROUNDS.white)] : [page];
  let least = Infinity;
  let at = "";
  for (const base of bases) {
    // Every gradient's colors are tried, so the worst one counts.
    let grounds: Rgba[] = [base];
    for (const layer of [...s.grounds].reverse()) grounds = grounds.flatMap((g) => layer.map((c) => over(parseColor(c), g)));
    for (const ground of grounds) {
      const fg = parseColor(s.color);
      const ink = over({ ...fg, a: fg.a * s.opacity }, ground);
      const r = ratio(ink, ground);
      if (r < least) {
        least = r;
        at = `${hex(ink)} on ${hex(ground)}${s.board ? (base.r === 255 ? " (over white art)" : " (over the board)") : ""}`;
      }
    }
  }
  return { ...s, least, need: need(s), over: at };
}

/**
 * Reads every text, control outline and (with `rings`) the focused
 * element's ring under `root`, in the page, and measures each.
 */
export async function sweepContrast(root: Locator, label: string): Promise<Sweep> {
  const read = await root.evaluate(readSamples, { halo: HALO, ringOnly: false });
  return finish(read, label);
}

/** The ring of what has focus now, against the ground behind its line (the halo where it has one). */
export async function sweepRing(page: Page, label: string): Promise<Sweep> {
  const read = await page.locator(":focus").first().evaluate(readSamples, { halo: HALO, ringOnly: true });
  return finish(read, label);
}

function finish(read: { samples: Sample[]; excluded: Record<string, number>; page: string }, label: string): Sweep {
  const page = parseColor(read.page);
  const measured = read.samples.map((s) => measure(s, page));
  const failures = measured.filter((m) => m.least < m.need).map((m) => `${label}: ${m.kind} ${m.what} reads ${m.least.toFixed(2)}:1, under ${m.need}:1 (${m.over})`);
  return { measured, failures, excluded: read.excluded };
}

/* The few DOM shapes the page side reads: the e2e programs build without the DOM's types. */
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type DomNode = { nodeType: number; textContent: string | null };
type Css = Record<"opacity" | "backgroundImage" | "backgroundColor" | "clip" | "clipPath" | "overflow" | "fontSize" | "fontWeight" | "color" | "borderTopStyle" | "borderTopWidth" | "borderTopColor" | "outlineStyle" | "outlineWidth" | "outlineOffset" | "outlineColor" | "boxShadow", string>;
type El = DomNode & {
  tagName: string;
  value?: string;
  parentElement: El | null;
  childNodes: ArrayLike<DomNode>;
  ownerDocument: Doc;
  getAttribute(name: string): string | null;
  closest(selector: string): El | null;
  matches(selector: string): boolean;
  contains(other: unknown): boolean;
  getBoundingClientRect(): Rect;
  checkVisibility(options?: object): boolean;
  querySelectorAll(selector: string): ArrayLike<El>;
};
type Doc = {
  defaultView: Win | null;
  documentElement: El;
  body: El;
  adoptedStyleSheets: unknown[];
  querySelector(selector: string): El | null;
  elementsFromPoint(x: number, y: number): El[];
  createRange(): { selectNodeContents(node: DomNode): void; getClientRects(): ArrayLike<Rect> };
};
type Win = { innerWidth: number; innerHeight: number; getComputedStyle(el: El): Css; CSSStyleSheet: new () => { replaceSync(text: string): void } };

/**
 * The page side. A plain function given to evaluate, so it names nothing
 * from this module: the board is the map's canvas or the map's column,
 * the parent of the map's focus target (pages/Room.tsx).
 */
function readSamples(rootArg: unknown, opts: { halo: string; ringOnly: boolean }): { samples: Sample[]; excluded: Record<string, number>; page: string } {
  const root = rootArg as El;
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const css = (el: El) => win.getComputedStyle(el);
  const mapColumn = doc.querySelector('[role="img"][aria-label="Map"][data-rvtt-ring]')?.parentElement ?? null;
  const excluded: Record<string, number> = {};
  const exclude = (why: string) => (excluded[why] = (excluded[why] ?? 0) + 1);
  const samples: Sample[] = [];

  // Every box paints, so every box is in the stack the browser reports.
  const sheet = new win.CSSStyleSheet();
  sheet.replaceSync("* { pointer-events: auto !important; }");
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];

  const name = (el: El): string => {
    const label = el.getAttribute("aria-label");
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const tag = el.tagName.toLowerCase();
    return `<${tag}>${label ? ` [${label}]` : ""}${text ? ` "${text}"` : ""}`;
  };

  /** Colors a background image paints: a gradient's stops, or null for an image. */
  const imageColors = (image: string): string[] | null => {
    if (image === "none") return [];
    if (/url\(/.test(image)) return null;
    return image.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g) ?? [];
  };

  /** The grounds under a point, from the nearest down, skipping `skip` and what it holds. */
  const groundsAt = (x: number, y: number, skip: El | null, from: El | null): { grounds: string[][]; board: boolean; image: boolean } | null => {
    if (x < 0 || y < 0 || x >= win.innerWidth || y >= win.innerHeight) return null;
    const stack = doc.elementsFromPoint(x, y);
    let i = from ? stack.indexOf(from) : 0;
    if (i < 0) return null;
    const grounds: string[][] = [];
    for (; i < stack.length; i++) {
      const el = stack[i]!;
      if (skip && skip !== el && skip.contains(el)) continue;
      if (skip === el) continue;
      if (el.tagName === "CANVAS" || el === mapColumn) return { grounds, board: true, image: false };
      if (el.tagName === "HTML") break;
      const s = css(el);
      if (Number(s.opacity) === 0) continue;
      const fromImage = imageColors(s.backgroundImage);
      if (fromImage === null) return { grounds, board: false, image: true };
      // A gradient paints over the element's own color.
      if (fromImage.length > 0) grounds.push(fromImage);
      const bg = s.backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        grounds.push([bg]);
        const a = /rgba\([^)]*,\s*([\d.]+)\)$/.exec(bg);
        if (!a || Number(a[1]) >= 0.999) return { grounds, board: false, image: false };
      }
    }
    return { grounds, board: false, image: false };
  };

  const opacityOf = (el: El): number => {
    let o = 1;
    for (let e: El | null = el; e; e = e.parentElement) o *= Number(css(e).opacity);
    return o;
  };

  const visuallyHidden = (el: El): boolean => {
    for (let e: El | null = el; e && e !== doc.body; e = e.parentElement) {
      const s = css(e);
      if (s.clip.startsWith("rect(0") || s.clipPath === "inset(50%)") return true;
      const r = e.getBoundingClientRect();
      if (r.width <= 1 && r.height <= 1 && s.overflow === "hidden") return true;
    }
    return false;
  };

  const off = (el: El): boolean => el.closest(':disabled, [aria-disabled="true"]') !== null;

  try {
    if (opts.ringOnly) {
      // A control marked to ring its pill draws the ring on its pill, not on its larger target (globals.css `[data-pill-focus]`).
      const el = (root.matches("[data-pill-focus]") ? root.querySelectorAll(":scope > [data-pill]")[0] : undefined) ?? root;
      const s = css(el);
      const r = el.getBoundingClientRect();
      const width = Number.parseFloat(s.outlineWidth);
      if (s.outlineStyle === "none" || width === 0) {
        samples.push({ kind: "ring", what: `${name(el)} (no ring)`, color: "rgba(0, 0, 0, 0)", opacity: 1, grounds: [], board: false, large: false });
      } else {
        // The middle of the ring's line, on each side.
        const d = Number.parseFloat(s.outlineOffset) + width / 2;
        const halo = s.boxShadow.includes(opts.halo);
        const points = [
          [r.left - d, r.top + r.height / 2],
          [r.right + d, r.top + r.height / 2],
          [r.left + r.width / 2, r.top - d],
          [r.left + r.width / 2, r.bottom + d],
        ] as const;
        for (const [x, y] of points) {
          // An inset ring lies on the element itself, an outset one beside it.
          const g = groundsAt(x, y, d < 0 ? null : el, null);
          if (!g) continue;
          if (g.image) {
            exclude("an image under the ring");
            continue;
          }
          samples.push({ kind: "ring", what: `${name(el)}${halo ? " on its halo" : ""}`, color: s.outlineColor, opacity: 1, grounds: halo ? [[opts.halo], ...g.grounds] : g.grounds, board: g.board, large: false });
        }
      }
      return { samples, excluded, page: css(doc.documentElement).backgroundColor };
    }

    const all: El[] = [root, ...Array.from(root.querySelectorAll("*"))];
    for (const el of all) {
      if (el.closest("svg, canvas, img, picture, video")) continue;
      const s = css(el);
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;

      // A field's or switch's outline, against what lies beside it.
      const control = el.matches('input:not([type="radio"], [type="checkbox"], [type="range"], [type="hidden"], [type="color"], [type="file"]), select, textarea, [role="switch"]');
      if (control && !off(el)) {
        const bw = Number.parseFloat(s.borderTopWidth);
        if (s.borderTopStyle !== "none" && bw > 0) {
          const g = groundsAt(box.left + box.width / 2, box.top - 1, el, null) ?? groundsAt(cx, cy, el, el);
          if (g && !g.image) samples.push({ kind: "outline", what: name(el), color: s.borderTopColor, opacity: opacityOf(el), grounds: g.grounds, board: g.board, large: false });
        }
      }

      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
      const fieldText = el.matches("input, textarea, select") && (el.value ?? "") !== "";
      if (!ownText && !fieldText) continue;
      if (visuallyHidden(el)) {
        exclude("visually hidden text");
        continue;
      }
      if (off(el)) {
        exclude("an off control's words");
        continue;
      }
      // The words' own line, not the box's middle, which padding may push off them.
      let x = cx;
      let y = cy;
      if (ownText) {
        const range = doc.createRange();
        const node = Array.from(el.childNodes).find((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "")!;
        range.selectNodeContents(node);
        const rect = range.getClientRects()[0];
        if (rect) {
          x = rect.left + Math.min(rect.width / 2, 4);
          y = rect.top + rect.height / 2;
        }
      }
      const g = groundsAt(x, y, null, el);
      if (!g) {
        exclude("off screen or covered");
        continue;
      }
      if (g.image) {
        exclude("text on an image");
        continue;
      }
      const size = Number.parseFloat(s.fontSize);
      const weight = Number(s.fontWeight);
      const sign = ownText && (el.textContent ?? "").trim().length <= 2 && el.closest('[aria-hidden="true"]') !== null;
      samples.push({ kind: sign ? "sign" : "text", what: name(el), color: s.color, opacity: opacityOf(el), grounds: g.grounds, board: g.board, large: size >= 24 || (size >= 18.66 && weight >= 700) });
    }
    return { samples, excluded, page: css(doc.documentElement).backgroundColor };
  } finally {
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
  }
}

/**
 * The colors a light page must never show inside a part that keeps the
 * dark look (D-261102-364): the light palette's values that dark does not
 * share, as the browser writes them.
 */
export function lightOnly(): Set<string> {
  const dark = new Set(Object.values(PALETTES.dark).map((v) => normal(v)));
  return new Set(Object.values(PALETTES.light).map((v) => normal(v)).filter((v) => !dark.has(v)));
}

/** A color as `rgb()` or `rgba()` with the browser's spacing, so a computed style compares with a palette value. */
export function normal(css: string): string {
  const c = parseColor(css);
  const rgb = `${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}`;
  return c.a >= 0.999 ? `rgb(${rgb})` : `rgba(${rgb}, ${Number(c.a.toFixed(3))})`;
}

/**
 * Every color a part's elements draw with, as computed: its words' color
 * where it holds words, an SVG shape's fill and stroke, and every box's
 * ground, borders and outline. An inherited text color on a box with no
 * words of its own draws nothing, so it is not read.
 */
export function partColors(root: Locator): Promise<{ what: string; prop: string; value: string }[]> {
  return root.evaluate((rootEl) => {
    const el = rootEl as unknown as El;
    const win = el.ownerDocument.defaultView!;
    const out: { what: string; prop: string; value: string }[] = [];
    for (const e of [el, ...Array.from(el.querySelectorAll("*"))]) {
      if (!e.checkVisibility({ visibilityProperty: true })) continue;
      const s = win.getComputedStyle(e) as Css & { fill: string; stroke: string };
      const what = `<${e.tagName.toLowerCase()}> "${(e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30)}"`;
      const words = Array.from(e.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
      if (words) out.push({ what, prop: "color", value: s.color });
      if (e.closest("svg")) {
        if (s.fill && s.fill !== "none" && !s.fill.startsWith("url(")) out.push({ what, prop: "fill", value: s.fill });
        if (s.stroke && s.stroke !== "none" && !s.stroke.startsWith("url(")) out.push({ what, prop: "stroke", value: s.stroke });
      }
      out.push({ what, prop: "background-color", value: s.backgroundColor });
      if (s.borderTopStyle !== "none") out.push({ what, prop: "border-color", value: s.borderTopColor });
      if (s.outlineStyle !== "none") out.push({ what, prop: "outline-color", value: s.outlineColor });
    }
    return out;
  });
}
