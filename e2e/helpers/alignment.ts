import type { Locator, Page } from "playwright-core";

/**
 * The alignment check (docs/design-v1-polish.md 4): what the polish pass
 * measured by hand, kept as a test, so a screen that drifts off its
 * middle fails a run rather than waiting for someone to notice.
 *
 * measureAlignment runs five checks in the page over everything under a
 * root, and returns what is off by more than LIMIT_PX:
 *
 * 1. Centering: each column of content (text line boxes, icons, nested
 *    controls) in the middle of its control's or painted box's inner box,
 *    and a painted box's padding even above and below.
 * 2. One row: the parts of a flex or grid row share a middle, and the
 *    boxes among them a height.
 * 3. Same kind: sibling controls of one tag and role share a height, a
 *    side padding and a gap.
 * 4. Edges: a column of rows starts each row's words at one left edge.
 * 5. Wrapping: a name alone on its line above its control, or one part
 *    alone on a wrapped row's last line.
 *
 * A line of text is measured by its line box, as CSS lays it out: the
 * text's Range rect grown by half the leading above and below. In a
 * block that lays its lines from its top, a line within a pixel of the
 * block's own line is put on it, since the browser rounds a font's ascent
 * and descent to whole pixels. Words moved on purpose (a relative offset,
 * a transform or a vertical alignment on any element between them and
 * their block) are never put back. What a scroller inside the measured
 * part hides is not seen. What takes a tap is one box to the eye, painted
 * or not, and what it holds is centered in it.
 *
 * What the checks leave out, each for a reason, each with a drawn case
 * in e2e/alignment.e2e.ts (pl3-0):
 * - A row set on its baseline means its words to share a baseline, not a
 *   middle (hit points).
 * - A row set at its start means each part to meet the first line beside
 *   it, so its parts are compared by their first lines: a checkbox's box
 *   against its label's first line, a remove against its fields' first
 *   line. A part that lays out its own row has the first line it lays
 *   out, controls included. A row set in its middle compares middles,
 *   which is how a switch stands against its name and help together. In
 *   a mixed row the alignment most parts take decides, and a tie is
 *   judged both ways. A row whose parts all stretch places none of them,
 *   so it passes when they share either their middles or their first
 *   lines.
 * - A `role="img"` is one picture, its insides drawn on purpose (the AC
 *   shield sets its number above its middle).
 * - Content placed absolutely beside content in the flow (a badge, a
 *   ring around a die) is placed against its containing block on purpose.
 *   A control whose only content is placed so is measured by it.
 * - A disclosure's body starts under its chevron, not its title, and an
 *   open one lays its body from the top, so its box keeps no middle.
 * - A part that asks for a line of its own (`flex-basis: 100%`, as a
 *   row's hint), or grows to fill the line it wrapped onto within the
 *   limit (a window's buttons share each line), never counts as alone.
 * - A set of choices wraps any of them alone: a radio group, or parts
 *   each rounded down half their height at both ends (chips' pills, and
 *   circles). It is one list, not a line of different parts. A part
 *   rounded less is no chip. A grid of tiles is not a wrapping row at all.
 * - A heading or a paragraph above what follows is a title or a
 *   sentence, not a field's name (a section label puts its action under
 *   itself when both do not fit, components/Panel.tsx).
 * - A pane's header band and a pane's frame are placed by
 *   the header check instead, since the band's room above its row is
 *   set by the frame (components/SheetHeader.tsx).
 * - Kin that hold different lines of words, in number or in height (a
 *   name on two lines over one line of help), or different rows of
 *   boxes, are compared only among themselves, since the one is meant to
 *   be taller. An icon beside the words changes nothing.
 * - An edge is where two rows or more start. A row starts where what it
 *   holds starts. A row that draws a box (a notice, a chosen option, a
 *   full-width button) may start at its box's edge instead: a stacked
 *   foot's full-width buttons center their words, and a chosen option's
 *   fill stands its padding outside words that line up with its unchosen
 *   kin. A label, list item or group that draws nothing starts only where
 *   what it holds starts. What is set centered or at the end, as a
 *   field row's field at its right, is no edge. Three rows that each
 *   start apart share none. A nested list or group set in by its own
 *   padding or margin is a column of its own when it sits an indent step
 *   (INDENT_PX) or more past the column's edge. Set in by less, it has
 *   drifted.
 *
 * Three named checks cover what the five cannot see: pillLines (board
 * pills drawn by Konva inside the canvas's visible part, a pointed one
 * across only, its pointer on its point), headerLines with headerPlaces
 * (every pane's and window's Close and title where a map pane's header
 * puts them under its frame's top) and toastLaneLines (a toast under an
 * alert card takes the card's left and right edges). leadLines reads a
 * line of linked tokens row by row: each kind's word starts its row.
 *
 * Each check returns readable lines, so a sweep gathers every screen's
 * lines before it fails. None passes by reading nothing: a pill check
 * with no stage or no pill, and a lead check with no group or no word,
 * report that. measureAlignment over a root that matches nothing returns
 * nothing, so its caller requires the root (e2e/alignment.e2e.ts Sweep).
 * With E2E_ALIGN_DEBUG=1 a row's line also gives each part's boxes.
 */

/** The most a part may be off, in CSS px. Offsets are rounded to 0.1 px first, so layout rounding at 130% (1.0 px) passes. */
export const LIMIT_PX = 1;

/** The interface's indent step (theme.space(3)), in CSS px: the least a nested list or group is set in to make a column of its own. */
export const INDENT_PX = 12;

export type Box = { l: number; r: number; t: number; b: number };

export type Finding = {
  check: "center" | "pad" | "row" | "row-height" | "kind-height" | "kind-padding" | "kind-gap" | "edge" | "wrap-label" | "wrap-orphan";
  /** The element's tag, with its role when it has one. */
  role: string;
  /** Its accessible name, or the start of its text. */
  name: string;
  /** How far off, in CSS px, rounded to 0.1. */
  offset: number;
  box: Box;
  /** The parts that are off. */
  what: string;
  detail: string;
};

/*
 * The page code below runs in the browser through evaluate, so it holds
 * everything it uses, and reads the DOM through the few shapes named
 * here: e2e is typechecked without the DOM's types.
 */
