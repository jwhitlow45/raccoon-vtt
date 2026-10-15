import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Effect } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { P1, actor, room, token } from "#shared/testutil.ts";
import { boardSizes } from "../lib/boardScale.ts";
import { DECOR_MIN_PX, healthState } from "../lib/tokenView.ts";
import { bloodiedNotch, NOTCH_MIN_TOKEN_PX, tokenMarks } from "./tokenMarks.ts";

const measure = (text: string, px: number) => [...text].length * px * 0.6;
const effect = (key: string, extra: Partial<Effect> = {}) => ({ id: key, key, ...extra }) as Effect;

describe("a token's marks", () => {
  test("icon chips shrink to 12 px when zoomed out, chips holding text never below the text floor", () => {
    const sizes = boardSizes(16);
    const icons = tokenMarks({ widthPx: 32, heightPx: 32, effects: [effect("prone")], elevation: 0, hasBar: false, cellPx: 16, sizes, measure });
    assert.equal(icons.chip, 12);
    const counted = tokenMarks({ widthPx: 32, heightPx: 32, effects: [effect("readied", { level: 2 })], elevation: 0, hasBar: false, cellPx: 16, sizes, measure });
    assert.ok(counted.chip >= counted.counterPx + 7);
    assert.ok(counted.counterPx >= 11);
    const many = tokenMarks({ widthPx: 32, heightPx: 32, effects: ["prone", "poisoned", "blinded", "deafened"].map((k) => effect(k)), elevation: 0, hasBar: false, cellPx: 16, sizes, measure });
    assert.ok(many.overflow > 0);
    assert.ok(many.chip >= Math.ceil(many.glyphPx + 6), "the +N chip fits its letters");
  });

  test("the badge text never draws under the floor, and labels start clear of the bar and the chips", () => {
    const sizes = boardSizes(16);
    const m = tokenMarks({ widthPx: 32, heightPx: 32, effects: [effect("prone")], elevation: 30, hasBar: true, cellPx: 16, sizes, measure });
    assert.ok(m.badge && m.badge.textPx >= 11);
    assert.ok(m.bar && m.belowY > m.bar.y1);
    assert.ok(m.aboveY < Math.min(-m.chip / 2, m.badge!.y));
  });
});

describe("the Bloodied notch", () => {
  const width = (n: NonNullable<ReturnType<typeof bloodiedNotch>>) => Math.max(n.points[1]!, n.points[3]!) - Math.min(n.points[1]!, n.points[3]!);

  test("shows below the size where chips and the bar drop, as on a phone fitted to a whole scene, and above it", () => {
    for (const px of [11.4, 13, DECOR_MIN_PX, 34, 90]) {
      const notch = bloodiedNotch("Bloodied", px, px, boardSizes(px).ringPx);
      assert.ok(notch, `a notch on a ${px} px token`);
      assert.ok(width(notch) <= px * 0.5 || width(notch) <= 4, `${width(notch)} px stays in proportion on a ${px} px token`);
      assert.ok(width(notch) >= 4, "never too small to read as a shape");
    }
  });

  test("grows with the token up to a cap, and is left out only where it could not be seen", () => {
    assert.ok(width(bloodiedNotch("Bloodied", 34, 34, 2.5)!) > width(bloodiedNotch("Bloodied", 12, 12, 1.5)!));
    assert.equal(width(bloodiedNotch("Bloodied", 200, 200, 5)!), 16);
    assert.equal(bloodiedNotch("Bloodied", NOTCH_MIN_TOKEN_PX - 1, NOTCH_MIN_TOKEN_PX - 1, 1.5), null);
  });

  test("only for Bloodied, and never on a token whose HP this player may not see, at any size", () => {
    for (const state of ["Healthy", "Dying", "Dead", null] as const) assert.equal(bloodiedNotch(state, 34, 34, 2.5), null);
    const state = room();
    state.tokens.g = token("g", { hpVisibility: "hidden", actor: { inline: actor({ hp: { cur: 2, max: 7, temp: 0 } }) } });
    const t = projectState(state, P1, { sceneId: null }).tokens.g!;
    const seen = healthState({ actor: (t.actor as { inline: Partial<Actor> }).inline, hpVisibility: t.hpVisibility, fullAccess: false });
    for (const px of [11.4, 34]) assert.equal(bloodiedNotch(seen, px, px, 2), null);
  });
});
