// New picture candidates ddb-resources.webp (guide pass 2): Kael, an invented level 5 barbarian with a D&D Beyond
// sheet link, filled from D&D Beyond in the DM's editor, so "Check what was read" lists his Rage as a class resource.
// Then he spends a Rage in the room, levels up in D&D Beyond (Rage 4), and the re-sync review lists the change and the
// unticked spent line. D&D Beyond is never asked: the page's import route answers with the invented sheets, read by the
// app's own reader, as e2e/resync.e2e.ts does. Kael is deleted at the end.
import { uuidv7 as randomUUID } from "../../shared/ids.ts";
import { readDdbCharacter } from "../../shared/ddb/read.ts";
const NUMBER = "23456789";
const RAGE_ID = 6001;
function kael(level: number, rages: number, used: number) {
  return {
    success: true,
    data: {
      id: Number(NUMBER),
      name: "Kael",
      stats: [17, 14, 16, 8, 12, 10].map((value, i) => ({ id: i + 1, value })),
      bonusStats: [],
      overrideStats: [],
      baseHitPoints: level === 5 ? 50 : 60,
      race: { weightSpeeds: { normal: { walk: 30 } } },
      classes: [{ level, definition: { name: "Barbarian" }, classFeatures: [{ definition: { id: RAGE_ID, name: "Rage", requiredLevel: 1 } }] }],
      modifiers: { race: [], class: [], background: [], feat: [], item: [], condition: [] },
      inventory: [{ equipped: true, definition: { id: 201, name: "Greataxe", filterType: "Weapon", damage: { diceString: "1d12" }, damageType: "Slashing", attackType: 1, properties: [] } }],
      classSpells: [],
      spells: { race: [], class: [], item: [], feat: [] },
      actions: {
        race: [],
        class: [{ name: "Rage", componentTypeId: 12168134, componentId: RAGE_ID, limitedUse: { name: null, statModifierUsesId: null, resetType: 2, numberUsed: used, minNumberConsumed: 1, maxNumberConsumed: 1, maxUses: rages, operator: 1, useProficiencyBonus: false, proficiencyBonusOperator: 1, resetDice: null } }],
        feat: [],
      },
    },
  };
}
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const panel = dm.locator('[role="tabpanel"]').first();
  const answers: unknown[] = [kael(5, 3, 0), kael(6, 4, 0)];
  await dm.route("**/api/rooms/*/ddb-import", async (route: any) => {
    const next = answers.shift();
    if (!next) return route.fulfill({ status: 502, json: { error: "fetch_failed" } });
    return route.fulfill({ status: 200, json: { fill: readDdbCharacter(next as any) } });
  });
  // The lair fight of s141 and s142 ends first, so no turn card stands behind the dialogs.
  await c.harness.openSideTab(dm, "Initiative");
  const end = panel.getByRole("button", { name: "End the fight" });
  if (await end.count()) {
    await end.click();
    await panel.getByRole("button", { name: /Tap again/ }).first().click();
    await dm.waitForTimeout(800);
  }
  const id = randomUUID();
  const out: Record<string, unknown> = {};
  try {
    const actor = { hp: { cur: 50, max: 50, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 11, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
    await ops.send({ t: "character.create", character: { id, name: "Kael", size: "medium", ownerIds: [c.state.patId], defaultImage: { icon: "delapouite/barbarian", color: "#9a3412" }, actor, level: 5 } });
    await ops.send({ t: "character.update", characterId: id, patch: { actor: { sheetUrl: `https://www.dndbeyond.com/characters/${NUMBER}` } } });
    await dm.waitForTimeout(800);
    const { charactersList } = await import(`./lib.ts?t=${Date.now()}`);
    await charactersList(c, dm);
    await panel.getByText("Kael", { exact: true }).first().click();
    await dm.waitForTimeout(800);
    await panel.getByRole("button", { name: "Add a stat block" }).first().click();
    const editor = dm.getByRole("dialog", { name: "Kael's stat block" });
    await editor.waitFor();
    await editor.getByRole("button", { name: "D&D Beyond" }).click();
    const step = dm.getByRole("dialog", { name: "D&D Beyond" });
    await step.getByRole("button", { name: "Get it", exact: true }).click();
    const read = dm.getByRole("dialog", { name: "Import review" });
    await read.waitFor();
    await dm.waitForTimeout(600);
    await dm.mouse.move(5, 790);
    await c.shot(dm, "rs-read-resources");
    out.read = (await read.innerText()).slice(0, 1500);
    await read.getByRole("button", { name: "Use it", exact: true }).click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await dm.waitForTimeout(800);
    // A Rage spent in the room, then the level-up's re-sync.
    await panel.getByRole("button", { name: /^Use one Rage|^Use Rage/ }).first().click().catch(() => {});
    await dm.waitForTimeout(800);
    const resync = panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true });
    await resync.scrollIntoViewIfNeeded();
    await resync.click();
    const review = dm.getByRole("dialog", { name: /^(Re-sync review|Check what changes)/ });
    await review.waitFor();
    await dm.waitForTimeout(800);
    await dm.mouse.move(5, 790);
    await c.shot(dm, "rs-review-resources");
    out.review = (await review.innerText()).slice(0, 1500);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await dm.waitForTimeout(500);
  } finally {
    await dm.unroute("**/api/rooms/*/ddb-import").catch(() => {});
    await ops.send({ t: "character.delete", characterId: id }).catch(() => {});
  }
  return out;
};