type DomRect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type DomStyle = {
  display: string;
  position: string;
  visibility: string;
  opacity: string;
  flexWrap: string;
  flexDirection: string;
  flexBasis: string;
  alignItems: string;
  alignSelf: string;
  lineHeight: string;
  fontSize: string;
  backgroundColor: string;
  borderTopLeftRadius: string;
  getPropertyValue(name: string): string;
};
type DomNode = { nodeType: number; textContent: string | null; parentElement: DomElement | null; childNodes: ArrayLike<DomNode> };
type DomElement = DomNode & {
  tagName: string;
  children: ArrayLike<DomElement>;
  offsetWidth: number;
  offsetHeight: number;
  /** The zoom the element is drawn at, every zoomed ancestor's taken together. */
  currentCSSZoom?: number;
  innerText?: string;
  ownerDocument: DomDocument;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  closest(selector: string): DomElement | null;
  contains(other: DomNode): boolean;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getBoundingClientRect(): DomRect;
};
type DomRange = { selectNodeContents(node: DomNode): void; getClientRects(): ArrayLike<DomRect> };
type DomDocument = {
  createRange(): DomRange;
  getElementById(id: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  defaultView: { getComputedStyle(el: DomElement): DomStyle; innerWidth: number; innerHeight: number };
};

type PageOptions = { limit: number; indent: number; stickyHeader: string; debug: boolean };

/** The marks of components/SheetHeader.tsx's sticky header (STICKY_HEADER_ATTR), whose band the frame places. */
const STICKY_HEADER = "[data-sticky-header]";

/**
 * The five checks over every element under each root, in the page. It
 * is one function so evaluate can send it whole.
 */
function measureInPage(roots: DomElement[], opts: PageOptions): Finding[] {
  const LIMIT = opts.limit;
  const INDENT_PX = opts.indent;
  const doc = roots[0]?.ownerDocument;
  if (!doc) return [];
  const win = doc.defaultView;
  const CONTROL =
    'button, a[href], [role="button"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="status"], [role="alert"], li, label, summary, input, select, textarea, [data-alert], [role="group"], [role="radiogroup"]';
  // What takes a tap is one box to the eye, painted or not. A live region, a list item or a group with no box of its own is looked into.
  const INTERACTIVE =
    'button, a[href], [role="button"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], summary, input, select, textarea';
  const CONTAINER_ROLES = ["group", "radiogroup", "dialog", "toolbar", "tabpanel", "region"];
  const FIELD = ["input", "select", "textarea"];
  const PICTURE = ["svg", "img", "canvas"];

  /** A part of what the eye reads. `start` marks a part set at its line's start, not centered or at the end, the only kind an edge follows. */
  type Atom = Box & { kind: "text" | "icon" | "box"; what: string; start?: boolean };
  type Item = { node: DomNode; v: Box; first: Box; box: Box; boxed: boolean; mode: "center" | "start" | "baseline" | "other"; what: string };

  const style = (el: DomElement) => win.getComputedStyle(el);
  const num = (cs: DomStyle, prop: string) => parseFloat(cs.getPropertyValue(prop)) || 0;
  const mid = (r: Box) => (r.t + r.b) / 2;
  const round = (n: number) => Math.round(n * 10) / 10;
  const tag = (el: DomElement) => el.tagName.toLowerCase();
  const isEl = (n: DomNode): n is DomElement => n.nodeType === 1;

  function alpha(color: string): number {
    if (!color || color === "transparent") return 0;
    const m = /rgba?\(([^)]+)\)/.exec(color);
    if (!m) return 1;
    const parts = (m[1] ?? "").split(/[ ,/]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3] ?? "1") : 1;
  }

  function shown(el: DomElement): boolean {
    const cs = style(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1.5 && r.height > 1.5;
  }

  const placedApart = (el: DomElement) => ["absolute", "fixed"].includes(style(el).position);

  /** Whether the element draws a box of its own: a fill, or a border on three sides or more. */
  function paints(el: DomElement, cs = style(el)): boolean {
    if (alpha(cs.backgroundColor) > 0.02) return true;
    let sides = 0;
    for (const s of ["top", "right", "bottom", "left"]) {
      if (num(cs, `border-${s}-width`) > 0 && cs.getPropertyValue(`border-${s}-style`) !== "none" && alpha(cs.getPropertyValue(`border-${s}-color`)) > 0.02) sides++;
    }
    return sides >= 3;
  }

  // The zoom the browser reports, not the drawn height over offsetHeight: offsetHeight is a whole number, which sets that ratio 2% off on a 20 px line at 130% and moves its line box half a pixel.
  const zoomOf = (el: DomElement) => {
    const z = el.currentCSSZoom ?? (el.offsetHeight > 0 ? el.getBoundingClientRect().height / el.offsetHeight : 1);
    return Number.isFinite(z) && z > 0 ? z : 1;
  };

  /**
   * A text fragment's line box. In a block that lays its lines from its
   * top, it is that block's line: its content box's top and a line-height
   * per line. Elsewhere it is the fragment's content area grown by the
   * half-leading, which CSS puts equally above and below. The block's
   * line is the truer one: the browser rounds a font's ascent and descent
   * to whole pixels, which can set the content area a pixel off its line.
   */
  function lineBox(r: DomRect, parent: DomElement): { t: number; b: number } {
    const lh = parseFloat(style(parent).lineHeight);
    if (!Number.isFinite(lh)) return { t: r.top, b: r.bottom };
    const lhPx = lh * zoomOf(parent);
    const half = (lhPx - (r.bottom - r.top)) / 2;
    const own = { t: r.top - half, b: r.bottom + half };
    // The block the line belongs to, and whether anything between the words and it moves them on purpose: a relative offset, a transform or a vertical alignment. Words moved on purpose are never snapped back.
    let block: DomElement | null = parent;
    let moved = false;
    while (block && ["inline", "contents"].includes(style(block).display)) {
      if (placedOff(block)) moved = true;
      block = block.parentElement;
    }
    if (moved || !block || !["block", "flow-root", "list-item", "inline-block"].includes(style(block).display) || parseFloat(style(block).lineHeight) !== lh) return own;
    const bs = style(block);
    const top = block.getBoundingClientRect().top + ((parseFloat(bs.getPropertyValue("border-top-width")) || 0) + (parseFloat(bs.getPropertyValue("padding-top")) || 0)) * zoomOf(block);
    const i = Math.round((own.t - top) / lhPx);
    const t = top + i * lhPx;
    // Only the rounding of a font's metrics, at most a pixel, is put back. A line further off the grid, as beside a taller inline control, keeps the text's own estimate.
    return i >= 0 && Math.abs(t - own.t) <= 1 ? { t, b: t + lhPx } : own;
  }

  /** Whether an inline element moves its words off their line on purpose. */
  function placedOff(el: DomElement): boolean {
    const cs = style(el);
    const offset = (side: string) => {
      const v = cs.getPropertyValue(side);
      return v !== "auto" && v !== "" && parseFloat(v) !== 0;
    };
    if (cs.position === "relative" && (offset("top") || offset("bottom"))) return true;
    if (cs.getPropertyValue("transform") !== "none") return true;
    return cs.getPropertyValue("vertical-align") !== "baseline";
  }

  function rectOf(el: DomElement): Box {
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom };
  }

  /** An element's border box, its box inside the border, and its padding, in page px (computed lengths are unzoomed). */
  function boxes(el: DomElement) {
    const r = el.getBoundingClientRect();
    const cs = style(el);
    const zoom = zoomOf(el);
    const side = (prop: string) => num(cs, prop) * zoom;
    const border = { l: r.left, r: r.right, t: r.top, b: r.bottom };
    const inner = { l: r.left + side("border-left-width"), r: r.right - side("border-right-width"), t: r.top + side("border-top-width"), b: r.bottom - side("border-bottom-width") };
    const pad = { t: side("padding-top"), b: side("padding-bottom"), l: side("padding-left"), r: side("padding-right") };
    return { border, inner, pad };
  }

  function roleOf(el: DomElement): string {
    const role = el.getAttribute("role");
    return tag(el) + (role ? `[${role}]` : "");
  }

  function nameOf(el: DomElement): string {
    const label = el.getAttribute("aria-label");
    if (label) return label.slice(0, 48);
    return (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
  }

  const say = (el: DomElement) => `${roleOf(el)} "${nameOf(el)}"`;

  const isPicture = (el: DomElement) => PICTURE.includes(tag(el)) || el.getAttribute("role") === "img";

  /** Whether an element cuts what overflows it, as a scroller or an ellipsis does. */
  const clips = (el: DomElement) => {
    const cs = style(el);
    return cs.getPropertyValue("overflow-x") !== "visible" || cs.getPropertyValue("overflow-y") !== "visible";
  };

  /**
   * What the eye reads as content: text line boxes, pictures, and boxes
   * (what takes a tap, and painted boxes), not looking inside the last
   * two. What a scroller or a cut inside `container` hides is not seen,
   * and what it cuts is seen as far as it shows. The page's own scrollers
   * around `container` are left alone, so a row scrolled out of view is
   * still measured.
   */
  function atomsOf(container: DomElement, placed = false): Atom[] {
    const out: Atom[] = [];
    const add = (a: Atom, clip: Box | null) => {
      if (!clip) return out.push(a);
      const cut = { ...a, l: Math.max(a.l, clip.l), r: Math.min(a.r, clip.r), t: Math.max(a.t, clip.t), b: Math.min(a.b, clip.b) };
      if (cut.r - cut.l > 1 && cut.b - cut.t > 1) out.push(cut);
    };
    const walk = (node: DomElement, clip: Box | null) => {
      for (const ch of Array.from(node.childNodes)) {
        if (ch.nodeType === 3) {
          const words = (ch.textContent ?? "").trim();
          const parent = ch.parentElement;
          if (!words || !parent || !shown(parent)) continue;
          const range = doc!.createRange();
          range.selectNodeContents(ch);
          for (const r of Array.from(range.getClientRects())) {
            if (r.width <= 1 || r.height <= 1) continue;
            const lb = lineBox(r, parent);
            const line: Atom = { kind: "text", l: r.left, r: r.right, t: lb.t, b: lb.b, what: `"${words.slice(0, 32)}"`, start: setAtStart(parent, container) };
            // A line whose glyphs all show is seen whole, its leading too, though the leading runs past a cut.
            if (clip && r.top >= clip.t - 1 && r.bottom <= clip.b + 1) add(line, null);
            else add(line, clip);
          }
        } else if (isEl(ch)) {
          if (!shown(ch) || (placedApart(ch) && !(placed && style(ch).position === "absolute"))) continue;
          const start = setAtStart(node, container);
          if (isPicture(ch)) add({ kind: "icon", ...rectOf(ch), what: ch.getAttribute("role") === "img" ? `img "${ch.getAttribute("aria-label") ?? ""}"` : tag(ch), start }, clip);
          else if (FIELD.includes(tag(ch)) || ch.matches(INTERACTIVE) || paints(ch)) add({ kind: "box", ...rectOf(ch), what: say(ch), start }, clip);
          else walk(ch, clips(ch) ? cutBy(clip, rectOf(ch)) : clip);
        }
      }
    };
    walk(container, clips(container) ? rectOf(container) : null);
    return out;
  }

  /** Whether what `parent` holds is set at its line's start: no centered or end text alignment, and no flex row between it and `top` that centers or ends its parts. */
  function setAtStart(parent: DomElement, top: DomElement): boolean {
    if (/center|right|end/.test(style(parent).getPropertyValue("text-align"))) return false;
    for (let n: DomElement | null = parent; n && n !== top.parentElement; n = n.parentElement) {
      const cs = style(n);
      if ((cs.display === "flex" || cs.display === "inline-flex") && !cs.flexDirection.startsWith("column") && /center|end|space-around|space-evenly/.test(cs.getPropertyValue("justify-content"))) return false;
    }
    return true;
  }

  function cutBy(clip: Box | null, r: Box): Box {
    return clip ? { l: Math.max(clip.l, r.l), r: Math.min(clip.r, r.r), t: Math.max(clip.t, r.t), b: Math.min(clip.b, r.b) } : r;
  }

  function union(list: readonly Box[]): Box {
    return { l: Math.min(...list.map((a) => a.l)), r: Math.max(...list.map((a) => a.r)), t: Math.min(...list.map((a) => a.t)), b: Math.max(...list.map((a) => a.b)) };
  }

  /** Boxes that overlap down the page, more than a pixel, are one line. */
  function linesOf<T extends Box>(list: readonly T[]): { box: Box; items: T[] }[] {
    const out: { box: Box; items: T[] }[] = [];
    for (const it of [...list].sort((a, c) => a.t - c.t || a.l - c.l)) {
      const line = out.find((ln) => it.t < ln.box.b - 1 && it.b > ln.box.t + 1);
      if (line) {
        line.items.push(it);
        line.box = union([line.box, it]);
      } else out.push({ box: { ...it }, items: [it] });
    }
    return out.sort((a, c) => a.box.t - c.box.t);
  }

  /** Atoms that overlap across are one stack, read as one column of content. */
  function stacksOf(atoms: readonly Atom[]): { box: Box; items: Atom[] }[] {
    const out: { l: number; r: number; items: Atom[] }[] = [];
    for (const a of [...atoms].sort((x, y) => x.l - y.l)) {
      const last = out[out.length - 1];
      if (last && a.l < last.r - 0.5) {
        last.items.push(a);
        last.r = Math.max(last.r, a.r);
      } else out.push({ l: a.l, r: a.r, items: [a] });
    }
    return out.map((s) => ({ box: union(s.items), items: s.items }));
  }

  /** Whether an element is one box in a row: a picture, a field, what takes a tap, or something that paints. What a control holds is the centering check's business. */
  const oneBox = (el: DomElement) => isPicture(el) || FIELD.includes(tag(el)) || el.matches(INTERACTIVE) || paints(el);

  /** What the eye sees of a node, all of it and its first line: one box (oneBox) is itself, anything else what it holds. */
  function seen(node: DomNode): { v: Box; first: Box } | null {
    if (node.nodeType === 3) {
      const parent = node.parentElement;
      if (!parent) return null;
      const range = doc!.createRange();
      range.selectNodeContents(node);
      const rs = Array.from(range.getClientRects())
        .filter((r) => r.width > 1 && r.height > 1)
        .map((r) => ({ l: r.left, r: r.right, ...lineBox(r, parent) }));
      if (!rs.length) return null;
      return { v: union(rs), first: firstLineOf(rs) };
    }
    if (!isEl(node)) return null;
    if (oneBox(node)) {
      const r = rectOf(node);
      return { v: r, first: r };
    }
    const atoms = atomsOf(node);
    if (!atoms.length) return null;
    return { v: union(atoms), first: laidFirstLine(node) ?? firstLineOf(atoms) };
  }

  /**
   * The first line a flex or grid container lays out, as a box: its parts
   * on that line, or its whole content box when it lays one line of words
   * alone. A part stands in its line as its container sets it, so a name
   * centered in a 44 px line meets a 44 px button beside it there, though
   * its own words run over two lines. Null for any other element.
   */
  function laidFirstLine(el: DomElement): Box | null {
    const cs = style(el);
    const flex = (cs.display === "flex" || cs.display === "inline-flex") && !cs.flexDirection.startsWith("column");
    if (!flex && cs.display !== "grid" && cs.display !== "inline-grid") return null;
    const parts = Array.from(el.children).filter((c) => shown(c) && !placedApart(c)).map(rectOf);
    if (parts.length === 0) {
      if (!flex) return null;
      const b = boxes(el);
      return { l: b.inner.l + b.pad.l, r: b.inner.r - b.pad.r, t: b.inner.t + b.pad.t, b: b.inner.b - b.pad.b };
    }
    return linesOf(parts)[0]!.box;
  }

  /** The first line: the topmost part, and what stands beside it, the parts whose middles fall within it. Lines of tight leading may overlap, so overlap alone would join them. */
  function firstLineOf(parts: readonly Box[]): Box {
    const top = [...parts].sort((a, c) => a.t - c.t)[0]!;
    return union(parts.filter((p) => mid(p) >= top.t && mid(p) <= top.b));
  }

  /** A box's top left corner, how far it rounds down its side: a percent of its height, or px. A part rounded down half its height at both ends is a chip's pill, or a circle. */
  function cornerDown(el: DomElement, height: number): number {
    const values = style(el).borderTopLeftRadius.trim().split(/\s+/);
    const down = values[1] ?? values[0] ?? "0";
    return down.endsWith("%") ? (parseFloat(down) / 100) * height : parseFloat(down) || 0;
  }

  function modeOf(align: string): Item["mode"] {
    if (align.includes("baseline")) return "baseline";
    if (/(^|\s)center$/.test(align)) return "center";
    if (/(^|\s)(flex-start|start|self-start)$/.test(align)) return "start";
    return "other";
  }

  /**
   * Where a row of a column may start, for the edge check, as the eye
   * follows it down. Any row starts at the left of what it holds (boxes,
   * pictures and words) set at its line's start. What is centered or set
   * at the end, as a field row's field at its right, is no start. A row
   * that draws a box (a painted notice, a chosen option, a full-width
   * button) may start at its box's edge as well: a stacked foot's
   * full-width buttons center their words, and a chosen option's fill
   * stands its padding outside words that line up with its unchosen kin.
   * A label, list item or group that draws nothing starts only at what it
   * holds, since its box is not seen. `inset` marks a nested list or
   * group whose content starts at its own padding or margin, which the
   * column takes as a column of its own only when it sits an indent step
   * past the column's edge. Null for a disclosure, whose body starts under
   * its chevron, and for a row with nothing to start.
   */
  function edgeOf(row: DomElement): { lefts: number[]; inset: boolean } | null {
    if (row.matches("[aria-expanded]") || row.querySelector(":scope > [aria-expanded], :scope > * > [aria-expanded]")) return null;
    const parts = atomsOf(row).filter((a) => a.start);
    const left = parts.length ? Math.min(...parts.map((a) => a.l)) : null;
    if (paints(row)) return { lefts: [round(rectOf(row).l), ...(left === null ? [] : [round(left)])], inset: false };
    if (left === null) return null;
    let inset = false;
    if (row.matches('ul, ol, fieldset, [role="group"], [role="list"], [role="radiogroup"]')) {
      const b = boxes(row);
      const own = b.inner.l + b.pad.l;
      inset = Math.abs(left - own) <= LIMIT && (b.pad.l > LIMIT || (parseFloat(style(row).getPropertyValue("margin-left")) || 0) > LIMIT);
    }
    return { lefts: [round(left)], inset };
  }

  const spread = (xs: readonly number[]) => Math.max(...xs) - Math.min(...xs);
  const findings: Finding[] = [];
  const push = (f: Finding) => findings.push(f);

  function measureOne(root: DomElement): void {
    const all = [root, ...Array.from(root.querySelectorAll("*"))].filter((el) => shown(el));
    for (const el of all) {
      const t = tag(el);
      if (t === "svg" || el.closest("svg") !== null) continue;
      // A picture's insides are drawn on purpose.
      if (el.closest('[role="img"]') !== null) continue;
      const cs = style(el);
      const control = el.matches(CONTROL);
      const painted = paints(el, cs);
      const b = boxes(el);
      const height = b.border.b - b.border.t;
      const band = el.matches(opts.stickyHeader);
      const frame = el.getAttribute("role") === "dialog" || t === "dialog";

      // 1. Centering, for controls and painted boxes up to a card's size.
      const container = CONTAINER_ROLES.includes(el.getAttribute("role") ?? "") || t === "dialog" || t === "section" || t === "ul";
      // An open disclosure lays its body under its header from the top, so the box holding it has no middle to keep.
      const open = el.querySelector('[aria-expanded="true"]') !== null;
      if (!container && !band && !open && !FIELD.includes(t) && ((control && height <= 200) || (painted && height <= 120))) {
        // A control whose only content is placed absolutely is measured by that content. Beside content in the flow, such a part (a badge, a ring) is placed against its containing block on purpose.
        const flowing = atomsOf(el);
        const atoms = flowing.length ? flowing : atomsOf(el, true);
        if (atoms.length) {
          const stacks = stacksOf(atoms);
          // Where a stack runs over several lines, the stacks beside it are placed against it by the row check, so the content is centered as one.
          const several = stacks.some((s) => linesOf(s.items).length > 1);
          const judged = several ? [{ box: union(stacks.map((s) => s.box)), items: atoms }] : stacks;
          for (const s of judged) {
            const off = mid(s.box) - mid(b.inner);
            if (Math.abs(round(off)) > LIMIT) {
              push({
                check: "center",
                role: roleOf(el),
                name: nameOf(el),
                offset: round(off),
                box: b.border,
                what: s.items.map((a) => a.what).slice(0, 4).join(" + "),
                detail: `${round(s.box.t - b.inner.t)} px from the top and ${round(b.inner.b - s.box.b)} from the bottom of a ${round(b.inner.b - b.inner.t)} px box`,
              });
            }
          }
        }
      }

      // 1b. A painted box keeps the same room above and below its content.
      if (painted && !control && !band && !frame && height <= 200 && Math.abs(round(b.pad.t - b.pad.b)) > LIMIT) {
        push({ check: "pad", role: roleOf(el), name: nameOf(el), offset: round(b.pad.t - b.pad.b), box: b.border, what: `padding ${round(b.pad.t)} above, ${round(b.pad.b)} below`, detail: "" });
      }

      // 2. One row: the parts of a flex or grid row share a middle, or a first line where the row is set at its start.
      const flexRow = (cs.display === "flex" || cs.display === "inline-flex") && !cs.flexDirection.startsWith("column");
      const grid = cs.display === "grid" || cs.display === "inline-grid";
      if (flexRow || grid) {
        const items: Item[] = [];
        for (const ch of Array.from(el.childNodes)) {
          if (ch.nodeType === 3) {
            const words = (ch.textContent ?? "").trim();
            const s = words ? seen(ch) : null;
            if (s) items.push({ node: ch, ...s, box: s.v, boxed: false, mode: modeOf(cs.alignItems), what: `"${words.slice(0, 24)}"` });
          } else if (isEl(ch) && shown(ch) && !placedApart(ch)) {
            const s = seen(ch);
            if (!s) continue;
            const self = style(ch).alignSelf;
            items.push({ node: ch, ...s, box: rectOf(ch), boxed: FIELD.includes(tag(ch)) || paints(ch), mode: modeOf(self === "auto" ? cs.alignItems : self), what: say(ch) });
          }
        }
        const lines = linesOf(items.map((it) => ({ ...it.box, it }))).map((ln) => ({ box: ln.box, items: ln.items.map((x) => x.it) }));

        // 5. Wrapping: a name alone above its control, or one part alone on the last line.
        if (cs.flexWrap === "wrap" && lines.length >= 2) {
          const width = round(b.inner.r - b.inner.l);
          const ownLine = (it: Item) => isEl(it.node) && style(it.node).flexBasis === "100%";
          const words = (it: Item) => {
            if (!isEl(it.node)) return true;
            if (FIELD.includes(tag(it.node)) || it.node.matches(CONTROL) && !(tag(it.node) === "label" && !it.node.querySelector("input, select, textarea, button"))) return false;
            return !atomsOf(it.node).some((a) => a.kind !== "text");
          };
          const prose = (it: Item) => isEl(it.node) && /^(h[1-6]|p)$/.test(tag(it.node));
          const pill = (it: Item) => isEl(it.node) && cornerDown(it.node, it.box.b - it.box.t) >= (it.box.b - it.box.t) / 2 - 0.5;
          const choices = el.getAttribute("role") === "radiogroup" || items.every(pill);
          // A part that grows to fill its line is a line of its own, as a window's buttons share each line they wrap onto.
          const content = { l: b.inner.l + b.pad.l, r: b.inner.r - b.pad.r };
          const fills = (it: Item) => it.box.l <= content.l + LIMIT && it.box.r >= content.r - LIMIT;
          for (let i = 1; i < lines.length; i++) {
            const prev = lines[i - 1]!.items.filter((it) => !ownLine(it));
            const cur = lines[i]!.items.filter((it) => !ownLine(it));
            if (!prev.length || !cur.length) continue;
            if (i === 1 && prev.every(words) && !prev.some(prose) && cur.some((it) => !words(it))) {
              push({ check: "wrap-label", role: roleOf(el), name: nameOf(el), offset: round(mid(cur[0]!.box) - mid(prev[0]!.box)), box: union([...prev, ...cur].map((it) => it.box)), what: `${prev.map((it) => it.what).join(" + ")} alone above ${cur.map((it) => it.what).join(" + ")}`, detail: `in ${width} px` });
            } else if (i === lines.length - 1 && cur.length === 1 && prev.length >= 2 && !choices && !fills(cur[0]!)) {
              push({ check: "wrap-orphan", role: roleOf(el), name: nameOf(el), offset: round(mid(cur[0]!.box) - mid(prev[0]!.box)), box: union([...prev, ...cur].map((it) => it.box)), what: `${cur[0]!.what} alone under ${prev.map((it) => it.what).join(" + ")}`, detail: `in ${width} px` });
            }
          }
        }

        for (const ln of lines) {
          if (ln.items.length < 2) continue;
          ln.items.sort((a, c) => a.box.l - c.box.l);
          const modes = ln.items.map((it) => it.mode);
          if (!modes.includes("baseline")) {
            const middles = spread(ln.items.map((it) => mid(it.v)));
            const firsts = spread(ln.items.map((it) => mid(it.first)));
            // Parts set in the middle vote for middles, parts set at the start for first lines, and the most votes decide. A tie is judged both ways. A row whose parts all stretch places none of them, so it passes when they share either.
            const centers = modes.filter((m) => m === "center").length;
            const starts = modes.filter((m) => m === "start").length;
            const by = centers + starts === 0 ? (middles <= firsts ? "middles" : "first lines") : centers > starts ? "middles" : starts > centers ? "first lines" : middles >= firsts ? "middles" : "first lines";
            const off = by === "middles" ? middles : firsts;
            if (round(off) > LIMIT) {
              const base = Math.min(...ln.items.map((it) => mid(by === "middles" ? it.v : it.first)));
              push({
                check: "row",
                role: roleOf(el),
                name: nameOf(el),
                offset: round(off),
                box: union(ln.items.map((it) => it.box)),
                what: ln.items.map((it) => `${it.what} at ${round(mid(by === "middles" ? it.v : it.first) - base)}${opts.debug ? ` v ${round(it.v.t)}-${round(it.v.b)} first ${round(it.first.t)}-${round(it.first.b)}` : ""}`).join(" | "),
                detail: `${by}, align-items ${cs.alignItems}`,
              });
            }
          }
          const boxed = ln.items.filter((it) => it.boxed);
          if (boxed.length >= 2) {
            const off = spread(boxed.map((it) => it.box.b - it.box.t));
            if (round(off) > LIMIT) {
              push({ check: "row-height", role: roleOf(el), name: nameOf(el), offset: round(off), box: union(boxed.map((it) => it.box)), what: boxed.map((it) => `${it.what} ${round(it.box.b - it.box.t)} px`).join(" | "), detail: "" });
            }
          }
        }
      }

      // 3. Same kind: sibling controls of one tag, role, font size and corner share a height, a side padding and their gaps.
      const kids = Array.from(el.children).filter((c) => shown(c) && !placedApart(c));
      if (kids.length >= 2) {
        const kin = new Map<string, DomElement[]>();
        for (const c of kids) {
          if (!c.matches(CONTROL) || CONTAINER_ROLES.includes(c.getAttribute("role") ?? "") || tag(c) === "section") continue;
          const ccs = style(c);
          const key = `${tag(c)}|${c.getAttribute("role") ?? ""}|${ccs.fontSize}|${ccs.borderTopLeftRadius}`;
          kin.set(key, [...(kin.get(key) ?? []), c]);
        }
        for (const list of kin.values()) {
          if (list.length < 2) continue;
          // Kin are compared with kin that hold the same: lines of words as tall (a name over two lines and its help on one is not a name on one over two lines of help), and as many rows of boxes, such as an open group's fields. An icon beside the words changes neither. Every such group of two or more is checked.
          const byLines = new Map<string, DomElement[]>();
          for (const c of list) {
            const atoms = atomsOf(c);
            const words = linesOf(atoms.filter((a) => a.kind === "text")).map((ln) => Math.round((ln.box.b - ln.box.t) * 2) / 2);
            const n = `${words.join(",")}|${linesOf(atoms.filter((a) => a.kind === "box")).length}`;
            byLines.set(n, [...(byLines.get(n) ?? []), c]);
          }
          for (const same of byLines.values()) {
            if (same.length < 2) continue;
            const bs = same.map((c) => ({ c, b: boxes(c), worded: atomsOf(c).some((a) => a.kind === "text") }));
            const box = union(bs.map((x) => x.b.border));
            const hs = bs.map((x) => x.b.border.b - x.b.border.t);
            if (round(spread(hs)) > LIMIT) {
              push({ check: "kind-height", role: roleOf(el), name: nameOf(el), offset: round(spread(hs)), box, what: bs.map((x) => `${say(x.c)} ${round(x.b.border.b - x.b.border.t)} px`).join(" | "), detail: "" });
            }
            const worded = bs.filter((x) => x.worded);
            if (worded.length >= 2 && round(spread(worded.map((x) => x.b.pad.l))) > LIMIT) {
              push({ check: "kind-padding", role: roleOf(el), name: nameOf(el), offset: round(spread(worded.map((x) => x.b.pad.l))), box, what: worded.map((x) => `${say(x.c)} ${round(x.b.pad.l)} px`).join(" | "), detail: "left padding" });
            }
            const order = (c: DomElement) => kids.indexOf(c);
            const sorted = [...bs].sort((x, y) => order(x.c) - order(y.c));
            const gaps: number[] = [];
            for (let i = 1; i < sorted.length; i++) {
              if (order(sorted[i]!.c) !== order(sorted[i - 1]!.c) + 1) continue;
              const p = sorted[i - 1]!.b.border;
              const c = sorted[i]!.b.border;
              if (c.t >= p.b - 1) gaps.push(round(c.t - p.b));
              else if (c.l >= p.r - 1) gaps.push(round(c.l - p.r));
            }
            if (gaps.length >= 2 && round(spread(gaps)) > LIMIT) push({ check: "kind-gap", role: roleOf(el), name: nameOf(el), offset: round(spread(gaps)), box, what: `gaps ${gaps.join(", ")}`, detail: "" });
          }
        }
      }

      // 4. Edges: a column of three rows or more starts each row's words at one left edge.
      if (kids.length >= 3) {
        const rs = kids.map(rectOf);
        let stacked = true;
        for (let i = 1; i < rs.length; i++) if (rs[i]!.t < rs[i - 1]!.b - 1) stacked = false;
        if (stacked) {
          const known = kids.flatMap((c) => {
            const edge = edgeOf(c);
            return edge ? [{ c, ...edge }] : [];
          });
          if (known.length >= 3) {
            // The edge is where the most rows may start, each within the limit of it, read from the rows that are no nested list or group when two or more are.
            const near = (a: number, b: number) => Math.abs(a - b) <= LIMIT;
            const meets = (x: { lefts: number[] }, at: number) => x.lefts.some((l) => near(l, at));
            const plain = known.filter((x) => !x.inset);
            const voters = plain.length >= 2 ? plain : known;
            const mode = voters.flatMap((x) => x.lefts).sort((a, b) => voters.filter((y) => meets(y, b)).length - voters.filter((y) => meets(y, a)).length)[0]!;
            // A nested list or group an indent step or more past the edge is a column of its own. Set in by less, it has drifted.
            const step = INDENT_PX * zoomOf(el) - LIMIT;
            const counted = known.filter((x) => !(x.inset && x.lefts[0]! - mode >= step));
            const shared = counted.filter((x) => meets(x, mode)).length;
            const off = (x: { lefts: number[] }) => x.lefts.reduce((a, l) => (Math.abs(l - mode) < Math.abs(a - mode) ? l : a)) - mode;
            const odd = counted.filter((x) => !meets(x, mode)).map((x) => ({ c: x.c, left: mode + off(x) }));
            // An edge is where two rows or more start: three rows that each start apart, as a dialog's header, body and foot, share none.
            if (shared >= 2 && odd.length) {
              push({ check: "edge", role: roleOf(el), name: nameOf(el), offset: round(Math.max(...odd.map((x) => Math.abs(x.left - mode)))), box: union(odd.map((x) => rectOf(x.c))), what: odd.map((x) => `${say(x.c)} at ${round(x.left - mode)}`).join(" | "), detail: `most start at ${round(mode)}` });
            }
          }
        }
      }
    }
  }

  for (const root of roots) measureOne(root);
  return findings;
}

