import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { GROUP_BOX, GROUP_FOLD, Group, Section, summaryClip } = await import("./Panel.tsx");
const { SettingRow } = await import("./SettingRow.tsx");

/** A panel's groups (docs/design/design-v1-dice-ui.md 3.2, docs/design/design-v1-token-panel-groups.md 4), as markup. */
describe("Group", () => {
  test("its name is an h3 holding the disclosure, which says open or folded in aria-expanded and is named by the name alone", () => {
    const folded = renderToStaticMarkup(createElement(Group, { label: "Combat", open: false, onToggle: () => {}, summary: "HP 3/7 · 2 conditions" }, "inside"));
    assert.match(folded, /<h3[^>]*><button[^>]*aria-labelledby="([^"]+)"[^>]*aria-expanded="false"/);
    assert.match(folded, /aria-describedby="[^"]+-summary"/, "the summary describes it");
    assert.match(folded, />HP 3\/7 · 2 conditions</);
    assert.doesNotMatch(folded, /inside/, "folded, its content is not drawn");
    const open = renderToStaticMarkup(createElement(Group, { label: "Combat", open: true, onToggle: () => {}, summary: "HP 3/7" }, "inside"));
    assert.match(open, /aria-expanded="true"/);
    assert.doesNotMatch(open, />HP 3\/7</, "open, it shows no summary");
    assert.match(open, /inside/);
  });

  test("it is no landmark: no section, no region, no accessible name on its box", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Notes", open: true, onToggle: () => {} }, "inside"));
    assert.doesNotMatch(markup, /<section/);
    assert.doesNotMatch(markup, /role="region"/);
  });

  test("a group that never folds draws its name with no disclosure", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Stat block" }, "block"));
    assert.match(markup, /<h3[^>]*><span[^>]*>(<span[^>]*>)+Stat block<\/span>/);
    assert.doesNotMatch(markup, /aria-expanded/);
    assert.doesNotMatch(markup, /data-group-fold/, "and no fold to hand focus to");
  });

  test("code inside a group finds its box and its fold by GROUP_BOX and GROUP_FOLD, since the box is no section", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Token settings", open: true, onToggle: () => {} }, createElement(Section, { label: "Make a companion", children: "form" })));
    assert.equal(GROUP_BOX, "[data-panel-group]");
    assert.equal(GROUP_FOLD, "[data-group-fold]");
    assert.match(markup, /^<div data-panel-group=""/, "the group's own box");
    assert.match(markup, /<h3[^>]*><button[^>]*data-group-fold=""[^>]*aria-expanded="true"/, "its fold, in its heading");
    assert.equal(markup.match(/data-group-fold/g)?.length, 1, "one fold: a section's label inside is not one");
  });

  test("the sections inside part by 16 px with no bottom padding of their own, their labels a level under the group's (h4)", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Group,
        { label: "Combat", open: true, onToggle: () => {}, holds: "sections" },
        createElement(Section, { key: "a", label: "Hit points", children: "hp" }),
        createElement(Section, { key: "b", label: "Conditions", children: "conditions" }),
      ),
    );
    assert.match(markup, /gap:16px/, "the body parts its sections by space(4)");
    assert.match(markup, /<h4[^>]*>Hit points<\/h4>/);
    assert.match(markup, /<h4[^>]*>Conditions<\/h4>/);
    const sections = markup.match(/<section style="[^"]*"/g) ?? [];
    assert.equal(sections.length, 2);
    for (const s of sections) {
      assert.match(s, /padding-bottom:0/, "no bottom padding inside a group");
      assert.doesNotMatch(s, /border-top/, "no line between them");
    }
  });

  test("a group of fields keeps a section's 8 px between them, and a section outside any group keeps its h3, line and padding", () => {
    const rows = renderToStaticMarkup(createElement(Group, { label: "Stats", open: true, onToggle: () => {} }, "a", "b"));
    assert.match(rows, /gap:8px/);
    const alone = renderToStaticMarkup(createElement(Section, { label: "Sight", children: "sight" }));
    assert.match(alone, /<h3[^>]*>Sight<\/h3>/);
    assert.match(alone, /padding-bottom:16px/);
    assert.match(alone, /border-top/);
  });

  test("with keep, folded content stays mounted and hidden, and without it is not drawn", () => {
    const kept = renderToStaticMarkup(createElement(Group, { label: "Map image and grid", open: false, onToggle: () => {}, keep: true }, "the upload"));
    assert.match(kept, /<div hidden=""[^>]*>the upload<\/div>/);
    const shown = renderToStaticMarkup(createElement(Group, { label: "Map image and grid", open: true, onToggle: () => {}, keep: true }, "the upload"));
    assert.match(shown, />the upload</);
    assert.doesNotMatch(shown, /hidden=""/, "open, nothing is hidden");
    const gone = renderToStaticMarkup(createElement(Group, { label: "Map image and grid", open: false, onToggle: () => {} }, "the upload"));
    assert.doesNotMatch(gone, /the upload/);
  });

  test("a folded header lays the chevron and icon in a lead column, the name and summary in a row that wraps, by CSS alone (docs/design/design-v1-design-pass.md 4.1)", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Walls and movement", icon: "walls", open: false, onToggle: () => {}, summary: "Walls block moves" }, "inside"));
    const button = /<button[^>]*style="([^"]*)"[^>]*>(.*)<\/button>/.exec(markup);
    assert.ok(button, "the fold's button");
    const [, look = "", inner = ""] = button;
    assert.match(look, /display:grid/);
    assert.match(look, /grid-template-columns:auto minmax\(0, 1fr\)/, "the lead column at its own width, then the words");
    assert.match(look, /align-items:start/, "the lead stands by the name's first line");
    assert.match(look, /padding-block:14.4px/, "the name's line padded to 48 px, so a wrapped summary adds only its line");
    // The lead: chevron and icon in one span of the name's line height, before the words' row.
    assert.match(inner, /^<span style="[^"]*height:19.2px[^"]*"><svg[^>]*>.*?<\/svg><span aria-hidden="true" data-group-icon=""/);
    const row = /<span style="([^"]*)"><span id="[^"]+" data-group-name="" style="([^"]*)">Walls and movement<\/span><span id="[^"]+-summary" style="([^"]*)">Walls block moves<\/span><\/span>/.exec(inner);
    assert.ok(row, "the name and the summary share one wrapping row");
    const [, rowLook = "", nameLook = "", summaryLook = ""] = row;
    assert.match(rowLook, /flex-wrap:wrap/);
    assert.match(nameLook, /min-width:0/);
    assert.doesNotMatch(nameLook, /flex:none/, "the name may wrap between its words where it alone is wider than its column");
    assert.match(summaryLook, /flex:1 1 4em/);
    assert.match(summaryLook, /max-width:max-content/, "it asks no more than its words, so a summary shorter than its floor keeps the name's line where it fits");
    assert.match(summaryLook, /margin-left:auto/, "its margin sets it at the row's end, on either line");
    assert.match(summaryLook, /text-align:right/);
    assert.match(summaryLook, /text-overflow:ellipsis/);
    assert.match(summaryLook, /(?<![-a-z])width:4em/, "it asks the row for its floor alone, so an action keeps the name's line");
    assert.doesNotMatch(markup, /(?<![-a-z])width:[\d.]+px/, "no width measured");
  });

  test("fl12: a folded summary clips 1 px out where the browser takes a clip margin, and elsewhere gets 1 px of padding its margins take back (FL12-OPUS-6)", () => {
    // WebKit, so every browser on an iPhone, has no overflow-clip-margin: clipped at its box, a proficiency frame at its first or last word would lose its edges.
    const world = globalThis as { CSS?: unknown };
    const before = world.CSS;
    const asked: string[] = [];
    try {
      for (const margin of [true, false]) {
        world.CSS = { supports: (property: string, value: string) => (asked.push(`${property}: ${value}`), margin) };
        assert.deepEqual(summaryClip(), margin ? { overflow: "clip", overflowClipMargin: 1 } : { overflow: "hidden", paddingInline: 1, marginRight: -1 });
      }
      assert.deepEqual(asked, ["overflow-clip-margin: 1px", "overflow-clip-margin: 1px"]);
    } finally {
      world.CSS = before;
    }
    // Rendered here, with no browser to ask, it takes Chrome's way, as the end-to-end checks see it.
    const markup = renderToStaticMarkup(createElement(Group, { label: "Skills", open: false, onToggle: () => {}, summary: "Athletics +6" }, "inside"));
    assert.match(/id="[^"]+-summary" style="([^"]*)"/.exec(markup)?.[1] ?? "", /overflow:clip;overflow-clip-margin:1px/);
  });

  test("a group with no chevron and no icon has no empty lead column", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Stat block" }, "block"));
    assert.match(markup, /grid-template-columns:minmax\(0, 1fr\)[^"]*"><span[^>]*><span id/);
    assert.doesNotMatch(markup, /grid-template-columns:auto/);
  });

  /** A group's header: the fold's or the plain head's look, the lead's markup and the summary's look. */
  function header(markup: string) {
    const lead = /<h3[^>]*>(?:<button[^>]*>|<span style="[^"]*">)(<span style="[^"]*height:19.2px[^"]*">.*?<\/span>)?<span style="[^"]*flex-wrap:wrap/.exec(markup)?.[1] ?? "";
    const summary = /id="[^"]+-summary" style="([^"]*)"/.exec(markup)?.[1] ?? "";
    return { lead, summary };
  }

  test("panel groups 6.1: with wholeSummary the summary asks for its whole words in the same wrapping row, and without it the 4em floor stays", () => {
    const folded = { label: "Weather", icon: "image", open: false, onToggle: () => {}, summary: "Heavy rain · Strong wind" } as const;
    const whole = renderToStaticMarkup(createElement(Group, { ...folded, wholeSummary: true }, "inside"));
    const look = header(whole).summary;
    assert.match(look, /^flex:0 1 auto;min-width:0;margin-left:auto/, "its words' own width, shrinking only past its line");
    assert.doesNotMatch(look, /4em/, "no floor to cut it to");
    assert.doesNotMatch(look, /max-width/);
    assert.match(look, /white-space:nowrap/);
    assert.match(look, /text-overflow:ellipsis/, "cut only where its own line is too short");
    assert.match(whole, /<span style="[^"]*flex-wrap:wrap[^"]*"><span id="[^"]+" data-group-name=""[^>]*>Weather<\/span><span id="[^"]+-summary"/, "it shares the name's wrapping row, so it moves under the name where it does not fit beside it");
    const floor = header(renderToStaticMarkup(createElement(Group, folded, "inside"))).summary;
    assert.match(floor, /^flex:1 1 4em;width:4em;min-width:0;max-width:max-content;margin-left:auto/, "today's rule, unchanged");
  });

  test("panel groups 6.1: reserve keeps the missing chevron's or icon's space at the lead, so the name lines up with its peers", () => {
    const reserved = (markup: string) => (markup.match(/<span aria-hidden="true" data-group-reserve="" style="display:block;flex:none;width:16px;height:16px"><\/span>/g) ?? []).length;
    // Join requests: no fold and no icon, under folding groups with no icons.
    const join = renderToStaticMarkup(createElement(Group, { label: "Join requests", reserve: "chevron" }, "asks"));
    assert.equal(reserved(join), 1);
    assert.match(join, /grid-template-columns:auto minmax\(0, 1fr\)/, "a lead column, as its folding peers have");
    assert.match(header(join).lead, /^<span[^>]*><span aria-hidden="true" data-group-reserve=""[^>]*><\/span><\/span>$/, "the space alone, where a chevron would be");
    // The Stat block with no fold: its icon after a chevron's space, as its folding peers' icons sit.
    const block = header(renderToStaticMarkup(createElement(Group, { label: "Stat block", icon: "statBlock", reserve: "chevron" }))).lead;
    assert.match(block, /^<span[^>]*><span aria-hidden="true" data-group-reserve=""[^>]*><\/span><span aria-hidden="true" data-group-icon=""/, "the chevron's space, then the icon");
    // New scene: a fold with no icon, among groups with icons.
    const scene = header(renderToStaticMarkup(createElement(Group, { label: "New scene", open: false, onToggle: () => {}, reserve: "icon" }, "form"))).lead;
    assert.match(scene, /^<span[^>]*><svg[^>]*>.*?<\/svg><span aria-hidden="true" data-group-reserve=""[^>]*><\/span><\/span>$/, "the chevron, then the icon's space");
    // A reserve where the group draws the real thing keeps nothing extra.
    assert.equal(reserved(renderToStaticMarkup(createElement(Group, { label: "Combat", open: true, onToggle: () => {}, reserve: "chevron" }))), 0);
    assert.equal(reserved(renderToStaticMarkup(createElement(Group, { label: "Stats", icon: "stats", reserve: "icon" }))), 0);
    assert.equal(reserved(renderToStaticMarkup(createElement(Group, { label: "Stat block", icon: "statBlock" }))), 0, "none unless asked");
  });

  test("panel groups 6.1: divider={false} drops the line over a panel's first group, and every other group keeps it", () => {
    const first = renderToStaticMarkup(createElement(Group, { label: "Time", open: true, onToggle: () => {}, divider: false }, "x"));
    assert.match(first, /^<div data-panel-group="" style="display:grid;grid-template-columns:minmax\(0, 1fr\)">/);
    for (const divider of [undefined, true]) {
      const markup = renderToStaticMarkup(createElement(Group, { label: "Time", open: true, onToggle: () => {}, ...(divider === undefined ? {} : { divider }) }, "x"));
      assert.match(markup, /^<div data-panel-group="" style="[^"]*border-top:1px solid/, `divider ${divider}`);
    }
  });

  test("panel groups 11: every group's name carries data-group-name, a group with no fold included", () => {
    for (const props of [{ label: "Combat", open: true, onToggle: () => {} }, { label: "Join requests" }, { label: "Stat block", icon: "statBlock" as const }]) {
      const markup = renderToStaticMarkup(createElement(Group, props, "x"));
      assert.match(markup, new RegExp(`<span id="[^"]+" data-group-name=""[^>]*>${props.label}</span>`));
      assert.equal(markup.match(/data-group-name/g)?.length, 1);
    }
  });
});

