import type { Locator } from "playwright-core";
import { theme } from "../../client/lib/theme.ts";
import { LIMIT_PX } from "./alignment.ts";

/**
 * The spacing check (docs/design-v1-spacing-pass.md 6), beside the
 * alignment check: the gaps the spacing pass measured, kept as a test, so
 * a name that sits on its cards or a section label that stands nearer its
 * content than its neighbors fails a run rather than waiting for someone
 * to notice.
 *
 * Every rule reads the root's nearest scroller: the nearest element from
 * the root up, below the document, whose computed `overflow-y` is auto or
 * scroll, whether or not its content overflows now, or the root itself
 * where there is none. A screen whose root is one part of a page is held
 * against the whole page it scrolls with, and a bar row, a toast or a pill
 * never widens to the document. Each scroller is read once per call,
 * however many elements the root matches.
 *
 * 1. A name over a card group: a `[data-card-group]` (RadioCards' cards,
 *    the dice tiles) and its name, the fieldset's legend or what its
 *    `aria-labelledby` names. The name stands `space(2)` over the first
 *    card, or `space(1)` over a help and the help `space(2)` over the
 *    first card. A legend is read by its own box, since its fieldset's
 *    `gap` never reaches it. Also a `label[for]` that is the first child
 *    of a one-column grid and names a field (not a checkbox or a radio):
 *    `space(1)` over that field.
 * 2. A section label to its content: a `[data-section-label]` (the
 *    heading where it stands alone, the row that holds it otherwise) to
 *    the next shown box under it, from the label's box less its bottom
 *    padding and border, so padding that carries the gap counts as gap
 *    and a note or summary that wraps in the row counts as label:
 *    `space(2)`.
 * 3. Settings sections agree: every section label whose content opens
 *    with a settings row or choice (`[role="switch"]`,
 *    `[data-setting-row]`, `[data-card-group]`) stands its heading's
 *    words one distance over that content's first words, among labels of
 *    one kind: a lone heading, a fold's row, or another label row (an
 *    action's). A fold or an action centers the label's words in a 44 px
 *    row, about 14 px over the row's foot, so measured from the words it
 *    could never agree with a lone heading, and it is held to its own kind.
 * 4. Headings agree: an h2 to h4 of one look (tag, size, weight and the
 *    rule under it) stands one layout gap over its content. A ruled
 *    heading is a look of its own, so a stat block's ruled title is not
 *    held to the creature header's plain one, two type blocks the look
 *    passes kept apart (D-261030-525). A heading in the section label's
 *    look, in or carrying a section label marker, holding a button or
 *    sharing its row with one (a group's or a fold's header) is not one.
 *
 * Gaps are in layout px, as at 100%: what the page draws, through the
 * zoom the element is drawn at. A gap is off when it is more than
 * LIMIT_PX from what its rule wants.
 * A visible marked group or label that cannot be measured fails with a
 * named skipped finding. Hidden structures have no gap and are ignored.
 */

export type SpacingRule = "card-name" | "field-label" | "section-label" | "settings" | "headings";

/** One measured pair, passing or not. */
export type SpacingFinding = {
  rule: SpacingRule;
  /** The words of the name, label or heading. */
  name: string;
  /** What it stands over: "its first card", "its help", "its field", or the first words of what follows. */
  over: string;
  /** The gap, and the gap its rule wants, in layout px rounded to 0.1. */
  gap: number;
  want: number;
  /** A help's own gap to the first card, under its group's name. */
  help?: boolean;
  /** Rules 3 and 4: how many others in the scroller stand at `want`, and the heading's tag. */
  others?: number;
  tag?: string;
  /** A required marked structure could not be measured. This always fails. */
  skipped?: string;
};

/*
 * The page code below runs in the browser through evaluate, so it holds
 * everything it uses, and reads the DOM through the few shapes named
 * here: e2e is typechecked without the DOM's types.
 */
type DomRect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
type DomStyle = { display: string; visibility: string; opacity: string; overflowY: string; textTransform: string; fontSize: string; fontWeight: string; getPropertyValue(name: string): string };
type DomNode = { nodeType: number; textContent: string | null; parentElement: DomElement | null; childNodes: ArrayLike<DomNode> };
type DomElement = DomNode & {
  tagName: string;
  children: ArrayLike<DomElement>;
  nextElementSibling: DomElement | null;
  /** The zoom the element is drawn at, every zoomed ancestor's taken together. */
  currentCSSZoom?: number;
  ownerDocument: DomDocument;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  closest(selector: string): DomElement | null;
  contains(other: DomNode | null): boolean;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getBoundingClientRect(): DomRect;
};
type DomRange = { selectNodeContents(node: DomNode): void; getClientRects(): ArrayLike<DomRect> };
type DomDocument = {
  documentElement: DomElement;
  body: DomElement | null;
  createRange(): DomRange;
  getElementById(id: string): DomElement | null;
  defaultView: { getComputedStyle(el: DomElement): DomStyle };
};