/** The five checks over everything under each element `root` matches. Nothing found when it matches nothing. */
export async function measureAlignment(root: Locator): Promise<Finding[]> {
  return root.evaluateAll(measureInPage, { limit: LIMIT_PX, indent: INDENT_PX, stickyHeader: STICKY_HEADER, debug: process.env.E2E_ALIGN_DEBUG === "1" });
}

/** One readable line per finding over the limit, for `screen`. */
export function alignmentLines(findings: readonly Finding[], screen: string): string[] {
  return findings.filter((f) => Math.abs(f.offset) > LIMIT_PX).map((f) => `${screen}: ${f.check} ${f.offset} px, ${f.role} "${f.name}": ${f.what}${f.detail ? ` (${f.detail})` : ""}`);
}


/** A board pill as Konva draws it: its words, its body and, for a pointed pill, its pointer's tip, in page px. */
type PillSeen = { text: string; body: Box; view: Box; pointed: boolean; tip: { x: number; y: number } | null };

/** Every board pill (a Konva Label) that shows, with its body, its pointer's tip, and the canvas's part inside the window, and how many stages there are. */
function pillsInPage(): { stages: number; pills: PillSeen[] } {
  type KRect = { x: number; y: number; width: number; height: number };
  type KNode = { isVisible(): boolean; getAbsoluteOpacity(): number; getClientRect(o?: { skipStroke?: boolean }): KRect };
  type KTag = KNode & {
    pointerDirection(): string;
    pointerHeight(): number;
    width(): number;
    height(): number;
    getAttr(name: string): unknown;
    getAbsoluteTransform(): { point(p: { x: number; y: number }): { x: number; y: number } };
  };
  type KLabel = KNode & { getTag(): KTag | undefined; getText(): (KNode & { text(): string }) | undefined };
  type KStage = { container(): { getBoundingClientRect(): DomRect }; find(selector: string): KLabel[] };
  const g = globalThis as unknown as { Konva?: { stages: KStage[] }; innerWidth: number; innerHeight: number };
  const stages = g.Konva?.stages ?? [];
  const pills: PillSeen[] = [];
  for (const stage of stages) {
    const host = stage.container().getBoundingClientRect();
    const view = { l: Math.max(0, host.left), t: Math.max(0, host.top), r: Math.min(g.innerWidth, host.right), b: Math.min(g.innerHeight, host.bottom) };
    for (const label of stage.find("Label")) {
      if (!label.isVisible() || label.getAbsoluteOpacity() < 0.3) continue;
      const tag = label.getTag();
      const r = (tag ?? label).getClientRect({ skipStroke: true });
      if (r.width < 2 || r.height < 2) continue;
      const direction = tag?.pointerDirection() ?? "none";
      const pointed = direction === "up" || direction === "down";
      // The tip as Konva's Tag draws it, at the middle of its edge, moved along it by `lean` where the pill leans its pointer (features/measure/Pill.tsx).
      const lean = Number(tag?.getAttr("lean") ?? 0) || 0;
      const local = tag && pointed ? { x: tag.width() / 2 + lean, y: direction === "down" ? tag.height() + tag.pointerHeight() : -tag.pointerHeight() } : null;
      const at = local && tag ? tag.getAbsoluteTransform().point(local) : null;
      pills.push({
        text: (label.getText()?.text() ?? "").replace(/\n/g, " / ").slice(0, 60),
        body: { l: host.left + r.x, t: host.top + r.y, r: host.left + r.x + r.width, b: host.top + r.y + r.height },
        view,
        pointed,
        tip: at ? { x: host.left + at.x, y: host.top + at.y } : null,
      });
    }
  }
  return { stages: stages.length, pills };
}

