import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Actor, Effect } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { P1, actor, room, token } from "#shared/testutil.ts";
import { boardSizes } from "../lib/boardScale.ts";
import { DECOR_MIN_PX, healthState } from "../lib/tokenView.ts";
import { bloodiedNotch, NOTCH_MIN_TOKEN_PX, numberBadgeWidth, shieldAc, tokenMarks } from "./tokenMarks.ts";

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

describe("the AC shield and the padlock", () => {
  const marks = (over: { widthPx?: number; heightPx?: number; cellPx?: number; ui?: number; ac?: number | null; lock?: boolean; numberReserve?: number; effects?: Effect[] } = {}) => {
    const cellPx = over.cellPx ?? 40;
    const widthPx = over.widthPx ?? cellPx;
    return tokenMarks({
      widthPx,
      heightPx: over.heightPx ?? widthPx,
      effects: over.effects ?? [],
      elevation: 0,
      hasBar: true,
      cellPx,
      sizes: boardSizes(cellPx, over.ui ?? 1),
      measure,
      ac: over.ac === undefined ? 15 : over.ac,
      lock: over.lock ?? false,
      numberReserve: over.numberReserve ?? 0,
    });
  };
  const inside = (box: { x: number; y: number; width: number; height: number }, w: number, h: number) => box.x >= 0 && box.y >= 0 && box.x + box.width <= w && box.y + box.height <= h;

  test("sits in the bottom left corner inside the footprint, 20 px tall at the pin zoom and 100%, 24 at 130%", () => {
    const at100 = marks().ac!;
    assert.deepEqual([at100.x, at100.y + at100.height, at100.height], [0, 40, 20]);
    assert.ok(inside(at100, 40, 40));
    const at130 = marks({ widthPx: 48, cellPx: 40, ui: 1.3 }).ac!;
    assert.equal(at130.height, 24);
    assert.equal(at130.y + at130.height, 48);
    assert.ok(inside(at130, 48, 48));
    assert.equal(marks({ widthPx: 47, cellPx: 40, ui: 1.3 }).ac, null, "under twice its height at 130%");
  });

  test("widens to its digits, at least 0.85 of its height", () => {
    const nine = marks({ ac: 9 }).ac!;
    const ninetyNine = marks({ ac: 99 }).ac!;
    const hundred = marks({ ac: 100, widthPx: 80 }).ac!;
    assert.equal(nine.width, Math.ceil(nine.height * 0.85));
    assert.ok(ninetyNine.width >= nine.width && hundred.width > ninetyNine.width);
    assert.ok(hundred.width >= measure("100", hundred.textPx) + 8, "the number fits inside");
  });

  test("gives way on a token under twice its height, and beside a number badge that may show", () => {
    assert.equal(marks({ cellPx: 30, widthPx: 30 }).ac, null, "a medium creature at 30 px a cell");
    assert.ok(marks({ cellPx: 30, widthPx: 60 }).ac, "a large one at 30 px a cell");
    const reserve = numberBadgeWidth(4, boardSizes(40).numberPx);
    assert.equal(marks({ numberReserve: reserve }).ac, null, "40 px holds no shield, gap and number badge");
    assert.ok(marks({ widthPx: 80, heightPx: 80, numberReserve: reserve }).ac);
  });

  test("the lock keeps its corner without a shield, stands above it when the token is tall enough, and alone where it is not", () => {
    const sizes = boardSizes(40);
    const alone = marks({ ac: null, lock: true });
    assert.equal(alone.ac, null);
    assert.deepEqual(alone.lock, { x: 0, y: 40 - sizes.chipPx, size: sizes.chipPx });
    const large = marks({ widthPx: 80, lock: true });
    assert.ok(large.ac && large.lock);
    assert.ok(large.lock.y + large.lock.size < large.ac.y, "above the shield");
    assert.ok(large.lock.y >= large.chip / 2, "under the chip row");
    assert.equal(large.lock.x, 0);
    const tall = marks({ widthPx: 51, heightPx: 51, lock: true });
    assert.ok(tall.ac && tall.lock, "51 px at the pin zoom is tall enough");
    const medium = marks({ lock: true });
    assert.equal(medium.ac, null, "a locked medium creature at the pin zoom keeps its lock");
    assert.deepEqual(medium.lock, { x: 0, y: 40 - sizes.chipPx, size: sizes.chipPx });
    assert.equal(marks().lock, null, "no lock unless it shows");
  });

  test("neither changes the boxes labels keep off", () => {
    const plain = marks({ ac: null, lock: false, effects: [effect("prone")], widthPx: 80 });
    const both = marks({ ac: 15, lock: true, effects: [effect("prone")], widthPx: 80 });
    assert.ok(both.ac && both.lock);
    assert.deepEqual(both.boxes, plain.boxes);
    assert.equal(both.belowY, plain.belowY);
  });

  test("shows only a living or dying creature's AC of 1 to 100 that has HP to show", () => {
    const creature = { kind: "monster" as const };
    assert.equal(shieldAc(creature, actor({ ac: 15 })), 15);
    for (const ac of [9, 99, 100]) assert.equal(shieldAc({ kind: "pc" }, actor({ ac })), ac);
    assert.equal(shieldAc({ kind: "npc" }, actor({ ac: 12, life: "dying" })), 12);
    assert.equal(shieldAc({ kind: "object" }, actor({ ac: 15 })), null, "an object");
    assert.equal(shieldAc(creature, actor({ ac: 15, life: "dead" })), null, "a dead creature");
    assert.equal(shieldAc(creature, actor({ ac: 0 })), null, "AC 0");
    assert.equal(shieldAc(creature, { hp: { cur: 5, max: 5, temp: 0 } }), null, "no ac in this viewer's copy");
    assert.equal(shieldAc(creature, undefined), null);
    assert.equal(shieldAc(creature, actor({ ac: 15, hp: { cur: 0, max: 0, temp: 0 } })), null, "max HP 0");
    assert.equal(shieldAc({ kind: "object", companion: { of: "c1", turn: "none" } }, actor({ ac: 13 })), null, "an effect companion");
    assert.equal(shieldAc(creature, { ac: 15, life: "alive" }), 15, "HP this viewer may not see is not 0");
  });
});
