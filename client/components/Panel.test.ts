import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { GROUP_BOX, GROUP_FOLD, Group, Section, summaryClip } = await import("./Panel.tsx");
const { SettingRow } = await import("./SettingRow.tsx");
const { Tag } = await import("./Tag.tsx");

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

  test("scenes-reorg 9: with onOpen the header is one button that opens elsewhere: data-group-open, no aria-expanded, no body, the summary shown and describing it, a trailing sm chevron", () => {
    const markup = renderToStaticMarkup(
      createElement(Group, { label: "Weather", icon: "weather", reserve: "chevron", wholeSummary: true, summary: "Heavy rain · Strong wind", onOpen: () => {}, openLabel: "Weather: Heavy rain · Strong wind, in Goblin cave's settings" }),
    );
    assert.equal(markup.match(/<button/g)?.length, 1, "one button");
    const button = /<h3[^>]*><button ([^>]*)>(.*)<\/button><\/h3>/.exec(markup);
    assert.ok(button, "the button is the heading's");
    const [, attrs = "", inner = ""] = button;
    assert.match(attrs, /^type="button" data-group-open="" aria-label="Weather: Heavy rain · Strong wind, in Goblin cave&#x27;s settings" aria-describedby="([^"]+-summary)"/, "named by openLabel, described by the summary");
    assert.doesNotMatch(attrs, /aria-labelledby/, "openLabel names it alone");
    assert.doesNotMatch(markup, /aria-expanded/, "it never folds");
    assert.doesNotMatch(markup, /data-group-fold/, "never taken for a fold");
    assert.match(attrs, /grid-template-columns:auto minmax\(0, 1fr\) auto/, "the lead, the words, the chevron's own column");
    const describedBy = /aria-describedby="([^"]+)"/.exec(attrs)?.[1];
    assert.match(markup, new RegExp(`<span id="${describedBy}" style="flex:0 1 auto;min-width:0;margin-left:auto[^"]*">Heavy rain · Strong wind</span>`), "its whole summary, shown though it is no fold");
    assert.match(inner, /data-group-reserve=""[^>]*><\/span><span aria-hidden="true" data-group-icon=""/, "the lead as a group's: the chevron's space, then the icon");
    assert.match(inner, /data-group-name=""[^>]*>Weather<\/span>/);
    const trail = /<\/span><\/span><span style="([^"]*)"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16"[^>]*>(.*?)<\/svg><\/span>$/.exec(inner);
    assert.ok(trail, "a 16 px chevron after the words, last in the button");
    assert.match(trail[1] ?? "", /height:19.2px/, "as tall as the name's line, so it stands by the name when the summary wraps");
    assert.match(trail[1] ?? "", /color:/);
    assert.equal(trail[2], renderToStaticMarkup(createElement(Group, { label: "x", open: false, onToggle: () => {} })).match(/<svg[^>]*>(.*?)<\/svg>/)?.[1], "the folded chevron's own shape, chevronRight");
    assert.match(markup, /^<div data-panel-group="" style="[^"]*border-top:1px solid/, "a group's line over it");
    assert.match(attrs, /min-height:48px/, "a group's 48 px row");
  });

  test("an opening group with no openLabel is named by its name, and with no lead has only the words and the chevron's columns", () => {
    const markup = renderToStaticMarkup(createElement(Group, { label: "Scene sound", summary: "None of its own", onOpen: () => {} }));
    const id = /data-group-name=""/.test(markup) ? /<span id="([^"]+)" data-group-name=""/.exec(markup)?.[1] : undefined;
    assert.ok(id);
    assert.match(markup, new RegExp(`<button type="button" data-group-open="" aria-labelledby="${id}" aria-describedby="${id}-summary"`));
    assert.doesNotMatch(markup, /aria-label=/);
    assert.match(markup, /grid-template-columns:minmax\(0, 1fr\) auto;/);
    const plain = renderToStaticMarkup(createElement(Group, { label: "Scene sound", onOpen: () => {} }));
    assert.doesNotMatch(plain, /aria-describedby/, "no summary, no description");
  });

  test("an opening group calls onOpen, focusing its button first so a field being typed in commits", () => {
    const calls: string[] = [];
    // A render to markup runs no handlers, so this reads the button's props from the element tree Group returns, drawn inside a component for its hooks.
    let tree: unknown = null;
    function Probe() {
      tree = Group({ label: "Weather", onOpen: () => calls.push("open") });
      return tree as ReturnType<typeof Group>;
    }
    renderToStaticMarkup(createElement(Probe));
    const button = findButton(tree);
    assert.ok(button, "the header's button");
    button.props.onClick({ currentTarget: { focus: () => calls.push("focus") } });
    assert.deepEqual(calls, ["focus", "open"]);
  });

  test("an opening group takes no fold, no body and no fold's ref, by its type", () => {
    // @ts-expect-error: a group that opens elsewhere never folds.
    void createElement(Group, { label: "Weather", onOpen: () => {}, open: false, onToggle: () => {} });
    // @ts-expect-error: it holds no body.
    void createElement(Group, { label: "Weather", onOpen: () => {}, children: "inside" });
    // @ts-expect-error: openLabel names an opening group's button alone.
    void createElement(Group, { label: "Weather", openLabel: "x", open: true, onToggle: () => {} });
    assert.ok(true);
  });

  test("scenes-reorg 9: describedBy adds its ids after the summary's on a fold, alone where no summary shows, and nothing without it", () => {
    const folded = renderToStaticMarkup(createElement(Group, { label: "Fog and vision", open: false, onToggle: () => {}, summary: "Explore", describedBy: "tag-1", action: createElement(Tag, { id: "tag-1", tone: "warning", children: "No walls" }) }, "x"));
    assert.match(folded, /aria-describedby="[^"]+-summary tag-1"/, "the summary, then the tag");
    assert.match(folded, /<span id="tag-1" style="[^"]*">No walls<\/span>/, "the tag the id points at, with the words the fold is described by");
    const open = renderToStaticMarkup(createElement(Group, { label: "Fog and vision", open: true, onToggle: () => {}, summary: "Explore", describedBy: "tag-1" }, "x"));
    assert.match(open, /aria-describedby="tag-1"/, "open, no summary shows, so the tag alone");
    const none = renderToStaticMarkup(createElement(Group, { label: "Fog and vision", open: true, onToggle: () => {} }, "x"));
    assert.doesNotMatch(none, /aria-describedby/);
    const opener = renderToStaticMarkup(createElement(Group, { label: "Weather", summary: "Clear", onOpen: () => {}, describedBy: "badge-1" }));
    assert.match(opener, /aria-describedby="[^"]+-summary badge-1"/, "an opening group's too");
  });

  test("a fold keeps its two columns: the opening group's chevron column is its own", () => {
    const fold = renderToStaticMarkup(createElement(Group, { label: "Walls and movement", icon: "walls", open: false, onToggle: () => {}, summary: "Walls block moves" }, "x"));
    assert.match(fold, /grid-template-columns:auto minmax\(0, 1fr\);/);
    assert.equal(fold.match(/<svg/g)?.length, 2, "its chevron and its icon, nothing at the end");
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
  test("panel groups 6.2: with onOpen the row is one button holding the name, the help and a trailing chevron, named by its label and described by its help", () => {
    const markup = renderToStaticMarkup(createElement(SettingRow, { name: "Scene sound", help: "Goblin cave's sound: Tavern night.", label: "Scene sound, in Scenes", onOpen: () => {} }));
    const helpId = /<span id="([^"]+)" style="[^"]*">Goblin cave&#x27;s sound: Tavern night.<\/span>/.exec(markup)?.[1];
    assert.ok(helpId, "the help, with its id");
    assert.match(
      markup,
      new RegExp(`^<button type="button" data-setting-row="" aria-label="Scene sound, in Scenes" aria-describedby="${helpId}" style="display:flex;flex-wrap:nowrap;align-items:center;gap:8px 12px;min-height:44px;padding:8px 0;width:100%;margin:0;background:transparent;border:none`),
      "a setting's row, its own box, no card, described by its help (SCN-O-01)",
    );
    assert.equal(markup.match(/<button/g)?.length, 1, "one button, no control inside it");
    assert.doesNotMatch(markup, /<div/, "a button holds spans only");
    assert.match(markup, /<span id="[^"]+" style="[^"]*">Scene sound<\/span><span id="[^"]+" style="[^"]*">Goblin cave/);
    const chevron = /<span style="flex:none;display:flex;color:([^"]+)"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16"/.exec(markup);
    assert.ok(chevron, "a chevron at sm where a control would sit, as an opening group's (SCN-O-11)");
    assert.equal(markup.indexOf("Tavern night") < markup.indexOf("<svg"), true, "after the words");
  });

  test("with onOpen and no label, its name names it and its help describes it, so the help is read once", () => {
    const markup = renderToStaticMarkup(createElement(SettingRow, { name: "Weather", help: "Clear", onOpen: () => {} }));
    assert.doesNotMatch(markup, /aria-label=/);
    const nameId = /<span id="([^"]+)" style="[^"]*">Weather<\/span>/.exec(markup)?.[1];
    const helpId = /<span id="([^"]+)" style="[^"]*">Clear<\/span>/.exec(markup)?.[1];
    assert.ok(nameId && helpId);
    assert.match(markup, new RegExp(`aria-labelledby="${nameId}" aria-describedby="${helpId}"`));
    const bare = renderToStaticMarkup(createElement(SettingRow, { name: "Weather", onOpen: () => {} }));
    assert.doesNotMatch(bare, /aria-describedby/, "no help, no description");
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

describe("Tag", () => {
  test("scenes-reorg 13 (SCN-O-14): an id lands on the tag, so a fold's description resolves to its words, and without one the tag draws as before", () => {
    assert.match(renderToStaticMarkup(createElement(Tag, { id: "no-walls", tone: "warning", children: "No walls" })), /^<span id="no-walls" style="[^"]*">No walls<\/span>$/);
    assert.match(renderToStaticMarkup(createElement(Tag, { tone: "warning", children: "No walls" })), /^<span style="[^"]*">No walls<\/span>$/);
  });
});

/** The first button in an element tree, as Group returns it. */
function findButton(node: unknown): { props: { onClick(e: unknown): void } } | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  const element = node as { type?: unknown; props?: { children?: unknown; onClick?: unknown } };
  if (element.type === "button") return element as never;
  return findButton(element.props?.children);
}