/**
 * A point a pointed pill names, in page px: a pill shown whose words
 * start with `words` must have its pointer's tip there. `required` makes
 * a missing pill a line of its own, for a pill that must show. A sweep
 * where the zoom may hide a name leaves it off and counts `matched`.
 */
export type PillPoint = { words: string; at: { x: number; y: number }; required?: boolean };

/** What the pill check found: a line for each fault, and the words of each point a pill pointed at. */
export type PillCheck = { lines: string[]; matched: string[] };

/**
 * The board pills against the canvas's visible part, and the pointed
 * pills of `points` against their points. A plain pill slides inside the
 * board on every side, and a pointed one only across, since sliding it
 * up or down would part its pointer from its point. A pill wholly out of
 * view is the camera's business, not the pill's. With no Konva stage on
 * the page, or with `needPills` and no pill drawn, it reports that, so it
 * never passes by reading nothing.
 */
export async function pillLines(page: Page, screen: string, opts: { points?: readonly PillPoint[]; needPills?: boolean } = {}): Promise<PillCheck> {
  const { stages, pills } = await page.evaluate(pillsInPage);
  const round = (n: number) => Math.round(n * 10) / 10;
  const lines: string[] = [];
  const matched: string[] = [];
  if (stages === 0) lines.push(`${screen}: no Konva stage on the page`);
  else if (opts.needPills && pills.length === 0) lines.push(`${screen}: no board pill drawn`);
  for (const p of pills) {
    const { body: a, view: v } = p;
    if (a.r <= v.l || a.l >= v.r || a.b <= v.t || a.t >= v.b) continue;
    const across = Math.max(v.l - a.l, a.r - v.r);
    const past = p.pointed ? across : Math.max(across, v.t - a.t, a.b - v.b);
    if (round(past) > LIMIT_PX) lines.push(`${screen}: pill "${p.text}" runs ${round(past)} px past the board's visible part`);
  }
  for (const point of opts.points ?? []) {
    const named = pills.filter((x) => x.pointed && x.tip && x.text.startsWith(point.words));
    if (named.length > 0) matched.push(point.words);
    else if (point.required) lines.push(`${screen}: no pointed pill reads "${point.words}"`);
    for (const p of named) {
      const off = Math.hypot(p.tip!.x - point.at.x, p.tip!.y - point.at.y);
      if (round(off) > LIMIT_PX) lines.push(`${screen}: pill "${p.text}" points ${round(off)} px off its point`);
    }
  }
  return { lines, matched };
}