type PageOptions = { limit: number; unit: number; optional?: boolean };

/** The four rules over each scroller the roots sit in. One function, so evaluate can send it whole. */
function spacingInPage(roots: DomElement[], opts: PageOptions): SpacingFinding[] {
  if (roots.length === 0 && !opts.optional) throw new Error("measureSpacing: no roots matched");
  const doc = roots[0]?.ownerDocument;
  if (!doc) return [];
  const win = doc.defaultView;
  const { limit, unit } = opts;
  const out: SpacingFinding[] = [];
  const style = (el: DomElement) => win.getComputedStyle(el);
  const num = (cs: DomStyle, prop: string) => parseFloat(cs.getPropertyValue(prop)) || 0;
  const round = (n: number) => Math.round(n * 10) / 10 || 0;
  const zoomOf = (el: DomElement) => el.currentCSSZoom ?? 1;
  const words = (node: DomNode | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
  const skip = (rule: SpacingRule, el: DomElement, why: string) => out.push({
    rule, name: el.getAttribute("aria-label") || words(el) || el.getAttribute("id") || el.tagName.toLowerCase(),
    over: "", gap: 0, want: 0, skipped: why,
  });
  const kids = (el: DomElement) => Array.from(el.children);
  const drawn = (el: DomElement) => {
    const cs = style(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  const shown = (el: DomElement) => {
    if (!drawn(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  const required = (el: DomElement) => {
    // An empty required group can have zero height. Only explicit hiding exempts its structure.
    for (let node: DomElement | null = el; node; node = node.parentElement) if (!drawn(node)) return false;
    return true;
  };
  const nextShown = (el: DomElement) => {
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) if (shown(n)) return n;
    return null;
  };
  const sectionContent = (label: DomElement) => {
    const next = nextShown(label);
    if (next) return next;
    const holder = label.parentElement;
    // Panels puts each section heading alone in a full-width list item before its content items.
    if (holder?.tagName === "LI" && holder.children.length === 1 && holder.children[0] === label && holder.parentElement?.matches("ul, ol")) {
      const item = nextShown(holder);
      if (item?.children.length === 1 && item.children[0]?.matches("[data-section-label]")) return null;
      return item;
    }
    return null;
  };

  /** The rects of an element's words in document order, each with the element that holds them. */
  function wordRects(el: DomElement): { r: DomRect; el: DomElement }[] {
    const found: { r: DomRect; el: DomElement }[] = [];
    const walk = (node: DomElement) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          if (!(child.textContent ?? "").trim()) continue;
          const range = doc!.createRange();
          range.selectNodeContents(child);
          for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) found.push({ r, el: node });
        } else if (child.nodeType === 1 && drawn(child as DomElement)) walk(child as DomElement);
      }
    };
    if (drawn(el)) walk(el);
    return found;
  }
  /** The first words of what follows a label, for its line. */
  const opening = (el: DomElement) => words(wordRects(el)[0]?.el ?? el);
  /** A label's own heading: the marked element where it is one, else the heading in its row. */
  const headingOf = (label: DomElement) => (label.matches("h2, h3, h4") ? label : (label.querySelector("h2, h3, h4") ?? label));
  /** A card group's name: what its aria-labelledby names, or its fieldset's legend. */
  const nameOf = (group: DomElement) => {
    const by = group.getAttribute("aria-labelledby");
    if (by) return doc.getElementById(by.split(/\s+/)[0] ?? "");
    const fieldset = group.closest("fieldset");
    return fieldset ? (kids(fieldset).find((c) => c.tagName === "LEGEND") ?? null) : null;
  };
  /** The value most of `values` stand within `limit` of, the first of them on a tie. */
  const usual = (values: number[]) => {
    let best = values[0] ?? 0;
    let most = -1;
    for (const v of values) {
      const near = values.filter((w) => Math.abs(w - v) <= limit).length;
      if (near > most) {
        best = v;
        most = near;
      }
    }
    return best;
  };
  /** Holds each of `items` to the usual value among those of its key, for rules 3 and 4. */
  function agree<T extends { key: string; gap: number }>(items: T[], finding: (item: T, want: number, others: number) => SpacingFinding) {
    for (const key of new Set(items.map((i) => i.key))) {
      const set = items.filter((i) => i.key === key);
      const want = usual(set.map((i) => i.gap));
      for (const item of set) out.push(finding(item, round(want), set.filter((o) => o !== item && Math.abs(o.gap - want) <= limit).length));
    }
  }

  const scrollerOf = (el: DomElement) => {
    for (let p: DomElement | null = el; p && p !== doc.documentElement && p !== doc.body; p = p.parentElement) {
      const y = style(p).overflowY;
      if (y === "auto" || y === "scroll") return p;
    }
    return el;
  };
  const scopes: DomElement[] = [];
  for (const root of roots) {
    const scope = scrollerOf(root);
    if (!scopes.includes(scope)) scopes.push(scope);
  }
  const SETTINGS = '[role="switch"], [data-setting-row], [data-card-group]';
  const ACTION = 'button, [role="button"], a[href]';
  const FIELD = 'input:not([type="checkbox"]):not([type="radio"]), select, textarea';

  for (const scope of scopes.filter((s) => !scopes.some((o) => o !== s && o.contains(s)))) {
    const within = (selector: string, marked = false) => [...(scope.matches(selector) ? [scope] : []), ...Array.from(scope.querySelectorAll(selector))].filter(marked ? required : shown);

    // 1. A name over its cards, through the help between them when there is one.
    for (const group of within("[data-card-group]", true)) {
      const name = nameOf(group);
      const first = kids(group).find(shown);
      if (!name) { skip("card-name", group, "no name found"); continue; }
      if (!shown(name)) { skip("card-name", name, "its name is hidden"); continue; }
      if (!first) { skip("card-name", name, "no shown card"); continue; }
      let box: DomElement | null = name;
      while (box && !box.contains(group)) box = box.parentElement;
      if (!box) { skip("card-name", group, "its name and cards have no common container"); continue; }
      const all = Array.from(box.querySelectorAll("*"));
      const between = all.slice(all.indexOf(name) + 1, all.indexOf(group)).filter((el) => !name.contains(el) && !el.contains(group) && shown(el) && wordRects(el).length > 0);
      const helps = between.filter((el) => !between.includes(el.parentElement as DomElement));
      const z = zoomOf(name);
      const bottom = name.getBoundingClientRect().bottom;
      const top = first.getBoundingClientRect().top;
      const lead = helps[0];
      const last = helps[helps.length - 1];
      if (!lead || !last) {
        out.push({ rule: "card-name", name: words(name), over: "its first card", gap: round((top - bottom) / z), want: 2 * unit });
        continue;
      }
      out.push({ rule: "card-name", name: words(name), over: "its help", gap: round((lead.getBoundingClientRect().top - bottom) / z), want: unit });
      out.push({ rule: "card-name", name: words(name), over: "its first card", help: true, gap: round((top - last.getBoundingClientRect().bottom) / z), want: 2 * unit });
    }

    // 1. A field's own label, first in its one-column grid.
    for (const label of within("label[for]")) {
      const parent = label.parentElement;
      if (!parent || parent.children[0] !== label) continue;
      const grid = style(parent);
      const columns = grid.getPropertyValue("grid-template-columns").trim();
      if (!grid.display.includes("grid") || (columns !== "none" && columns.split(/\s+/).length !== 1)) continue;
      const field = doc.getElementById(label.getAttribute("for") ?? "");
      if (!field) { skip("field-label", label, "no field found"); continue; }
      // Checkbox and radio labels belong to their controls, not the field-gap rule.
      if (!field.matches(FIELD)) continue;
      if (!shown(field)) { skip("field-label", label, "its field is hidden"); continue; }
      const gap = (field.getBoundingClientRect().top - label.getBoundingClientRect().bottom) / zoomOf(label);
      out.push({ rule: "field-label", name: words(label), over: "its field", gap: round(gap), want: unit });
    }

    // 2 and 3. Section labels, each to what stands under it.
    const settings: { key: string; gap: number; name: string; over: string }[] = [];
    for (const label of within("[data-section-label]", true)) {
      // FoldLabel intentionally unmounts or hides its content while closed.
      if (label.querySelector('button[aria-expanded="false"]')) continue;
      const next = sectionContent(label);
      if (!next) { skip("section-label", label, "no shown content follows"); continue; }
      const box = label.getBoundingClientRect();
      const nextTop = next.getBoundingClientRect().top;
      if (nextTop < box.top + 1) { skip("section-label", label, "the next shown box is not below it"); continue; }
      const cs = style(label);
      const z = zoomOf(label);
      const foot = box.bottom - (num(cs, "padding-bottom") + num(cs, "border-bottom-width")) * z;
      const heading = headingOf(label);
      out.push({ rule: "section-label", name: words(heading), over: opening(next), gap: round((nextTop - foot) / z), want: 2 * unit });

      const parts = [...(next.matches(SETTINGS) ? [next] : []), ...Array.from(next.querySelectorAll(SETTINGS))];
      const opener = wordRects(next)[0];
      const own = wordRects(heading);
      if (!opener || own.length === 0) continue;
      if (!parts.some((p) => p.contains(opener.el) || (p.matches("[data-card-group]") && !!nameOf(p)?.contains(opener.el)))) continue;
      const kind = label.matches("h2, h3, h4") ? "heading" : label.querySelector("[aria-expanded]") ? "fold" : "row";
      const ownBottom = Math.max(...own.map((w) => w.r.bottom));
      settings.push({ key: kind, gap: (opener.r.top - ownBottom) / z, name: words(heading), over: words(opener.el) });
    }
    agree(settings, (s, want, others) => ({ rule: "settings", name: s.name, over: s.over, gap: round(s.gap), want, others }));

    // 4. Headings of one look, each over its content.
    const heads: { key: string; gap: number; name: string; over: string; tag: string }[] = [];
    for (const h of within("h2, h3, h4")) {
      const cs = style(h);
      if (cs.textTransform === "uppercase" || h.closest("[data-section-label]") || h.querySelector("[data-section-label]") || h.querySelector("button[aria-expanded]")) continue;
      const box = h.getBoundingClientRect();
      const mates = h.parentElement ? kids(h.parentElement).filter((sibling) => sibling.matches(ACTION)) : [];
      if (mates.some((b) => !h.contains(b) && shown(b) && b.getBoundingClientRect().top < box.bottom && box.top < b.getBoundingClientRect().bottom)) continue;
      const next = nextShown(h);
      if (!next) continue;
      const nextTop = next.getBoundingClientRect().top;
      if (nextTop < box.top + 1) continue;
      const tag = h.tagName.toLowerCase();
      const ruled = num(cs, "border-bottom-width") > 0 && cs.getPropertyValue("border-bottom-style") !== "none";
      heads.push({ key: `${tag}/${cs.fontSize}/${cs.fontWeight}/${ruled ? "ruled" : "plain"}`, gap: (nextTop - box.bottom) / zoomOf(h), name: words(h), over: opening(next), tag });
    }
    agree(heads, (h, want, others) => ({ rule: "headings", name: h.name, over: h.over, gap: round(h.gap), want, others, tag: h.tag }));
  }
  return out;
}

/** Every pair in the roots' scrollers. Only an explicitly optional root may be absent. */
export async function measureSpacing(root: Locator, opts: { optional?: boolean } = {}): Promise<SpacingFinding[]> {
  return root.evaluateAll(spacingInPage, { limit: LIMIT_PX, unit: theme.space(1), optional: opts.optional });
}

/** Whether a measured pair is off its rule's gap. */
export function spacingOff(f: SpacingFinding): boolean {
  return f.skipped !== undefined || Math.abs(f.gap - f.want) > LIMIT_PX;
}

/** The lines for what is off, each naming the screen, the pair's words and both numbers. */
export function spacingLines(findings: readonly SpacingFinding[], screen: string): string[] {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  return findings.filter(spacingOff).map((f) => {
    if (f.skipped !== undefined) return `${screen}: skipped ${f.rule} "${f.name}": ${f.skipped}`;
    switch (f.rule) {
      case "card-name":
        return f.help
          ? `${screen}: "${f.name}"'s help sits ${f.gap} px over its first card, wants ${f.want}`
          : `${screen}: "${f.name}" sits ${f.gap} px over ${f.over}, wants ${f.want}`;
      case "field-label":
        return `${screen}: label "${f.name}" sits ${f.gap} px over its field, wants ${f.want}`;
      case "section-label":
        return `${screen}: section label "${f.name}" sits ${f.gap} px over "${f.over}", wants ${f.want}`;
      case "settings":
        return `${screen}: section label "${f.name}" stands ${f.gap} px over "${f.over}", where ${f.others} other settings ${plural(f.others ?? 0, "section stands", "sections stand")} ${f.want}`;
      case "headings":
        return `${screen}: ${f.tag} "${f.name}" sits ${f.gap} px over "${f.over}", where ${f.others} other ${f.tag} of its look ${plural(f.others ?? 0, "sits", "sit")} ${f.want}`;
    }
  });
}
