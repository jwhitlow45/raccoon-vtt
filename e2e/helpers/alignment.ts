import type { Locator, Page } from "playwright-core";
import sharp from "sharp";

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
 *    alone on a wrapped row's last line where it could share it: where it
 *    fits on one line beside the part before it, which is the only part
 *    a wrap can move down to it, each at its content's width.
 *
 * A line of text is measured by its line box, as CSS lays it out: the
 * text's Range rect grown by half the leading above and below. In a
 * block that lays its lines from its top, a line within a pixel of the
 * block's own line is put on it, since the browser rounds a font's ascent
 * and descent to whole pixels. Words moved by a relative offset on any
 * element between them and their block are put on the line they would
 * stand on unmoved, then moved by that offset again, so the move is kept
 * whole and only the font's rounding is put right. An offset moves only
 * what is painted, so the line stays where it was. A vertical alignment
 * moves the words' box in the line instead, and grows the line: a 1.4 px
 * raise grows the line, which its block then centers, so the words move
 * 0.7 px. Aligned by a length, the line's top is put on its block's
 * grid, and the words stand below it as far as the alignment lowers them
 * (a raised box sets the line's top, so its words stand at it). This
 * holds on the block's first line only, since a line under an aligned
 * one stands off the grid by what that one grew. Aligned by a keyword
 * (middle, sub, top and the rest), which rests on the font's metrics, no
 * grid says where the words stand, and they keep their own estimate. A
 * transform does not move an inline box at all. What a scroller inside
 * the measured part hides is not seen. What takes a tap is one box to the
 * eye, painted or not, and what it holds is centered in it.
 *
 * What the checks leave out, each for a reason, each with a drawn case
 * in e2e/alignmentRoom.ts (pl3-0):
 * - A row set on its baseline means its words to share a baseline, not a
 *   middle (hit points).
 * - A row set at its start means each part to meet the first line beside
 *   it, so its parts are compared by their first lines: a checkbox's box
 *   against its label's first line, a remove against its fields' first
 *   line. A part that lays out its own row has the first line it lays
 *   out, controls included, and a line it lays out with one part alone
 *   is that part's own first line, so a box meets the first line of a
 *   label wrapped onto two lines above its help. A row set in its middle
 *   compares middles, which is how a switch stands against its name and
 *   help together. In a mixed row the alignment most parts take decides,
 *   and a tie is judged both ways. A row whose parts all stretch places
 *   none of them, so it passes when they share either their middles or
 *   their first lines.
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
 * - A name above controls that leave its words no room beside them is a
 *   heading over them, as a FieldRow stacks its label over a field that
 *   does not fit beside it (docs/design-v1-polish.md R2). A name is alone
 *   above its controls only where its words fit in the room they leave.
 * - A pane's header band and a pane's frame are placed by
 *   the header check instead, since the band's room above its row is
 *   set by the frame (components/SheetHeader.tsx).
 * - Kin that hold different lines of words, in number or in height (a
 *   name on two lines over one line of help), or different rows of
 *   boxes, are compared only among themselves, since the one is meant to
 *   be taller. An icon beside the words changes nothing.
 * - An edge is where two rows or more start. A row starts where the
 *   words it sets at its start start, painted or not, so a chosen
 *   option's fill, which stands its padding outside words that line up
 *   with its unchosen kin, places nothing. A row that draws a box around
 *   words it centers (a stacked foot's full-width button) starts at its
 *   box. A lone painted notice may start at its words, or at its box
 *   with its fill on the column's edge, its words then set in by its
 *   border and padding alone: set in further, they have drifted inside
 *   it. Painted rows stacked together also share their fills' edge and
 *   their words' edge. What is set centered or at the end, as a field
 *   row's field at its right, is no edge. Three rows that each
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
 * nothing, so its caller requires the root (e2e/alignmentRoom.ts Sweep).
 * With E2E_ALIGN_DEBUG=1 a row's line also gives each part's boxes.
 */

/** The most a part may be off, in CSS px. Offsets are rounded to 0.1 px first, so layout rounding at 130% (1.0 px) passes. */
export const LIMIT_PX = 1;

/**
 * FL-12's mark is a border around the roll it names (D-261030-527), and it
 * may add no height and cut no words. Each box drawing one names its level
 * in `data-proficiency-mark` and its form in `data-proficiency-form`
 * (components/ProficiencyMark.tsx markedBy): a "unit" takes no room at all,
 * so its line, its tint, its trim and its padding all come off; a "frame"
 * holds its lines in padding the sticky result leaves room
 * for, and a "box" is a button's border, so only their lines come off.
 * Everything is taken off through the CSSOM (the page's CSP refuses a
 * style element), and no marked box, no box around one and no label may
 * change height, nor any box that cuts its words with "…" cut them only
 * because of a mark. Each mark must really lose its lines, so a hiding
 * that does nothing cannot pass. `required` asks for at least one mark.
 */
export async function proficiencyHeightLines(root: Locator, screen: string, required = true): Promise<string[]> {
  const measured = await root.evaluateAll((roots) => {
    type Style = { cssText: string; setProperty(name: string, value: string, priority: string): void };
    type El = {
      tagName: string;
      textContent: string | null;
      parentElement: El | null;
      currentCSSZoom?: number;
      scrollWidth: number;
      clientWidth: number;
      style: Style;
      matches(selector: string): boolean;
      closest(selector: string): El | null;
      querySelectorAll(selector: string): ArrayLike<El>;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { width: number; height: number };
      ownerDocument: { defaultView: { getComputedStyle(node: El): { visibility: string; textOverflow: string; boxShadow: string; outlineStyle: string; backgroundColor: string; getPropertyValue(name: string): string } } };
    };
    const MARKED = '[data-proficiency-level="prof"], [data-proficiency-level="expert"]';
    const labels: El[] = [];
    const marks = new Set<El>();
    const containers = new Set<El>();
    for (const root of roots as unknown as El[]) {
      for (const label of [...(root.matches(MARKED) ? [root] : []), ...Array.from(root.querySelectorAll(MARKED))]) {
        const box = label.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || label.ownerDocument.defaultView.getComputedStyle(label).visibility === "hidden") continue;
        labels.push(label);
        const mark = label.closest("[data-proficiency-mark]");
        if (mark) marks.add(mark);
        for (let container: El | null = label; container; container = container.parentElement) {
          // A unit's own box is its frame, trimmed and padded past its line without laying anything out.
          if (container !== mark || mark.getAttribute("data-proficiency-form") !== "unit") containers.add(container);
          if (container === root) break;
        }
      }
    }
    const view = (node: El) => node.ownerDocument.defaultView;
    const cuts = (node: El) => view(node).getComputedStyle(node).textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth;
    const before = [...containers].map((node) => ({ node, height: node.getBoundingClientRect().height, zoom: node.currentCSSZoom ?? 1, cut: cuts(node) }));
    const pictures = labels.flatMap((label) => Array.from(label.querySelectorAll("[data-proficiency-marker]")));
    const saved = [...marks, ...pictures].map((node) => ({ node, css: node.style.cssText }));
    const lines: string[] = [];
    try {
      // Both reads stay in one browser task, so no ResizeObserver can carry the bare layout into the app's state.
      for (const mark of marks) {
        mark.style.setProperty("box-shadow", "none", "important");
        mark.style.setProperty("outline", "none", "important");
        if (mark.getAttribute("data-proficiency-form") === "unit") {
          mark.style.setProperty("text-box", "normal", "important");
          mark.style.setProperty("padding", "0", "important");
          mark.style.setProperty("margin", "0", "important");
          mark.style.setProperty("background", "none", "important");
        }
      }
      for (const picture of pictures) picture.style.cssText = "display: none !important";
      const kept = [...marks].filter((mark) => {
        const look = view(mark).getComputedStyle(mark);
        const unit = mark.getAttribute("data-proficiency-form") === "unit";
        return look.boxShadow !== "none" || look.outlineStyle !== "none" || (unit && (look.backgroundColor !== "rgba(0, 0, 0, 0)" || look.getPropertyValue("text-box-trim") !== "none"));
      });
      if (kept.length > 0) lines.push(`${kept.length} of ${marks.size} marks kept their lines when taken off`);
      for (const { node, height, zoom, cut } of before) {
        const without = node.getBoundingClientRect().height;
        const difference = Math.abs(height - without) / zoom;
        const name = () => node.getAttribute("aria-label") ?? node.textContent?.replace(/\s+/g, " ").trim().slice(0, 72) ?? "";
        if (difference > 0.01) lines.push(`${node.tagName.toLowerCase()} "${name()}": marks change its height by ${difference.toFixed(2)} px (${(height / zoom).toFixed(2)} with, ${(without / zoom).toFixed(2)} without)`);
        if (cut && !cuts(node)) lines.push(`${node.tagName.toLowerCase()} "${name()}": marks cut its words with "…"`);
      }
    } finally {
      for (const { node, css } of saved) node.style.cssText = css;
    }
    return { count: labels.length, lines };
  });
  return [...(required && measured.count === 0 ? ["no visible proficiency marks were measured"] : []), ...measured.lines].map((line) => `${screen}: ${line}`);
}

/**
 * Each visible mark is the border D-261030-527 asks for, in its words' own
 * color and never the accent's (a focus ring's or a chosen control's):
 * - a "unit" trims its box to its capitals and baseline and draws a 1 px
 *   line just outside it, and expertise fills it with a tint of that color;
 * - a "frame" draws the same lines inside itself, expertise's 2 px in;
 * - a "box" turns its border the text's color, proficient with a 1 px
 *   line inside it and expertise with a second line 2 px in.
 * "Proficient" or "Expertise" is its label's tooltip and its picture's
 * name. Wherever any of the roll shows, its whole border shows: no box
 * that clips cuts it, past any overflow-clip-margin it keeps, except where
 * "…" cuts the words themselves, or as far as a scroller scrolls to show
 * the rest. A unit's border keeps at least 1 px clear of every character
 * outside it, a neighbor unit's border included, and never crosses its
 * own words, measured by their glyphs' outlines. A name a box clips out of
 * view whole, or kept from sight for a screen reader as a folded line's
 * parts past its cut are, has nothing to see.
 */
export async function proficiencyLines(root: Locator, screen: string, required = true): Promise<string[]> {
  const measured = await root.evaluateAll(async (roots) => {
    type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
    type Box = { l: number; r: number; t: number; b: number };
    type Css = {
      font: string; color: string; clip: string; overflowX: string; overflowY: string; textOverflow: string; visibility: string; display: string; position: string;
      borderLeftWidth: string; borderLeftColor: string; backgroundColor: string; backgroundImage: string;
      boxShadow: string; outlineStyle: string; outlineWidth: string; outlineColor: string; outlineOffset: string; borderTopLeftRadius: string;
      getPropertyValue(name: string): string;
    };
    type El = {
      textContent: string | null;
      parentElement: El | null;
      nodeType: number;
      childNodes: ArrayLike<El>;
      currentCSSZoom?: number;
      clientLeft: number;
      clientTop: number;
      clientWidth: number;
      clientHeight: number;
      scrollLeft: number;
      scrollTop: number;
      offsetWidth: number;
      offsetHeight: number;
      scrollWidth: number;
      scrollHeight: number;
      tagName: string;
      matches(selector: string): boolean;
      closest(selector: string): El | null;
      contains(other: El): boolean;
      querySelector(selector: string): El | null;
      querySelectorAll(selector: string): ArrayLike<El>;
      getBoundingClientRect(): Rect;
      getClientRects(): ArrayLike<Rect>;
      getAttribute(name: string): string | null;
      ownerDocument: {
        documentElement: El;
        createRange(): { setStart(node: El, at: number): void; setEnd(node: El, at: number): void; selectNodeContents(node: El): void; getClientRects(): ArrayLike<Rect> };
        createElement(tag: "canvas"): { getContext(kind: "2d"): { font: string; measureText(text: string): { fontBoundingBoxDescent: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number; actualBoundingBoxLeft: number; actualBoundingBoxRight: number } } | null };
        defaultView: { getComputedStyle(node: El): Css };
      };
    };
    const MARKED = '[data-proficiency-level="prof"], [data-proficiency-level="expert"]';
    const labels = new Set<El>();
    for (const root of roots as unknown as El[]) {
      if (root.matches(MARKED)) labels.add(root);
      for (const label of Array.from(root.querySelectorAll(MARKED))) labels.add(label);
    }
    const lines: string[] = [];
    const style = (node: El) => node.ownerDocument.defaultView.getComputedStyle(node);
    const doc = [...labels][0]?.ownerDocument;
    const context = doc?.createElement("canvas").getContext("2d") ?? null;
    const grow = (r: Rect | Box, by: number): Box => ("l" in r ? { l: r.l - by, r: r.r + by, t: r.t - by, b: r.b + by } : { l: r.left - by, r: r.right + by, t: r.top - by, b: r.bottom + by });
    /** How far apart two boxes are: 0 where they touch or overlap. */
    const apart = (a: Box, b: Box) => Math.max(0, Math.max(a.l - b.r, b.l - a.r), Math.max(a.t - b.b, b.t - a.b));
    /** A color's channels from 0 to 1 and its alpha, as the browser writes an rgb() or a mixed color(srgb). */
    const channels = (color: string): number[] | null => {
      const rgb = /^rgba?\(([^)]+)\)$/.exec(color);
      if (rgb) {
        const [r = 0, g = 0, b = 0, a = 1] = rgb[1]!.split(",").map(Number);
        return [r / 255, g / 255, b / 255, a];
      }
      const srgb = /^color\(srgb ([^/)]+)(?:\/ *([^)]+))?\)$/.exec(color);
      return srgb ? [...srgb[1]!.trim().split(/\s+/).map(Number), srgb[2] === undefined ? 1 : Number(srgb[2])] : null;
    };
    const overlaps = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.01 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.01;
    /*
     * A glyph's ink is measured from its outline, not from a canvas at the
     * size it is drawn. On Linux a canvas gives whole pixels rounded out
     * (Inter's H 11 px tall at 14 px, where its outline is 10.19), which
     * would put ink past a frame the outline clears. So each family the
     * page loads with @font-face is loaded again, pinned to the optical
     * size Chrome draws it at (its CSS font size, before any zoom), and
     * measured at 1000 px, where a pixel is a thousandth of the glyph.
     * A font the page does not load is measured at its own size.
     */
    type Face = { load(): Promise<unknown> };
    type Fonts = { add(face: Face): void };
    type Rule = { type: number; style: { getPropertyValue(name: string): string } };
    type Window = {
      fetch(url: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
      FontFace: new (family: string, source: ArrayBuffer, descriptors: Record<string, string>) => Face;
      proficiencyInkFaces?: Map<string, string>;
    };
    const page = globalThis as unknown as Window;
    const pinned = (page.proficiencyInkFaces ??= new Map<string, string>());
    const sources = new Map<string, { src: string; weight: string }>();
    for (const sheet of Array.from((doc as unknown as { styleSheets?: ArrayLike<{ cssRules: ArrayLike<Rule> }> } | undefined)?.styleSheets ?? [])) {
      let rules: Rule[] = [];
      try {
        rules = Array.from(sheet.cssRules);
      } catch {
        continue;
      }
      for (const rule of rules) {
        // 5 is CSSRule.FONT_FACE_RULE. Only the upright face: a mark's words are never set in italics.
        if (rule.type !== 5 || !["", "normal"].includes(rule.style.getPropertyValue("font-style"))) continue;
        const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
        const src = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue("src"))?.[1];
        if (src && !sources.has(family)) sources.set(family, { src, weight: rule.style.getPropertyValue("font-weight") || "100 900" });
      }
    }
    const opszOf = (look: Css) => parseFloat(look.getPropertyValue("font-size"));
    const familyOf = (look: Css) => look.getPropertyValue("font-family").split(",")[0]!.replace(/["']/g, "").trim();
    const keyOf = (look: Css) => `${familyOf(look)}|${opszOf(look)}`;
    /** Faces still to load, as `family|opsz`, found on a pass that measured them at their drawn size. */
    const needed = new Set<string>();
    const outline = (look: Css): { font: string; scale: number } | null => {
      if (!sources.has(familyOf(look))) return null;
      const name = pinned.get(keyOf(look));
      if (!name) {
        needed.add(keyOf(look));
        return null;
      }
      return { font: `${look.getPropertyValue("font-style")} ${look.getPropertyValue("font-weight")} 1000px "${name}"`, scale: parseFloat(look.getPropertyValue("font-size")) / 1000 };
    };
    const loadFaces = async () => {
      const fonts = (doc as unknown as { fonts?: Fonts } | undefined)?.fonts;
      if (!fonts) return;
      for (const key of needed) {
        const [family, opsz] = key.split("|") as [string, string];
        const source = sources.get(family)!;
        const bytes = await (await page.fetch(source.src)).arrayBuffer();
        const name = `proficiency-ink-${pinned.size}`;
        const face = new page.FontFace(name, bytes, { weight: source.weight, variationSettings: `"opsz" ${opsz}` });
        // Loaded before it joins the page's fonts, so the page sees no font load and refits nothing.
        await face.load();
        fonts.add(face);
        pinned.set(key, name);
      }
    };
    /** The ink of each character of a text node: its glyph's outline, placed on the baseline the page lays it on. */
    const inks = (text: El, near?: Box[]): Box[] => {
      const parent = text.parentElement;
      if (!context || !parent) return [];
      const look = style(parent);
      const precise = outline(look);
      const zoom = parent.currentCSSZoom ?? 1;
      const words = text.textContent ?? "";
      const out: Box[] = [];
      const range = text.ownerDocument.createRange();
      range.selectNodeContents(text);
      if (near && !Array.from(range.getClientRects()).some((r) => near.some((n) => overlaps(n, grow(r, 0))))) return out;
      for (let i = 0; i < words.length; i++) {
        const ch = words[i]!;
        if (/\s/.test(ch)) continue;
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const r = Array.from(range.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
        if (!r) continue;
        // The baseline from the descent the browser rounds to whole pixels as it lays the line out: at the zoomed size, as a zoomed line is laid out (5 px at 16 px and 130%, not 4 px times 1.3).
        context.font = `${look.getPropertyValue("font-style")} ${look.getPropertyValue("font-weight")} ${parseFloat(look.getPropertyValue("font-size")) * zoom}px ${look.getPropertyValue("font-family")}`;
        const baseline = r.bottom - context.measureText(ch).fontBoundingBoxDescent;
        if (precise) context.font = precise.font;
        const m = context.measureText(ch);
        const k = (precise?.scale ?? 1) * zoom;
        out.push({ l: r.left - m.actualBoundingBoxLeft * k, r: r.left + m.actualBoundingBoxRight * k, t: baseline - m.actualBoundingBoxAscent * k, b: baseline + m.actualBoundingBoxDescent * k });
      }
      return out;
    };
    const texts = (node: El, skip: El | null, into: El[] = []): El[] => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) into.push(child);
        else if (child.nodeType === 1 && child !== skip && !child.matches("[data-proficiency-marker]")) texts(child, skip, into);
      }
      return into;
    };
    const run = () => {
      lines.length = 0;
      const units: { mark: El; outer: Box[]; words: string }[] = [];
      const seenMarks = new Set<El>();
      let count = 0;
      for (const label of labels) {
        const css = style(label);
        const box = label.getBoundingClientRect();
        if (box.width === 0 || box.height === 0 || css.visibility === "hidden") continue;
        // A name kept from sight for a screen reader sits in a box clipped to nothing (lib/a11y.ts VISUALLY_HIDDEN).
        let unseen = false;
        for (let ancestor = label.parentElement; ancestor && !unseen; ancestor = ancestor.parentElement) unseen = style(ancestor).clip === "rect(0px, 0px, 0px, 0px)";
        if (unseen) continue;
        count++;
        const level = label.getAttribute("data-proficiency-level");
        const word = level === "expert" ? "Expertise" : "Proficient";
        const words = label.textContent?.trim() || "an unnamed mark";
        const marker = label.querySelector(`[data-proficiency-marker="${level}"][role="img"]`);
        if (label.getAttribute("title") !== word || marker?.getAttribute("aria-label") !== word) lines.push(`${words}: not named ${word}`);
        const mark = label.closest("[data-proficiency-mark]");
        if (!mark) {
          lines.push(`${words}: no box draws its mark`);
          continue;
        }
        if (mark.getAttribute("data-proficiency-mark") !== level) lines.push(`${words}: its box draws ${mark.getAttribute("data-proficiency-mark")}, not ${level}`);
        if (seenMarks.has(mark)) continue;
        seenMarks.add(mark);
        const form = mark.getAttribute("data-proficiency-form");
        const look = style(mark);
        // currentColor resolves to the words' own color, which the lines below must match: never the accent of a focus ring or a chosen control.
        const color = look.color;
        const ring = (px: number) => `${color} 0px 0px 0px ${px}px inset`;
        const shadows = look.boxShadow.split(/,(?![^(]*\))/).map((part) => part.trim());
        const zoom = mark.currentCSSZoom ?? 1;
        // Inside a zoomed box the browser reports a length set in px over its zoom: 1px reads 0.77px at 130%.
        const px = (value: string, want: number) => [1, zoom].some((z) => Math.abs(parseFloat(value) * z - want) < 0.05);
        const outline = look.outlineStyle === "none" ? null : look;
        const lineOf = (offset: number) => outline !== null && px(outline.outlineWidth, 1) && outline.outlineColor === color && px(outline.outlineOffset, offset);
        let right = false;
        if (form === "unit") {
          // Expertise's fill is the words' color, faint: a tint, never a second color or a solid block.
          const hue = channels(color);
          const fill = channels(look.backgroundColor);
          const tint = hue !== null && fill !== null && [0, 1, 2].every((i) => Math.abs(hue[i]! - fill[i]!) < 0.01) && fill[3]! >= 0.08 && fill[3]! <= 0.25;
          const trimmed = look.getPropertyValue("text-box-trim") === "trim-both" && look.getPropertyValue("text-box-edge") === "cap alphabetic";
          right =
            trimmed && parseFloat(look.borderTopLeftRadius) > 0 && outline === null && parseFloat(look.borderLeftWidth) === 0 && look.backgroundImage === "none" &&
            shadows.length === 1 && shadows[0] === `${color} 0px 0px 0px 1px` && (level === "expert" ? tint : fill?.[3] === 0);
        } else if (form === "frame") {
          right = shadows.length === 1 && shadows[0] === ring(1) && parseFloat(look.borderTopLeftRadius) > 0 && (level === "expert" ? lineOf(-3) : outline === null);
        } else if (form === "box") {
          right = look.borderLeftColor === color && (level === "expert" ? shadows.length === 2 && shadows[1] === ring(3) && outline === null : shadows.length === 1 && shadows[0] === ring(1) && outline === null);
        }
        const drawn = form === "unit" ? (level === "expert" ? "expertise's line and tint" : "proficient's line") : level === "expert" ? "expertise's two lines" : "proficient's line";
        if (!right) lines.push(`${words}: its ${form ?? "unnamed"} box does not draw ${drawn} in its words' color (${look.boxShadow}; fill ${look.backgroundColor}; outline ${look.outlineStyle} ${look.outlineWidth} ${look.outlineOffset})`);
        const fragments = Array.from(mark.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        // What the mark paints: a unit's line 1 px outside its box, frames and boxes inside their own.
        const outer = fragments.map((r) => grow(r, form === "unit" ? zoom : 0));
        // The roll's words, not its padded box, say whether a box shows it.
        const reach = mark.ownerDocument.createRange();
        reach.selectNodeContents(mark);
        const said = Array.from(reach.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        /*
         * Wherever any of the roll shows, its whole border shows. Each box
         * that clips it narrows the window the frame must fit in, its
         * overflow-clip-margin included. A scroller widens how far the frame
         * may move, by as far as it scrolls each way: back to its scroll
         * origin and on to its scroll size, never past. So a frame cut at a
         * scroller's start, or by a box around a scroller that no scrolling
         * brings it inside, is cut, and one scrolled partly out of view is
         * not. The boxes inside a scroller move with the frame as it
         * scrolls, so past a scroller the window starts again from its own
         * box along that way.
         */
        const held = outer.map((o) => ({ ...o }));
        const win: Box = { l: -Infinity, r: Infinity, t: -Infinity, b: Infinity };
        const move = { l: 0, r: 0, t: 0, b: 0 };
        for (let ancestor = mark.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const around = style(ancestor);
          if (around.overflowX === "visible" && around.overflowY === "visible") continue;
          const edge = ancestor.getBoundingClientRect();
          const scale = ancestor.currentCSSZoom ?? 1;
          // Its box inside the border and any scrollbar. The client sizes are whole pixels, so the far sides come off the drawn edge by what the border and scrollbar take: a fractional width rounds alike in both sizes.
          const inside: Box = {
            l: edge.left + ancestor.clientLeft * scale,
            t: edge.top + ancestor.clientTop * scale,
            r: edge.right - (ancestor.offsetWidth - ancestor.clientLeft - ancestor.clientWidth) * scale,
            b: edge.bottom - (ancestor.offsetHeight - ancestor.clientTop - ancestor.clientHeight) * scale,
          };
          // A box that clips the roll's words whole holds it out of view, as the sticky result does a part it drops onto its unseen second line: no box further out cuts what is not seen.
          if (!said.some((r) => overlaps(grow(grow(r, 0), -0.5), inside))) break;
          const scrollsX = /auto|scroll/.test(around.overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 1;
          const scrollsY = /auto|scroll/.test(around.overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 1;
          // A box that clips with overflow: clip paints its overflow-clip-margin past its inside too.
          const margin = (overflow: string) => (overflow === "clip" ? (parseFloat(around.getPropertyValue("overflow-clip-margin")) || 0) * scale : 0);
          const shown: Box = { l: inside.l - margin(around.overflowX), r: inside.r + margin(around.overflowX), t: inside.t - margin(around.overflowY), b: inside.b + margin(around.overflowY) };
          if (scrollsX) {
            move.l -= (ancestor.scrollWidth - ancestor.clientWidth - ancestor.scrollLeft) * scale;
            move.r += ancestor.scrollLeft * scale;
            Object.assign(win, { l: -Infinity, r: Infinity });
          }
          if (scrollsY) {
            move.t -= (ancestor.scrollHeight - ancestor.clientHeight - ancestor.scrollTop) * scale;
            move.b += ancestor.scrollTop * scale;
            Object.assign(win, { t: -Infinity, b: Infinity });
          }
          Object.assign(win, { l: Math.max(win.l, shown.l), r: Math.min(win.r, shown.r), t: Math.max(win.t, shown.t), b: Math.min(win.b, shown.b) });
          // "…" cuts a roll's words at the box's end, and their border with them: no border closes around part of its words, here or further out.
          if (around.textOverflow === "ellipsis" && said.some((r) => r.right > inside.r + 0.5)) for (const o of held) o.r = Math.min(o.r, shown.r);
          // Only a box a line or two tall, a box that holds the roll's words whole, or a scroller, by how far it scrolls, is judged on its own. A taller box that shows part of the roll still narrows the window for every box around it.
          const whole = said.every((r) => r.top >= inside.t - 0.5 && r.bottom <= inside.b + 0.5 && r.left >= inside.l - 0.5 && r.right <= inside.r + 0.5);
          if (edge.height > 64 * scale && !whole && !scrollsX && !scrollsY) continue;
          // How far past the window the frame stays at its best place along one way: it must shift by at least `need`, by at most `room`, and only within [least, most].
          const short = (need: number, room: number, least: number, most: number) => {
            const best = Math.min(most, Math.max(least, (need + room) / 2));
            return Math.max(need - best, best - room, 0);
          };
          const past = Math.max(...held.map((o) => Math.max(short(win.l - o.l, win.r - o.r, move.l, move.r), short(win.t - o.t, win.b - o.b, move.t, move.b))));
          if (past > 0.5) {
            lines.push(`${words}: its border runs ${(past / scale).toFixed(2)} px past the ${ancestor.tagName.toLowerCase()} that clips it`);
            break;
          }
        }
        if (form !== "unit") continue;
        units.push({ mark, outer, words });
        // A unit's border never crosses its own words: their ink stays inside the box its line is drawn around.
        const inner = fragments.map((r) => grow(r, 0));
        const own = texts(mark, null).flatMap((text) => inks(text));
        if (own.some((ink) => !inner.some((band) => ink.l >= band.l - 0.25 && ink.r <= band.r + 0.25 && ink.t >= band.t - 0.25 && ink.b <= band.b + 0.25))) lines.push(`${words}: its border crosses its own words`);
        // And keeps 1 px clear of every character outside it, in the line or row it sits in: past inline boxes and flex or grid items, to the first box that is neither.
        let block = mark.parentElement;
        const item = (node: El) => node.parentElement !== null && /flex|grid/.test(style(node.parentElement).display);
        for (let up = 0; block && up < 6 && (style(block).display.startsWith("inline") || item(block)); up++) block = block.parentElement;
        if (!block) continue;
        const near = outer.map((o) => grow(o, 12 * zoom));
        for (const text of texts(block, mark)) {
          const parent = text.parentElement;
          if (!parent || mark.contains(parent) || style(parent).visibility === "hidden") continue;
          // Words kept for a screen reader alone, as a folded line's parts past its cut, draw nothing. Words in a sticky layer, as a pane's foot, cover the line rather than stand beside it.
          let kept = false;
          for (let up: El | null = parent; up && up !== block && !kept; up = up.parentElement) kept = style(up).clip === "rect(0px, 0px, 0px, 0px)" || (/sticky|fixed/.test(style(up).position) && !up.contains(mark));
          if (kept) continue;
          for (const ink of inks(text, near)) {
            if (!near.some((n) => overlaps(n, ink))) continue;
            const gap = Math.min(...outer.map((o) => apart(o, ink)));
            if (gap < 1 * zoom - 0.25) {
              lines.push(`${words}: its border is ${(gap / zoom).toFixed(2)} px from a character outside it`);
              break;
            }
          }
        }
      }
      // No two units' borders touch. One space leaves 1.6 px between them at 13 px, and two lines at Inter's own spacing 0.85 px, or 0.65 px at 130%, where Chrome rounds that line down to 20 px.
      for (const [i, a] of units.entries()) {
        for (const b of units.slice(i + 1)) {
          const gap = Math.min(...a.outer.flatMap((x) => b.outer.map((y) => apart(x, y))));
          const zoom = a.mark.currentCSSZoom ?? 1;
          if (gap < 0.5 * zoom) lines.push(`${a.words}: its border is ${(gap / zoom).toFixed(2)} px from ${b.words}'s`);
        }
      }
      return { count, lines };
    };
    // A first pass finds the faces to load. Once they are, a second pass measures every glyph by its outline.
    const first = run();
    if (needed.size === 0) return first;
    await loadFaces();
    return run();
  });
  return [...(required && measured.count === 0 ? ["no visible proficiency marks were measured"] : []), ...measured.lines].map((line) => `${screen}: ${line}`);
}

/** How many outlined boxes a screen checks by their pixels, in grid order: two show every side a box can stand on. */
const OUTLINE_PIXEL_BOXES = 2;

/**
 * FL-15's outlined ability boxes (D-261030-588) in `root`'s six-ability
 * grids (client/features/monsters/AbilityGrid.tsx). A box is outlined
 * exactly when a screen reader hears its save as proficient, and its
 * outline is a 1 px line in the box's own text color, never the accent's,
 * drawn inside its rounded edge. No save number is bold, and an outlined
 * box's words stand where a plain box's do.
 *
 * Then the first outlined boxes in sight are shot with their outline and
 * with it taken off through the CSSOM: the pixels it changes are a ring at
 * the box's own edge, of one width on all four sides, with nothing changed
 * inside the ring or outside the box. A taking off that changes no pixel
 * fails, so it cannot pass by hiding nothing. `required` asks for at least
 * one outlined box checked by its pixels.
 */
export async function saveOutlineLines(page: Page, root: Locator, screen: string, required = true): Promise<string[]> {
  const styled = await root.evaluateAll((roots) => {
    type Rect = { top: number; left: number; width: number; height: number };
    type Css = { color: string; boxShadow: string; fontWeight: string };
    type El = {
      textContent: string | null;
      style: { color: string };
      children: ArrayLike<El>;
      querySelector(selector: string): El | null;
      querySelectorAll(selector: string): ArrayLike<El>;
      hasAttribute(name: string): boolean;
      getBoundingClientRect(): Rect;
      appendChild(node: El): void;
      remove(): void;
      ownerDocument: { body: El; createElement(tag: string): El; defaultView: { getComputedStyle(node: El): Css } };
    };
    const lines: string[] = [];
    const grids = (roots as unknown as El[]).flatMap((r) => Array.from(r.querySelectorAll("[data-ability-grid]")));
    const doc = grids[0]?.ownerDocument;
    if (!doc) return { outlined: 0, lines };
    const css = (node: El) => doc.defaultView.getComputedStyle(node);
    // The accent as the browser resolves it, to compare with the outline's color.
    const probe = doc.createElement("span");
    probe.style.color = "var(--rvtt-accent, #f7df00)";
    doc.body.appendChild(probe);
    const accent = css(probe).color;
    probe.remove();
    const boxes = grids.flatMap((grid) => Array.from(grid.children));
    const name = (box: El) => box.querySelector("dt")?.textContent?.trim() ?? "?";
    let outlined = 0;
    for (const box of boxes) {
      const style = css(box);
      const drawn = style.boxShadow !== "none";
      const spoken = /, proficient/.test(box.textContent ?? "");
      if (box.hasAttribute("data-save-proficient") !== spoken) lines.push(`${name(box)}: data-save-proficient does not match what a screen reader hears`);
      if (drawn !== spoken) lines.push(`${name(box)}: ${drawn ? "outlined, but a screen reader does not hear its save as proficient" : "a screen reader hears its save as proficient, but it has no outline"}`);
      if (drawn) {
        outlined++;
        const score = box.querySelector("strong");
        const text = score ? css(score).color : style.color;
        if (style.boxShadow !== `${style.color} 0px 0px 0px 1px inset`) lines.push(`${name(box)}: the outline is "${style.boxShadow}", not a 1 px line inside the box in its text's color`);
        if (style.color !== text) lines.push(`${name(box)}: the outline's color ${style.color} is not the text's ${text}`);
        if (style.color === accent) lines.push(`${name(box)}: the outline takes the accent's color`);
      }
      const saves = Array.from(box.querySelectorAll("dd"));
      const save = saves[saves.length - 1];
      if (save && Number(css(save).fontWeight) > 400) lines.push(`${name(box)}: its save is set in weight ${css(save).fontWeight}, so two signs show one fact`);
    }
    // Taking no room: an outlined box's words stand where a plain box's do, from its top left corner.
    const offsets = (box: El) => {
      const b = box.getBoundingClientRect();
      return Array.from(box.querySelectorAll("dt, dd")).map((part) => {
        const r = part.getBoundingClientRect();
        return [r.top - b.top, r.left - b.left];
      });
    };
    for (const grid of grids) {
      const all = Array.from(grid.children);
      const plain = all.find((box) => css(box).boxShadow === "none");
      if (!plain) continue;
      const expected = offsets(plain);
      for (const box of all.filter((b) => b !== plain)) {
        const moved = Math.max(...offsets(box).flatMap((at, i) => at.map((v, j) => Math.abs(v - (expected[i]?.[j] ?? Number.NaN)))));
        if (!(moved <= 0.01)) lines.push(`${name(box)}: its words stand ${Number.isNaN(moved) ? "in another order" : `${moved.toFixed(2)} px`} from where a plain box's do`);
      }
    }
    return { outlined, lines };
  });
  const lines = [...styled.lines];
  const boxes = root.locator("[data-ability-grid] > [data-save-proficient]");
  const dpr = await page.evaluate(() => (globalThis as unknown as { devicePixelRatio: number }).devicePixelRatio);
  let shot = 0;
  for (let i = 0; i < (await boxes.count()) && shot < OUTLINE_PIXEL_BOXES; i++) {
    const box = boxes.nth(i);
    if (!(await box.isVisible())) continue;
    await box.evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "nearest" }));
    // Shot only where nothing covers it: a sheet's sticky header or foot would hide part of the ring.
    const at = await box.evaluate((el) => {
      type El = { contains(n: unknown): boolean; currentCSSZoom?: number; getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number }; ownerDocument: { elementFromPoint(x: number, y: number): unknown; defaultView: { getComputedStyle(n: unknown): { borderTopLeftRadius: string } } } };
      const node = el as unknown as El;
      const r = node.getBoundingClientRect();
      const zoom = node.currentCSSZoom ?? 1;
      const margin = 3 * zoom;
      const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + r.height / 2], [r.right - 1, r.top + r.height / 2], [r.left + r.width / 2, r.top + 1], [r.left + r.width / 2, r.bottom - 1]];
      const clear = points.every(([x, y]) => node.contains(node.ownerDocument.elementFromPoint(x!, y!)));
      return { left: r.left, top: r.top, width: r.width, height: r.height, zoom, margin, clear, radius: Number.parseFloat(node.ownerDocument.defaultView.getComputedStyle(node).borderTopLeftRadius) * zoom };
    });
    if (!at.clear) continue;
    // Whole CSS pixels, so the shot starts on a device pixel and the box's edges fall where its rect says.
    const x = Math.floor(at.left - at.margin);
    const y = Math.floor(at.top - at.margin);
    const clip = { x, y, width: Math.ceil(at.left + at.width + at.margin) - x, height: Math.ceil(at.top + at.height + at.margin) - y };
    const take = async () => {
      const png = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
      return sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    };
    const shown = await take();
    const was = await box.evaluate((el) => {
      const node = el as unknown as { style: { boxShadow: string } };
      const before = node.style.boxShadow;
      node.style.boxShadow = "none";
      return before;
    });
    let plain: Awaited<ReturnType<typeof take>>;
    try {
      plain = await take();
    } finally {
      await box.evaluate((el, before) => ((el as unknown as { style: { boxShadow: string } }).style.boxShadow = before), was);
    }
    shot++;
    const { width: w, height: h } = shown.info;
    const changed = (x: number, y: number) => {
      const o = (y * w + x) * 4;
      return Math.max(...[0, 1, 2].map((c) => Math.abs(shown.data[o + c]! - plain.data[o + c]!))) > 16;
    };
    const label = `box ${i + 1} (${(await box.locator("dt").textContent())?.trim()})`;
    // The browser draws a box on whole device pixels, its edges rounded.
    const edge = { l: Math.round((at.left - x) * dpr), t: Math.round((at.top - y) * dpr), r: Math.round((at.left + at.width - x) * dpr), b: Math.round((at.top + at.height - y) * dpr) };
    const width = at.zoom * dpr;
    let any = 0;
    let outside = 0;
    let inside = 0;
    const corner = (at.radius + 1) * dpr;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!changed(x, y)) continue;
        any++;
        if (x < edge.l - 1 || x >= edge.r + 1 || y < edge.t - 1 || y >= edge.b + 1) outside++;
        const ring = width + 1.5;
        const inCorner = (x < edge.l + corner || x >= edge.r - corner) && (y < edge.t + corner || y >= edge.b - corner);
        if (!inCorner && x >= edge.l + ring && x < edge.r - ring && y >= edge.t + ring && y < edge.b - ring) inside++;
      }
    }
    if (any === 0) {
      lines.push(`${label}: hiding its outline changed no pixel`);
      continue;
    }
    if (outside > 0) lines.push(`${label}: its outline changes ${outside} device pixels outside the box`);
    if (inside > 0) lines.push(`${label}: its outline changes ${inside} device pixels inside its ring, so something in the box moved`);
    // Each side's ring, read across the middle of the box: where it starts and how wide it is.
    const run = (from: number, step: number, count: number, at: (k: number) => boolean) => {
      let start = -1;
      for (let k = 0; k < count; k++) if (at(from + k * step)) { start = k; break; }
      if (start < 0) return null;
      let length = 0;
      while (start + length < count && at(from + (start + length) * step)) length++;
      return { start, length };
    };
    const midY = Math.round(h / 2);
    const midX = Math.round(w / 2);
    const sides = {
      left: { ring: run(0, 1, midX, (x) => changed(x, midY)), edge: edge.l },
      right: { ring: run(w - 1, -1, w - midX, (x) => changed(x, midY)), edge: w - edge.r },
      top: { ring: run(0, 1, midY, (y) => changed(midX, y)), edge: edge.t },
      bottom: { ring: run(h - 1, -1, h - midY, (y) => changed(midX, y)), edge: h - edge.b },
    };
    const widths: number[] = [];
    for (const [side, { ring, edge: expected }] of Object.entries(sides)) {
      if (!ring) {
        lines.push(`${label}: no outline on its ${side} side`);
        continue;
      }
      widths.push(ring.length);
      if (Math.abs(ring.start - expected) > 1) lines.push(`${label}: its ${side} line is ${((ring.start - expected) / dpr).toFixed(2)} px from the box's edge`);
      if (ring.length < Math.floor(width) || ring.length > Math.ceil(width) + 1) lines.push(`${label}: its ${side} line is ${(ring.length / dpr).toFixed(2)} px wide, not ${Number(at.zoom.toFixed(2))} px`);
    }
    if (widths.length > 1 && Math.max(...widths) - Math.min(...widths) > 1) lines.push(`${label}: its sides are ${widths.map((v) => (v / dpr).toFixed(2)).join(", ")} px wide, not even`);
  }
  if (required && shot === 0) lines.push(styled.outlined === 0 ? "no outlined ability box" : "no outlined ability box could be shot clear of what covers it");
  return lines.map((line) => `${screen}: ${line}`);
}