/**
 * Where a pane's or window's header stands under its frame's top: its
 * Close's top and its title's middle, against where a map pane's header
 * puts them, a 44 px Close centered in a 48 px row under the frame's
 * border and top padding (components/SheetHeader.tsx). A sheet's header
 * that is its grab area stands lower by its pill's room, so its grabber
 * places it, not this check.
 */
export type HeaderPlace = { frame: string; close: number; title: number; wantClose: number; wantTitle: number };

/** The 48 px row a pane's header centers its 44 px buttons in. */
const PANE_ROW_PX = 48;

function headerInPage(frames: DomElement[], rowPx: number): HeaderPlace[] {
  const out: HeaderPlace[] = [];
  // As in measureInPage, the zoom the browser reports. This function goes to the page whole, so it keeps its own copy.
  const zoomOf = (el: DomElement) => {
    const z = el.currentCSSZoom ?? (el.offsetHeight > 0 ? el.getBoundingClientRect().height / el.offsetHeight : 1);
    return Number.isFinite(z) && z > 0 ? z : 1;
  };
  const round = (n: number) => Math.round(n * 10) / 10;
  for (const frame of frames) {
    const doc = frame.ownerDocument;
    const style = (el: DomElement) => doc.defaultView.getComputedStyle(el);
    const box = frame.getBoundingClientRect();
    const zoom = zoomOf(frame);
    const named = frame.getAttribute("aria-labelledby");
    const title = (named ? doc.getElementById(named) : null) ?? frame.querySelector("strong");
    if (!title || !frame.contains(title)) continue;
    let row = title.parentElement;
    while (row && row !== frame && !row.querySelector("button")) row = row.parentElement;
    if (!row || row.closest("[data-sheet-grab]") !== null || row.querySelector("[data-sheet-grab]") !== null) continue;
    const buttons = Array.from(row.querySelectorAll("button")).filter((b) => b.getBoundingClientRect().width > 1.5);
    const close = buttons[buttons.length - 1];
    if (!close) continue;
    const range = doc.createRange();
    range.selectNodeContents(title);
    const r = Array.from(range.getClientRects())[0];
    if (!r) continue;
    const lh = parseFloat(style(title).lineHeight);
    const titleZoom = zoomOf(title);
    const half = Number.isFinite(lh) ? (lh * titleZoom - r.height) / 2 : 0;
    // The frame's top padding is the padding of the box the header row stands in, the frame or a scroller inside it, which a sticky header takes back with its margin.
    const holder = row.parentElement ?? frame;
    const holderZoom = zoomOf(holder);
    const inset = holder.getBoundingClientRect().top - box.top + ((parseFloat(style(holder).getPropertyValue("border-top-width")) || 0) + (parseFloat(style(holder).getPropertyValue("padding-top")) || 0)) * holderZoom;
    const c = close.getBoundingClientRect();
    out.push({
      frame: frame.getAttribute("aria-label") ?? title.textContent ?? "",
      close: round(c.top - box.top),
      title: round((r.top - half + r.bottom + half) / 2 - box.top),
      wantClose: round(inset + (rowPx * zoom - c.height) / 2),
      wantTitle: round(inset + (rowPx * zoom) / 2),
    });
  }
  return out;
}

