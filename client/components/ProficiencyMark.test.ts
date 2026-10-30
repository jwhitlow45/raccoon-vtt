import "./testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { markedBy, MarkedText, ProficiencyLabel, ProficiencyUnit, proficiencyBox, proficiencyFrame, spokenProficiency, spokenText } = await import("./ProficiencyMark.tsx");

/* The mark is a border around the roll it names (D-261030-527). */

const FRAME = "text-box:trim-both cap alphabetic;padding:0.05em 0 0.214em;border-radius:3px;box-shadow:0 0 0 1px currentColor;box-decoration-break:clone;-webkit-box-decoration-break:clone";
const MARK = { prof: FRAME, expert: `${FRAME};background-color:color-mix(in srgb, currentColor 16%, transparent)` };

test("fl12: a name frames itself with one line, tinted inside for expertise, in its own color, and is named after its words", () => {
  for (const [level, word] of [["prof", "Proficient"], ["expert", "Expertise"]] as const) {
    const html = renderToStaticMarkup(createElement(ProficiencyLabel, { level, children: "Sleight of Hand" }));
    assert.equal(html, `<span data-proficiency-label="" data-proficiency-level="${level}" title="${word}" data-proficiency-mark="${level}" data-proficiency-form="unit" style="${MARK[level]}">Sleight of Hand<span data-proficiency-marker="${level}" role="img" aria-label="${word}" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap"></span></span>`);
    assert.doesNotMatch(html, /[^-]color:(?!currentColor)|outline/, "no color of its own and nothing like a focus ring");
  }
});

test("fl12: a bare name leaves its frame to the box around it", () => {
  assert.equal(renderToStaticMarkup(createElement(ProficiencyLabel, { level: "prof", bare: true, children: "DEX" })), '<span data-proficiency-label="" data-proficiency-level="prof" title="Proficient">DEX<span data-proficiency-marker="prof" role="img" aria-label="Proficient" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap"></span></span>');
  assert.equal(renderToStaticMarkup(createElement(ProficiencyUnit, { level: "none", children: "DEX +5" })), "DEX +5", "a roll with no level draws nothing");
});

test("fl12: a button keeps its box, only its border's color and inner lines change, never the accent", () => {
  assert.deepEqual(proficiencyBox("prof", "#2a2a32"), { borderColor: "currentColor", boxShadow: "inset 0 0 0 1px currentColor" });
  assert.deepEqual(proficiencyBox("expert", "#2a2a32"), { borderColor: "currentColor", boxShadow: "inset 0 0 0 2px #2a2a32, inset 0 0 0 3px currentColor" });
  assert.deepEqual(proficiencyBox("none", "#2a2a32"), {});
  assert.deepEqual(proficiencyBox(undefined, "#2a2a32"), {});
  for (const level of ["prof", "expert"] as const) {
    const look = proficiencyBox(level, "#2a2a32");
    assert.ok(!("borderWidth" in look) && !("padding" in look) && !("outline" in look), "no size, padding or focus ring");
  }
});

test("fl12: a box that cuts its words frames them from inside", () => {
  assert.deepEqual(proficiencyFrame("prof"), { padding: "3px 4px", borderRadius: 6, boxShadow: "inset 0 0 0 1px currentColor" });
  assert.deepEqual(proficiencyFrame("expert"), { padding: "3px 4px", borderRadius: 6, boxShadow: "inset 0 0 0 1px currentColor", outline: "1px solid currentColor", outlineOffset: -3 });
  assert.deepEqual(proficiencyFrame("none"), {});
  assert.deepEqual(markedBy("expert", "frame"), { "data-proficiency-mark": "expert", "data-proficiency-form": "frame" });
  assert.deepEqual(markedBy("none", "box"), {});
});

/** The words inside the first box that draws a mark in `html`. */
function framedWords(html: string): string {
  const open = /<span [^>]*data-proficiency-mark="\w+"[^>]*>/.exec(html);
  assert.ok(open, html);
  let depth = 1;
  const tags = /<span[\s>]|<\/span>/g;
  tags.lastIndex = open.index + open[0].length;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0] === "</span>" ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, tag.index).replace(/<[^>]*>/g, "");
  }
  throw new Error(`no end to the frame in ${html}`);
}

test("fl12: marked text frames a name with the rest of its word, its bonus and the punctuation after it", () => {
  for (const [text, at, length, framed] of [
    ["Skills Perception +5, Stealth +2", 7, 10, "Perception +5,"],
    ["Pat rolled 2 Perception checks.", 13, 16, "Perception checks."],
    ["for Thorn, Perception check: 1d20+8", 11, 16, "Perception check:"],
    ["on a Wisdom (Perception) check", 5, 19, "Wisdom (Perception)"],
  ] as const) {
    const html = renderToStaticMarkup(createElement(MarkedText, { text, marks: [{ at, length, level: "prof" as const }] }));
    assert.equal(html.replace(/<[^>]*>/g, ""), text, "the words are unchanged");
    assert.equal(framedWords(html), framed, `"${text}" frames "${framed}"`);
  }
  assert.equal(spokenText("Pat rolled 2 Perception checks.", [{ at: 13, length: 16, level: "expert" }]), "Pat rolled 2 Perception checks, expertise.", "the spoken level follows the whole word");
});

test("fl12: a bonus written any way a stat block may write it joins its frame, with the punctuation after it (FL12-SOL-01)", () => {
  for (const [text, framed] of [
    ["Skills Perception+6, Stealth +2", "Perception+6,"],
    ["Skills Perception + 6, Stealth +2", "Perception + 6,"],
    ["Skills Perception  +6, Stealth +2", "Perception  +6,"],
    ["Skills Perception –1, Stealth +2", "Perception –1,"],
    ["Skills Perception −1; Stealth +2", "Perception −1;"],
    ["Skills Perception - 1.", "Perception - 1."],
  ] as const) {
    const html = renderToStaticMarkup(createElement(MarkedText, { text, marks: [{ at: 7, length: 10, level: "prof" as const }] }));
    assert.equal(html.replace(/<[^>]*>/g, ""), text, "the words are unchanged");
    assert.equal(framedWords(html), framed, `"${text}" frames "${framed}"`);
  }
  // A bonus on the next line is not the name's: a frame never reaches across a line break.
  const html = renderToStaticMarkup(createElement(MarkedText, { text: "Skills Perception\n+6", marks: [{ at: 7, length: 10, level: "prof" as const }] }));
  assert.equal(framedWords(html), "Perception");
});

test("fl7: neither keeps a bare span with no mark, no tooltip and no name", () => {
  assert.equal(renderToStaticMarkup(createElement(ProficiencyLabel, { level: "none", children: "Perception" })), '<span data-proficiency-label="" data-proficiency-level="none">Perception</span>');
});

test("fl7: marked text keeps its words, and its spoken form names each level after its test", () => {
  const text = "Pat rolled 19 for Thorn, Perception check.";
  const marks = [{ at: 25, length: 16, level: "expert" as const }];
  assert.equal(renderToStaticMarkup(createElement(MarkedText, { text, marks })).replace(/<[^>]*>/g, ""), text);
  assert.equal(spokenText(text, marks), "Pat rolled 19 for Thorn, Perception check, expertise.");
  assert.equal(spokenText(text, [{ at: 25, length: 10, level: "none" }]), text);
  assert.deepEqual([spokenProficiency("prof"), spokenProficiency("expert"), spokenProficiency("none")], [", proficient", ", expertise", ""]);
});
