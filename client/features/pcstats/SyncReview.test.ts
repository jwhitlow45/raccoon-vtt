import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Character, PcRoll, PcStats } from "#shared/model.ts";
import type { PcFill } from "#shared/rules/pcFill.ts";
import { afterSync, defaultTicks, planSync, syncPatch, syncResult, type SyncPlan } from "#shared/rules/pcSync.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { actor, character } from "#shared/testutil.ts";

/**
 * The review's markup (docs/design-v1-resync.md 3.3 and 3.6): its sections
 * are the only headings, each one able to take focus, a kept row is a group
 * named by its first line, a long list folds into its groups, and a bulk
 * toggle is named by its group.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SyncReview } = await import("./SyncReview.tsx");

const SHEET = "https://www.dndbeyond.com/characters/12345678";
const empty = (): PcStats => structuredClone(EMPTY_PC_STATS) as PcStats;

function fillOf(stats: Partial<PcStats>): PcFill {
  const s = { ...empty(), ...stats };
  return { source: "ddb", stats: { ...s, spellAbility: s.spellAbility ?? null, jack: false, alert: false, evasion: false, critOn: null }, level: 5, name: "Bree", actor: { ac: 15, hpMax: 38, speeds: { walk: 30 }, sheetUrl: SHEET }, warnings: [] };
}

const bree = (stats?: PcStats): Character => character("bree", { name: "Bree", level: 5, ...(stats ? { stats } : {}), actor: actor({ ac: 15, hp: { cur: 38, max: 38, temp: 0 }, speeds: { walk: 30 }, senses: "", sheetUrl: SHEET }) });

function render(c: Character, fill: PcFill, ticks?: Set<string>): { html: string; plan: SyncPlan } {
  const plan = planSync({ mode: "resync", stats: c.stats, level: c.level, character: c, fill });
  const t = ticks ?? defaultTicks(plan);
  const html = renderToStaticMarkup(createElement(SyncReview, { plan, result: syncResult(plan, t), ticks: t, onTick() {}, onBulk() {}, name: "Bree", character: c, labelId: (s: string) => `label-${s}` }));
  return { html, plan };
}

const roll = (i: number): PcRoll => ({ id: `r${i}`, name: i === 0 ? "Longsword" : `Blade ${i}`, kind: "weapon", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6" }] });

describe("the review's markup", () => {
  test("its sections are h3s that take focus, a kept row is a group named by its first line, and Overwrite all is a toggle", () => {
    const c0 = bree();
    const p0 = planSync({ mode: "resync", stats: undefined, level: 5, character: c0, fill: fillOf({ spellAbility: "wis" }) });
    const synced = { ...c0, ...afterSync(c0, syncPatch(c0, syncResult(p0, defaultTicks(p0)))!.patch, "2026-10-20T19:00:00.000Z") } as Character;
    const mine = { ...synced, stats: { ...synced.stats!, spellAbility: "cha" as const } };
    const { html } = render(mine, fillOf({ spellAbility: "wis", abilities: { ...empty().abilities, wis: 18 } }));
    assert.deepEqual([...html.matchAll(/<(h[1-6])\b/g)].map((m) => m[1]), ["h3", "h3"]);
    assert.match(html, /<h3 id="label-changes" tabindex="-1"[^>]*>Changes from D&amp;D Beyond \(1\)<\/h3>/);
    assert.match(html, /<h3 id="label-kept" tabindex="-1"[^>]*>Your changes, kept \(1\)<\/h3>/);
    const group = /<div role="group" aria-labelledby="([^"]+)"/.exec(html);
    assert.ok(group);
    assert.match(html, new RegExp(`<p id="${group[1]}"[^>]*>Spellcasting ability: Charisma</p>`));
    assert.match(html, /aria-pressed="false"[^>]*>Overwrite all/);
    assert.match(html, /Overwrite with Wisdom/);
    assert.match(html, /<p tabindex="-1"[^>]*>Read from D&amp;D Beyond: Bree, level 5\. Last synced on/);
  });

  test("past 10 lines Changes folds into its groups, each a disclosure named by its group and described by its summary", () => {
    const { html } = render(bree(empty()), fillOf({ rolls: Array.from({ length: 40 }, (_, i) => roll(i)) }));
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, />Rolls</);
    assert.match(html, />40: Adds Longsword, and 39 more</);
    assert.doesNotMatch(html, /Adds Blade 3:/, "folded, its lines are not drawn");
  });

  test("with no record, Different groups its rows, each group with Take these named by it, open at 10 rows or fewer", () => {
    const typed = bree({ ...empty(), spellAbility: "cha", abilities: { ...empty().abilities, wis: 12 } });
    const { html } = render(typed, fillOf({ spellAbility: "wis", abilities: { ...empty().abilities, wis: 16 } }));
    assert.match(html, /Bree has no record of a past sync/);
    assert.match(html, /aria-label="Take these: Ability scores"/);
    assert.match(html, /aria-label="Take these: Spellcasting"/);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /Overwrite with 16/);
  });
});