/** Each frame's header place, for frames (dialogs) whose title sits in a row with its Close. */
export async function headerPlaces(frames: Locator): Promise<HeaderPlace[]> {
  return frames.evaluateAll(headerInPage, PANE_ROW_PX);
}

/** A line for each header whose Close or title stands off a map pane's place by more than the limit. */
export function headerLines(places: readonly HeaderPlace[], screen: string): string[] {
  return places
    .filter((p) => Math.abs(p.close - p.wantClose) > LIMIT_PX || Math.abs(p.title - p.wantTitle) > LIMIT_PX)
    .map((p) => `${screen}: header of "${p.frame}" has its Close ${p.close} px and its title's middle ${p.title} px under its frame's top, where a map pane's has ${p.wantClose} and ${p.wantTitle}`);
}


type ToastSeen = { text: string; toast: Box; card: Box | null };

/** Each toast that shows, with the alert card right above it in its lane, if any. */
function toastsInPage(): ToastSeen[] {
  const g = globalThis as unknown as { document: DomDocument };
  const doc = g.document;
  const style = (el: DomElement) => doc.defaultView.getComputedStyle(el);
  const rect = (el: DomElement): Box => {
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom };
  };
  const shown = (el: DomElement) => {
    const r = el.getBoundingClientRect();
    return r.width > 1.5 && r.height > 1.5 && style(el).visibility !== "hidden";
  };
  const painted = (el: DomElement) => !/rgba\(0, 0, 0, 0\)|transparent/.test(style(el).backgroundColor);
  const toasts = Array.from(doc.querySelectorAll('[role="status"]')).filter((el) => shown(el) && painted(el) && el.closest("[data-alert]") === null);
  // The alerts column holds a card of each kind marked `data-alert`, and the rolls' cards inside a wrapper with no box of its own (InitiativeStrip.tsx): its cards are its children as drawn.
  const columns = new Set<DomElement>();
  for (const marked of Array.from(doc.querySelectorAll("[data-alert]"))) {
    let col = marked.parentElement;
    while (col && style(col).display === "contents") col = col.parentElement;
    if (col) columns.add(col);
  }
  const drawn = (el: DomElement): DomElement[] => Array.from(el.children).flatMap((c) => (style(c).display === "contents" ? drawn(c) : shown(c) ? [c] : []));
  const cards = [...columns].flatMap(drawn).map(rect);
  return toasts.map((el) => {
    const t = rect(el);
    // The card it stands under: across from it, its bottom at most a row's height above the toast's top.
    const above = cards.filter((c) => c.l < t.r && t.l < c.r && c.b <= t.t + 1 && t.t - c.b < 44).sort((a, c) => c.b - a.b)[0] ?? null;
    return { text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48), toast: t, card: above };
  });
}