describe("SettingRow", () => {
  test("panel groups 6.2: with onOpen the row is one button holding the name, the help and a trailing chevron, named by its label", () => {
    const markup = renderToStaticMarkup(createElement(SettingRow, { name: "Weather", help: "Heavy rain · Strong wind", label: "Weather: Heavy rain · Strong wind, in Ambiance", onOpen: () => {} }));
    assert.match(markup, /^<button type="button" data-setting-row="" aria-label="Weather: Heavy rain · Strong wind, in Ambiance" style="display:flex;flex-wrap:nowrap;align-items:center;gap:8px 12px;min-height:44px;padding:8px 0;width:100%;margin:0;background:transparent;border:none/, "a setting's row, its own box, no card");
    assert.equal(markup.match(/<button/g)?.length, 1, "one button, no control inside it");
    assert.doesNotMatch(markup, /<div/, "a button holds spans only");
    assert.match(markup, /<span id="[^"]+" style="[^"]*">Weather<\/span><span id="[^"]+" style="[^"]*">Heavy rain · Strong wind<\/span>/);
    const chevron = /<span style="flex:none;display:flex;color:([^"]+)"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20"/.exec(markup);
    assert.ok(chevron, "a chevron at md where a control would sit");
    assert.equal(markup.indexOf("Heavy rain") < markup.indexOf("<svg"), true, "after the words");
  });

  test("with onOpen and no label, the row's words name it", () => {
    const markup = renderToStaticMarkup(createElement(SettingRow, { name: "Weather", help: "Clear", onOpen: () => {} }));
    assert.doesNotMatch(markup, /aria-label/);
    assert.match(markup, />Weather<.*>Clear</);
  });

  test("without onOpen the row draws as it always has: the words and the control in their own boxes, no button of its own", () => {
    const markup = renderToStaticMarkup(createElement(SettingRow, { name: "Light", help: "Bright", children: "control" }));
    assert.match(markup, /^<div data-setting-row="" style="display:flex;flex-wrap:nowrap;align-items:center;gap:8px 12px;min-height:44px;padding:8px 0"><div style="flex:1 1 auto;min-width:0;display:grid;gap:2px"><span id="[^"]+" style="[^"]*">Light<\/span><span id="[^"]+" style="[^"]*">Bright<\/span><\/div><div style="flex:none;min-width:0;display:flex;justify-content:flex-end">control<\/div><\/div>$/);
    assert.doesNotMatch(markup, /<button/);
  });

  test("a row takes its control or onOpen, one of the two, by its type", () => {
    // @ts-expect-error: a row with neither has nothing to show where its control would sit.
    void createElement(SettingRow, { name: "Nothing" });
    // @ts-expect-error: a row that opens elsewhere holds no control of its own.
    void createElement(SettingRow, { name: "Both", onOpen: () => {}, children: "control" });
    // @ts-expect-error: a label names the button, so a row with a control takes none.
    void createElement(SettingRow, { name: "Label", label: "x", children: "control" });
    assert.ok(true);
  });
});