/** The interface's indent step (theme.space(3)), in CSS px: the least a nested list or group is set in to make a column of its own. */
export const INDENT_PX = 12;

/** FL5: a split word is wrong when it could fit the menu's width. A word wider than the whole menu must break to stay inside it. */
export async function menuWordLines(root: Locator, at: string): Promise<string[]> {
  return root.evaluateAll((roots, name) => {
    type Node = { nodeType: number; textContent: string | null; childNodes: ArrayLike<Node>; parentElement: Element | null };
    type Element = Node & {
      style: Record<string, string>;
      getAttribute(name: string): string | null;
      closest(selector: string): Element | null;
      querySelectorAll(selector: string): ArrayLike<Element>;
      getBoundingClientRect(): { width: number; height: number };
      appendChild(node: Element): void;
      remove(): void;
      ownerDocument: {
        createElement(tag: string): Element;
        createRange(): { setStart(node: Node, offset: number): void; setEnd(node: Node, offset: number): void; getClientRects(): ArrayLike<{ top: number; width: number; height: number }> };
        defaultView: { getComputedStyle(el: Element): { display: string; visibility: string } };
      };
    };
    const lines: string[] = [];
    let words = 0;
    for (const root of roots as unknown as Element[]) {
      for (const item of Array.from(root.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'))) {
        const box = item.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        const doc = item.ownerDocument;
        const room = (item.closest('[role="menu"]') ?? item).getBoundingClientRect().width;
        const visit = (node: Node) => {
          if (node.nodeType === 1) {
            const el = node as Element;
            const style = doc.defaultView.getComputedStyle(el);
            if (el.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") return;
          }
          if (node.nodeType === 3) {
            for (const match of (node.textContent ?? "").matchAll(/[\p{L}\p{N}]+/gu)) {
              const range = doc.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
              if (!rects.length) continue;
              words++;
              if (rects.some((r) => Math.abs(r.top - rects[0]!.top) > 1)) {
                // Inherit the label's font and zoom, but measure the whole word without its current flex constraint.
                const probe = doc.createElement("span");
                probe.textContent = match[0];
                Object.assign(probe.style, { position: "absolute", visibility: "hidden", whiteSpace: "nowrap", width: "max-content", maxWidth: "none" });
                (node.parentElement ?? item).appendChild(probe);
                const width = probe.getBoundingClientRect().width;
                probe.remove();
                if (width <= room + 1) lines.push(`${name}: menu word "${match[0]}" breaks inside the word despite fitting the menu's width`);
              }
            }
          } else for (const child of Array.from(node.childNodes)) visit(child);
        };
        visit(item);
      }
    }
    if (!words) lines.push(`${name}: no menu words measured`);
    return lines;
  }, at);
}

/** FL5: check both scrollbar rules, even on systems whose overlay scrollbar occupies no width. */
export async function popoverScrollbarLines(root: Locator, at: string): Promise<string[]> {
  return root.evaluateAll((roots, name) => {
    type Box = {
      clientWidth: number; offsetWidth: number;
      ownerDocument: { defaultView: { getComputedStyle(el: Box, pseudo?: string): { scrollbarWidth: string; display: string; borderLeftWidth: string; borderRightWidth: string } } };
    };
    const lines: string[] = [];
    for (const box of roots as unknown as Box[]) {
      const win = box.ownerDocument.defaultView;
      const style = win.getComputedStyle(box);
      if (style.scrollbarWidth !== "none") lines.push(`${name}: scrollbar-width is ${style.scrollbarWidth}`);
      if (win.getComputedStyle(box, "::-webkit-scrollbar").display !== "none") lines.push(`${name}: the WebKit scrollbar is visible`);
      const gutter = box.offsetWidth - box.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      if (gutter > 1) lines.push(`${name}: the scrollbar takes ${gutter}px`);
    }
    if (!roots.length) lines.push(`${name}: no popover measured`);
    return lines;
  }, at);
}

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
    'button, a[href], [role="button"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="status"], [role="alert"], li, label, summary, input, select, textarea, [data-alert], [data-toast], [role="group"], [role="radiogroup"]';
  // What takes a tap is one box to the eye, painted or not. A live region, a list item or a group with no box of its own is looked into.
  const INTERACTIVE =
    'button, a[href], [role="button"], [role="switch"], [role="radio"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], summary, input, select, textarea';
  const CONTAINER_ROLES = ["group", "radiogroup", "dialog", "toolbar", "tabpanel", "region"];
  const FIELD = ["input", "select", "textarea"];
  const PICTURE = ["svg", "img", "canvas"];

  /** A part of what the eye reads. `start` marks a part set at its line's start, not centered or at the end, the only kind an edge follows. */
  /** `wrap` is the nearest flex row that wraps holding it, from the measured element down, if any. */
  type Atom = Box & { kind: "text" | "icon" | "box"; what: string; start?: boolean; wrap?: DomElement | null; element?: DomElement };
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
    // A proficiency unit's frame and tint mark words in a line (components/ProficiencyMark.tsx). It is not a box of its own, so its words are measured as text.
    if (el.matches('[data-proficiency-form="unit"]')) return false;
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
    // The block the line belongs to, and how far everything between the words and it moves them on purpose: the offsets, and each vertical alignment from the outermost in.
    let block: DomElement | null = parent;
    let shift: number | null = 0;
    const aligns: number[] = [];
    while (block && ["inline", "contents"].includes(style(block).display)) {
      const by = shiftOf(block);
      if (by === null) shift = null;
      else if (shift !== null) {
        shift += by.offset;
        aligns.unshift(by.align);
      }
      block = block.parentElement;
    }
    if (shift === null || !block || !["block", "flow-root", "list-item", "inline-block"].includes(style(block).display) || parseFloat(style(block).lineHeight) !== lh) return own;
    const bs = style(block);
    const top = block.getBoundingClientRect().top + ((parseFloat(bs.getPropertyValue("border-top-width")) || 0) + (parseFloat(bs.getPropertyValue("padding-top")) || 0)) * zoomOf(block);
    // The line's top is the top of its highest box: the block's own strut, or an aligned box around the words. The words stand `drop` below it.
    let at = 0;
    let highest = 0;
    for (const a of aligns) {
      at += a;
      highest = Math.min(highest, at);
    }
    const drop = at - highest;
    // The moves are taken off before the line is put on the grid and added back after. Snapping the moved words would cancel a move of about a pixel, or add the font's rounding to it.
    const lineTop = own.t - shift - drop;
    const i = Math.round((lineTop - top) / lhPx);
    const t = top + i * lhPx;
    // An aligned line is taller than the grid's step by its move, so a line wrapped under it stands off the grid by as much, and a move under a pixel would pass for the font's rounding. Only the block's first line is sure to start on the grid.
    const grows = aligns.some((a) => a !== 0);
    // Only the rounding of a font's metrics, at most a pixel, is put back. A line further off the grid, as beside a taller inline control, keeps the text's own estimate.
    return i >= 0 && !(grows && i > 0) && Math.abs(t - lineTop) <= 1 ? { t: t + drop + shift, b: t + drop + shift + lhPx } : own;
  }

  /**
   * How far down an inline element moves its words on purpose, in page
   * px: `offset` by a relative offset, which moves only what is painted,
   * and `align` by a vertical alignment of a length, which moves its box
   * in the line and grows the line (see the header). Null for a keyword
   * alignment, whose move rests on the font's metrics, or for an offset
   * or alignment not in px. A transform adds nothing, since it does not
   * move an inline box.
   */
  function shiftOf(el: DomElement): { offset: number; align: number } | null {
    const cs = style(el);
    const va = cs.getPropertyValue("vertical-align");
    // A length raises the box, and `align` counts down.
    const align = va === "baseline" ? 0 : va.endsWith("px") ? -parseFloat(va) * zoomOf(el) : null;
    if (align === null) return null;
    if (cs.position !== "relative") return { offset: 0, align };
    const px = (v: string) => (v.endsWith("px") ? parseFloat(v) * zoomOf(el) : null);
    const top = cs.getPropertyValue("top");
    const bottom = cs.getPropertyValue("bottom");
    if (top !== "auto" && top !== "") {
      const down = px(top);
      return down === null ? null : { offset: down, align };
    }
    if (bottom !== "auto" && bottom !== "") {
      const up = px(bottom);
      return up === null ? null : { offset: -up, align };
    }
    return { offset: 0, align };
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
    const wraps = (el: DomElement) => {
      const cs = style(el);
      return (cs.display === "flex" || cs.display === "inline-flex") && !cs.flexDirection.startsWith("column") && cs.flexWrap === "wrap";
    };
    const walk = (node: DomElement, clip: Box | null, outer: DomElement | null) => {
      const wrap = wraps(node) ? node : outer;
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
            const line: Atom = { kind: "text", l: r.left, r: r.right, t: lb.t, b: lb.b, what: `"${words.slice(0, 32)}"`, start: setAtStart(parent, container), wrap };
            // A line whose glyphs all show is seen whole, its leading too, though the leading runs past a cut.
            if (clip && r.top >= clip.t - 1 && r.bottom <= clip.b + 1) add(line, null);
            else add(line, clip);
          }
        } else if (isEl(ch)) {
          if (!shown(ch) || (placedApart(ch) && !(placed && style(ch).position === "absolute"))) continue;
          const start = setAtStart(node, container);
          if (isPicture(ch)) add({ kind: "icon", ...rectOf(ch), what: ch.getAttribute("role") === "img" ? `img "${ch.getAttribute("aria-label") ?? ""}"` : tag(ch), start, wrap }, clip);
          else if (FIELD.includes(tag(ch)) || ch.matches(INTERACTIVE) || paints(ch)) add({ kind: "box", ...rectOf(ch), what: say(ch), start, wrap, element: ch }, clip);
          else walk(ch, clips(ch) ? cutBy(clip, rectOf(ch)) : clip, wrap);
        }
      }
    };
    walk(container, clips(container) ? rectOf(container) : null, null);
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
   * its own words run over two lines. A line that holds one part alone is
   * that part's own first line: a label stacked over its help in a grid
   * starts its words at its top, so a label wrapped onto two lines has its
   * first line where its first words stand, not across both. Null for any
   * other element.
   */
  function laidFirstLine(el: DomElement): Box | null {
    const cs = style(el);
    const flex = (cs.display === "flex" || cs.display === "inline-flex") && !cs.flexDirection.startsWith("column");
    if (!flex && cs.display !== "grid" && cs.display !== "inline-grid") return null;
    const parts = Array.from(el.children)
      .filter((c) => shown(c) && !placedApart(c))
      .map((c) => ({ ...rectOf(c), c }));
    if (parts.length === 0) {
      if (!flex) return null;
      const b = boxes(el);
      return { l: b.inner.l + b.pad.l, r: b.inner.r - b.pad.r, t: b.inner.t + b.pad.t, b: b.inner.b - b.pad.b };
    }
    const first = linesOf(parts)[0]!;
    const sole = first.items.length === 1 ? seen(first.items[0]!.c) : null;
    return sole ? sole.first : first.box;
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
   * Where a row of a column starts, for the edge check, as the eye
   * follows it down: `words`, the left of what it holds (boxes, pictures
   * and words) set at its line's start, and `box`, its box's edge when it
   * draws one. What is centered or set at the end, as a field row's field
   * at its right, is no start. `notice` marks a painted row that is
   * neither tapped nor picked, so neither an option nor a chosen one
   * (`aria-checked`, `aria-selected` or `aria-pressed`, or a label holding
   * a checked input), whose fill shows the choice and so never places it.
   * `inset` marks a nested list
   * or group whose content starts at its own padding or margin, which the
   * column takes as a column of its own only when it sits an indent step
   * past the column's edge. Null for a disclosure, whose body starts under
   * its chevron, and for a row with nothing to start.
   */
  function edgeOf(row: DomElement): { words: number | null; box: number | null; notice: boolean; inset: boolean } | null {
    if (row.matches("[aria-expanded]") || row.querySelector(":scope > [aria-expanded], :scope > * > [aria-expanded]")) return null;
    const parts = atomsOf(row).filter((a) => a.start);
    const box = paints(row) ? round(rectOf(row).l) : null;
    const nested = row.matches('ul, ol, fieldset, [role="group"], [role="list"], [role="radiogroup"]');
    const column = nested && box === null && parts.every((a, i) => i === 0 || a.t >= parts[i - 1]!.b - 1);
    // Grouped menu items keep the content edge they use ungrouped. Other controls, such as radio cards, meet the surrounding column at their outer boxes.
    const starts = parts.map((a) => {
      const edge = column && a.element?.matches('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]') ? edgeOf(a.element) : null;
      return edge?.words ?? edge?.box ?? a.l;
    });
    const words = starts.length ? round(Math.min(...starts)) : null;
    if (words === null && box === null) return null;
    const chosen = row.matches('[aria-checked="true"], [aria-selected="true"], [aria-pressed="true"]') || (tag(row) === "label" && row.querySelector("input:checked") !== null);
    const notice = box !== null && !chosen && !row.matches(INTERACTIVE) && !row.matches("label, li, summary");
    let inset = false;
    if (words !== null && nested) {
      const b = boxes(row);
      const own = b.inner.l + b.pad.l;
      inset = Math.abs(words - own) <= LIMIT && (b.pad.l > LIMIT || (parseFloat(style(row).getPropertyValue("margin-left")) || 0) > LIMIT);
    }
    return { words, box, notice, inset };
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
      // A pane's sticky foot takes the pane's bottom padding back with a negative margin and gives it back as its own (components/Sheet.tsx stickyPaneFoot), so its fill meets the pane's edge. That much of its padding is the pane's inset, which every other part keeps from the edge too, so the foot's room is judged without it.
      const inset = cs.position === "sticky" ? Math.max(0, -num(cs, "margin-bottom")) * zoomOf(el) : 0;
      b.inner.b -= inset;
      b.pad.b -= inset;
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
          // So is content whose stacks a wrap put on lines of their own, as a group header's short summary wrapped under its name at the row's end:
          // each later line holds something that wrapped in the same flex row as something on a line above. An icon wholly above or below the
          // words beside it shares no wrapping row with them, so each is still centered on its own (DP34-OPUS-4).
          const stackLines = linesOf(stacks.map((s) => ({ ...s.box, s })));
          const wrapsOn = (k: number) => {
            const above = new Set(stackLines.slice(0, k).flatMap((ln) => ln.items.flatMap((it) => it.s.items.map((a) => a.wrap))));
            return stackLines[k]!.items.some((it) => it.s.items.some((a) => a.wrap && above.has(a.wrap)));
          };
          const wrapped = stackLines.length > 1 && stackLines.every((_, k) => k === 0 || wrapsOn(k));
          const several = stacks.some((s) => linesOf(s.items).length > 1) || wrapped;
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
      // A grid of one column holds no row, so a sticky part of it that overlaps others, as a pane's foot stuck over what scrolls under it, is in no row with them.
      const oneColumn = grid && cs.getPropertyValue("grid-template-columns").replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/).length === 1;
      if (flexRow || grid) {
        const items: Item[] = [];
        for (const ch of Array.from(el.childNodes)) {
          if (ch.nodeType === 3) {
            const words = (ch.textContent ?? "").trim();
            const s = words ? seen(ch) : null;
            if (s) items.push({ node: ch, ...s, box: s.v, boxed: false, mode: modeOf(cs.alignItems), what: `"${words.slice(0, 24)}"` });
          } else if (isEl(ch) && shown(ch) && !placedApart(ch) && !(oneColumn && style(ch).position === "sticky")) {
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
            const atoms = atomsOf(it.node);
            return atoms.length > 0 && atoms.every((a) => a.kind === "text");
          };
          // A part that holds nothing to read, as a picture or a bare swatch, is neither a name nor a control. It takes no side in the label check: an icon beside a name still names the controls under it, and an icon alone under words is still alone (FU40AC-OPUS-4).
          const blank = (it: Item) => isEl(it.node) && !FIELD.includes(tag(it.node)) && !it.node.matches(CONTROL) && atomsOf(it.node).length === 0;
          const prose = (it: Item) => isEl(it.node) && /^(h[1-6]|p)$/.test(tag(it.node));
          const pill = (it: Item) => isEl(it.node) && cornerDown(it.node, it.box.b - it.box.t) >= (it.box.b - it.box.t) / 2 - 0.5;
          const choices = el.getAttribute("role") === "radiogroup" || items.every(pill);
          // A part that grows to fill its line is a line of its own, as a window's buttons share each line they wrap onto.
          const content = { l: b.inner.l + b.pad.l, r: b.inner.r - b.pad.r };
          const fills = (it: Item) => it.box.l <= content.l + LIMIT && it.box.r >= content.r - LIMIT;
          // A name stacked above controls that leave its words no room beside them is a heading over them, as a FieldRow stacks its label over a field that does not fit (docs/design-v1-polish.md R2). It is alone only where its words would fit in the room the controls leave on their line.
          const gap = num(cs, "column-gap") * zoomOf(el);
          const roomBeside = (named: Item[], controls: Item[]) => {
            const need = named.reduce((n, it) => n + (it.v.r - it.v.l), 0) + gap * named.length;
            const held = union(controls.map((it) => it.v));
            return need <= content.r - content.l - (held.r - held.l) + LIMIT;
          };
          // A growing part could shrink beside another only to its content or CSS minimum width (reviews FU33-O3 and FU33-O6).
          const needs = (it: Item) => {
            const drawn = it.box.r - it.box.l;
            const atoms = isEl(it.node) ? atomsOf(it.node) : [];
            if (!isEl(it.node) || !atoms.length) return drawn;
            const own = union(atoms);
            const { border, inner, pad } = boxes(it.node);
            const content = own.r - own.l + pad.l + pad.r + (inner.l - border.l) + (border.r - inner.r);
            return Math.min(drawn, Math.max(num(style(it.node), "min-width") * zoomOf(it.node), content));
          };
          // A lone last part has company only where the part before it, the last on the line above, fits beside it on a line: a legendary row's LA with LR under its AC, HP and Lair is alone by need where Lair with LA and LR runs wider than the line (FU32-LAIR-ALONE). A part sized almost to its line is still alone, since at its content's width it would fit beside the part before it.
          const couldShare = (above: Item[], lone: Item) => {
            const last = above.reduce((a, c) => (c.box.l > a.box.l ? c : a));
            return needs(last) + gap + needs(lone) <= content.r - content.l + LIMIT;
          };
          for (let i = 1; i < lines.length; i++) {
            const prev = lines[i - 1]!.items.filter((it) => !ownLine(it));
            const cur = lines[i]!.items.filter((it) => !ownLine(it));
            if (!prev.length || !cur.length) continue;
            const named = i === 1 && prev.every((it) => words(it) || blank(it)) && prev.some(words) && !prev.some(prose) && cur.some((it) => !words(it) && !blank(it));
            // Names with no room beside their controls head them, but the last part above may still share a line with a lone part under it, as a crest and a short title over a header's actions.
            if (named && roomBeside(prev, cur)) {
              push({ check: "wrap-label", role: roleOf(el), name: nameOf(el), offset: round(mid(cur[0]!.box) - mid(prev[0]!.box)), box: union([...prev, ...cur].map((it) => it.box)), what: `${prev.map((it) => it.what).join(" + ")} alone above ${cur.map((it) => it.what).join(" + ")}`, detail: `in ${width} px` });
            } else if (i === lines.length - 1 && cur.length === 1 && prev.length >= 2 && !choices && !fills(cur[0]!) && couldShare(prev, cur[0]!)) {
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

      // 4. Edges: a column of rows starts each row at one left edge.
      if (kids.length >= 2) {
        const rs = kids.map(rectOf);
        let stacked = true;
        for (let i = 1; i < rs.length; i++) if (rs[i]!.t < rs[i - 1]!.b - 1) stacked = false;
        if (stacked) {
          const known = kids.flatMap((c) => {
            const edge = edgeOf(c);
            return edge ? [{ c, ...edge }] : [];
          });
          const near = (a: number, b: number) => Math.abs(a - b) <= LIMIT;
          const reported = new Set<DomElement>();
          // Lines for the rows of `at` that start apart from the most, each row meeting at any of its lefts. `least` is how many must share the edge. It gives the edge, or null when too few share one.
          const judge = (at: { c: DomElement; lefts: number[] }[], least: number, label: string): number | null => {
            const meets = (x: { lefts: number[] }, v: number) => x.lefts.some((l) => near(l, v));
            const mode = at.flatMap((x) => x.lefts).sort((a, b) => at.filter((y) => meets(y, b)).length - at.filter((y) => meets(y, a)).length)[0]!;
            const shared = at.filter((x) => meets(x, mode)).length;
            if (shared < least) return null;
            const off = (x: { lefts: number[] }) => x.lefts.reduce((a, l) => (Math.abs(l - mode) < Math.abs(a - mode) ? l : a)) - mode;
            const odd = at.filter((x) => !meets(x, mode) && !reported.has(x.c)).map((x) => ({ c: x.c, left: mode + off(x) }));
            if (!odd.length) return mode;
            for (const x of odd) reported.add(x.c);
            push({ check: "edge", role: roleOf(el), name: nameOf(el), offset: round(Math.max(...odd.map((x) => Math.abs(x.left - mode)))), box: union(odd.map((x) => rectOf(x.c))), what: odd.map((x) => `${say(x.c)} at ${round(x.left - mode)}`).join(" | "), detail: `${label} start at ${round(mode)}` });
            return mode;
          };
          // Each row is read by its words, and a row that draws a box around words it centers by its box. A lone painted notice may start at its words, or at its fill on the column's edge with its words set in by its border and padding alone. A chosen option's fill shows the choice, so it meets by its words.
          const painted = known.filter((x) => x.box !== null);
          const lone = painted.length === 1 && painted[0]!.notice ? painted[0]! : null;
          const rows = known.map((x) => ({ c: x.c, inset: x.inset, lefts: x.words === null ? [x.box!] : x === lone ? [x.box!, x.words] : [x.words] }));
          if (rows.length >= 3) {
            // The edge is read from the rows that are no nested list or group when two or more are.
            const plain = rows.filter((x) => !x.inset);
            const voters = plain.length >= 2 ? plain : rows;
            const meets = (x: { lefts: number[] }, v: number) => x.lefts.some((l) => near(l, v));
            const mode = voters.flatMap((x) => x.lefts).sort((a, b) => voters.filter((y) => meets(y, b)).length - voters.filter((y) => meets(y, a)).length)[0]!;
            // A nested list or group an indent step or more past the edge is a column of its own. Set in by less, it has drifted.
            const step = INDENT_PX * zoomOf(el) - LIMIT;
            // An edge is where two rows or more start: three rows that each start apart, as a dialog's header, body and foot, share none.
            const edge = judge(rows.filter((x) => !(x.inset && x.lefts[0]! - mode >= step)), 2, "most");
            // A lone notice on the edge by its fill holds its words in by its border and padding, so words set in further have drifted inside it.
            if (lone && lone.words !== null && edge !== null && near(lone.box!, edge) && !reported.has(lone.c)) {
              const b = boxes(lone.c);
              const off = round(lone.words - (b.inner.l + b.pad.l));
              if (Math.abs(off) > LIMIT) push({ check: "edge", role: roleOf(el), name: nameOf(el), offset: off, box: rectOf(lone.c), what: `${say(lone.c)} words at ${off} past its padding`, detail: `its fill starts on the edge at ${round(edge)}` });
            }
          }
          // Painted rows stacked in a column are boxes the eye lays side by side, so their fills share an edge, and so do their words.
          if (painted.length >= 2) {
            judge(painted.map((x) => ({ c: x.c, lefts: [x.box!] })), painted.length === 2 ? 1 : 2, "most fills");
            const worded = painted.filter((x) => x.words !== null);
            if (worded.length >= 2) judge(worded.map((x) => ({ c: x.c, lefts: [x.words!] })), worded.length === 2 ? 1 : 2, "most fills' words");
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
    // A long name wraps the title onto two lines or more, which its row centers on Close as one block, so the title is read from its first line's top to its last line's foot. The half-leading above the one and below the other are the same, so the glyphs and the line boxes share that middle.
    const rects = Array.from(range.getClientRects()).filter((x) => x.width > 0 && x.height > 0);
    if (rects.length === 0) continue;
    const lines = { top: Math.min(...rects.map((x) => x.top)), bottom: Math.max(...rects.map((x) => x.bottom)) };
    // The frame's top padding is the padding of the box the header row stands in, the frame or a scroller inside it, which a sticky header takes back with its margin.
    const holder = row.parentElement ?? frame;
    const holderZoom = zoomOf(holder);
    const inset = holder.getBoundingClientRect().top - box.top + ((parseFloat(style(holder).getPropertyValue("border-top-width")) || 0) + (parseFloat(style(holder).getPropertyValue("padding-top")) || 0)) * holderZoom;
    const c = close.getBoundingClientRect();
    out.push({
      frame: frame.getAttribute("aria-label") ?? title.textContent ?? "",
      close: round(c.top - box.top),
      title: round((lines.top + lines.bottom) / 2 - box.top),
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
  // Found by their mark, not their live role: the announcements live in a region of their own, so a toast may carry no role at all.
  const toasts = Array.from(doc.querySelectorAll("[data-toast]")).filter((el) => shown(el) && painted(el));
  // The alerts column holds a card of each kind marked `data-alert`, and the rolls' cards inside a wrapper with no box of its own (InitiativeStrip.tsx): its cards are its children as drawn.
  const columns = new Set<DomElement>();
  for (const marked of Array.from(doc.querySelectorAll("[data-alert]"))) {
    let col = marked.parentElement;
    while (col && style(col).display === "contents") col = col.parentElement;
    if (col) columns.add(col);
  }
  const drawn = (el: DomElement): DomElement[] => Array.from(el.children).flatMap((c) => (style(c).display === "contents" ? drawn(c) : shown(c) ? [c] : []));
  const cards = [...columns].flatMap(drawn).map(rect);
  // What shows of a toast: a stack that runs past its room scrolls there, its newest kept in view, so a toast taller than the room shows its foot under the card (pages/Room.tsx Toasts).
  const cut = (el: DomElement): Box => {
    let b = rect(el);
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = style(n);
      if (cs.getPropertyValue("overflow-x") === "visible" && cs.getPropertyValue("overflow-y") === "visible") continue;
      const c = rect(n);
      b = { l: Math.max(b.l, c.l), r: Math.min(b.r, c.r), t: Math.max(b.t, c.t), b: Math.min(b.b, c.b) };
    }
    return b;
  };
  return toasts.map((el) => {
    const t = cut(el);
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

/** A line for each pair of toast boxes whose visible portions overlap. */
export async function toastOverlapLines(page: Page, screen: string): Promise<string[]> {
  const seen = await page.evaluate(toastsInPage);
  const lines: string[] = [];
  for (let i = 0; i < seen.length; i++) {
    const a = seen[i]!;
    for (const b of seen.slice(i + 1)) {
      const width = Math.min(a.toast.r, b.toast.r) - Math.max(a.toast.l, b.toast.l);
      const height = Math.min(a.toast.b, b.toast.b) - Math.max(a.toast.t, b.toast.t);
      if (width > 0 && height > 0) lines.push(`${screen}: toast "${a.text}" overlaps "${b.text}" by ${width.toFixed(1)} x ${height.toFixed(1)} px`);
    }
  }
  return lines;
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