/** A line for each toast under an alert card whose left or right edge is off the card's. */
export async function toastLaneLines(page: Page, screen: string): Promise<string[]> {
  const seen = await page.evaluate(toastsInPage);
  const round = (n: number) => Math.round(n * 10) / 10;
  return seen
    .filter((s) => s.card && (Math.abs(round(s.toast.l - s.card.l)) > LIMIT_PX || Math.abs(round(s.toast.r - s.card.r)) > LIMIT_PX))
    .map((s) => `${screen}: toast "${s.text}" under an alert card starts ${round(s.toast.l - s.card!.l)} px and ends ${round(s.toast.r - s.card!.r)} px off the card's edges`);
}

/** How many toasts show under an alert card, so a sweep can tell that its lane check met one. */
export async function toastsUnderCards(page: Page): Promise<number> {
  return (await page.evaluate(toastsInPage)).filter((s) => s.card !== null).length;
}


/** Where each lead word sits in its group: its left against the group's, and what stands before it on its line. */
function leadsInPage(group: DomElement, words: string[]): { word: string; inset: number; before: string[] }[] {
  const doc = group.ownerDocument;
  const style = (el: DomElement) => doc.defaultView.getComputedStyle(el);
  const g = group.getBoundingClientRect();
  const inset = parseFloat(style(group).getPropertyValue("padding-left")) || 0;
  const parts: { text: string; l: number; r: number; t: number; b: number }[] = [];
  const walk = (node: DomElement) => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === 3 && (ch.textContent ?? "").trim() && ch.parentElement) {
        const range = doc.createRange();
        range.selectNodeContents(ch);
        for (const r of Array.from(range.getClientRects())) if (r.width > 1) parts.push({ text: (ch.textContent ?? "").trim(), l: r.left, r: r.right, t: r.top, b: r.bottom });
      } else if (ch.nodeType === 1) {
        const el = ch as DomElement;
        const r = el.getBoundingClientRect();
        if (r.width <= 1.5 || r.height <= 1.5) continue;
        if (["button", "input", "select"].includes(el.tagName.toLowerCase())) parts.push({ text: (el.textContent || el.getAttribute("aria-label") || "").trim(), l: r.left, r: r.right, t: r.top, b: r.bottom });
        else walk(el);
      }
    }
  };
  walk(group);
  return parts
    .filter((p) => words.includes(p.text))
    .map((p) => ({
      word: p.text,
      inset: Math.round((p.l - g.left - inset) * 10) / 10,
      before: parts.filter((o) => o !== p && o.r <= p.l + 1 && o.t < p.b - 1 && o.b > p.t + 1).map((o) => o.text),
    }));
}

/** A line for each of `words` in the group that does not start its row (something stands before it on its line, or it starts off the group's left edge), or is not in the group at all. */
export async function leadLines(group: Locator, words: readonly string[], screen: string): Promise<string[]> {
  if ((await group.count()) === 0) return [`${screen}: no group of linked tokens to read`];
  const leads = await group.evaluate(leadsInPage, [...words]);
  const absent = words.filter((w) => !leads.some((l) => l.word === w)).map((w) => `${screen}: "${w}" is not in the group`);
  return [
    ...absent,
    ...leads
      .filter((w) => w.before.length > 0 || Math.abs(w.inset) > LIMIT_PX)
      .map((w) => `${screen}: "${w.word}" does not start its row: ${w.before.length ? `${w.before.join(", ")} before it` : `${w.inset} px in from the group's edge`}`),
  ];
}

