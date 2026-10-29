import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { theme } from "../../lib/theme.ts";
import { damageSummary } from "./damageSummaryLines.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DamageSummary } = await import("./DamageSummary.tsx");
const text = (markup: string) => markup.replace(/<[^>]*>/g, "");
const draw = (summary: ReturnType<typeof damageSummary>) => renderToStaticMarkup(createElement(DamageSummary, { summary }));

test("FL-4 design: damage uses a raised outlined slip, a danger stripe and shared number columns", () => {
  const markup = draw(damageSummary([{ amount: 28, type: "fire" }, { amount: 100, type: "piercing" }], { result: { amount: 114, byPart: [14, 100], notes: [] } }));
  for (const style of [
    `border-left:${theme.line.stripe}px solid ${theme.color.danger}`, `background:${theme.color.surfaceRaised}`,
    `border:${theme.line.border}px solid ${theme.color.border}`, `border-radius:${theme.radius.sm}px`,
    `padding:${theme.space(2)}px`, `gap:${theme.space(1)}px`, "width:100%", "box-sizing:border-box",
  ]) assert.ok(markup.includes(style), style);
  assert.match(markup, /grid-template-columns:1ch 1em max-content minmax\(0, 1fr\)/);
  assert.match(markup, /data-damage-result=""[^>]*font-weight:600[^>]*>14<\/span>/);
  assert.match(markup, /data-damage-amount=""[^>]*text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums/);
  assert.match(markup, /data-damage-total-rule=""[^>]*grid-column:3 \/ -1;border-top:1px solid/);
  assert.match(markup, /data-damage-result=""[^>]*font-weight:700[^>]*>114<\/span>/);
  assert.match(markup, /data-damage-text=""[^>]*min-width:0;overflow-wrap:anywhere/);
  assert.match(text(markup), /= 114 damage/);
});

test("FL-4: decorative text-colored icons center beside words with a fixed plus gutter", () => {
  const markup = draw(damageSummary([{ amount: 28, type: "fire" }, { amount: 10 }], { result: { amount: 24, byPart: [14, 10], notes: [] } }));
  assert.equal((markup.match(/data-damage-icon=/g) ?? []).length, 2);
  assert.match(markup, /aria-hidden="true"[^>]*data-damage-icon="fire"/);
  assert.match(markup, /mask-image:url\(\/icons\/damage\/untyped.svg\)/);
  assert.match(markup, /width:1em;height:1em/);
  assert.match(markup, /background:currentColor/);
  assert.match(markup, /grid-template-columns:[^;]+;align-items:center/);
  assert.match(markup, /data-damage-gutter=""[^>]*width:1ch/);
  assert.match(markup, /<s aria-hidden="true"[^>]*>28<\/s>/);
  assert.ok(markup.includes(`<s aria-hidden="true" style="color:${theme.color.textMuted}">`));
  assert.match(text(markup), /was 28, now 14 Fire damage/);
  assert.match(text(markup), /= 24 damage/);
});

test("FL-4 design: defenses have their own rule, muted labels, icons and qualifiers", () => {
  const markup = draw({ ...damageSummary([{ amount: 7 }]), defenses: [
    { label: "Resists", entries: [{ icon: "fire", text: "Fire", qualifier: "from Spells" }, { icon: "cold", text: "Cold" }] },
    { label: "Saved", entries: [{ text: "half" }] },
  ] });
  assert.match(markup, /data-damage-defenses=""[^>]*border-top:1px solid/);
  assert.ok(markup.includes(`style="color:${theme.color.textMuted};font-weight:${theme.weight.strong}">Resists: </span>`));
  assert.equal((markup.match(/data-damage-defense-entry=/g) ?? []).length, 2);
  assert.equal((markup.match(/data-damage-icon=/g) ?? []).length, 3);
  for (const icon of ["fire", "cold"]) assert.ok(markup.includes(`data-damage-icon="${icon}"`));
  assert.match(markup, /data-damage-defense-entry=""[^>]*display:inline-flex;align-items:center/);
  assert.match(text(markup), /Resists: Fire from Spells, Cold/);
  assert.match(text(markup), /Saved: half/);
  assert.doesNotMatch(markup, /<s /);
});

test("FL-4 design: target summaries stay short and escape supplied names", () => {
  const markup = draw({ ...damageSummary([{ amount: 7 }]), targets: [{ name: "<Guard>", amount: 3, defenses: [{ label: "Resists", entries: [{ icon: "fire", text: "Fire" }] }] }] });
  assert.match(text(markup), /&lt;Guard&gt;: Resists Fire, 3/);
  assert.equal((markup.match(/data-damage-target=/g) ?? []).length, 1);
  assert.equal((markup.match(/data-damage-part=/g) ?? []).length, 1);
});

test("FL-4 design: healing, temporary HP and set previews use the same slip with their own tone", () => {
  for (const [kind, words, color] of [["heal", "Heal 5", theme.color.success], ["temp", "Set Temporary HP to 5", theme.color.textMuted], ["set", "Set HP to 20", theme.color.textMuted]] as const) {
    const markup = renderToStaticMarkup(createElement(DamageSummary, { change: { kind, text: words }, suffix: ", to each of 2" }));
    assert.ok(markup.includes(`data-hp-preview="${kind}"`));
    assert.ok(markup.includes(`border-left:${theme.line.stripe}px solid ${color}`));
    assert.ok(markup.includes(`background:${theme.color.surfaceRaised}`));
    assert.equal(text(markup), `${words}, to each of 2`);
    assert.doesNotMatch(markup, /data-damage-defenses|data-damage-part=/);
  }
});
