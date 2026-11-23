// Re-sync: Wren, a level 5 druid Pat plays, typed in by the DM as a Charisma caster with a D&D Beyond sheet link (an
// invented number). The DM's editor fills her from D&D Beyond, keeping Charisma, then after a level-up the DM's
// Re-sync reviews it: Wisdom 18 and Moonbeam come in, Level 6 and Max HP 45 are ticked, and Charisma is kept with
// Overwrite. D&D Beyond is never asked: the DM page's import route answers with invented characters read by the app's
// own reader, as e2e/resync.e2e.ts does.
import { uuidv7 as randomUUID } from "../../shared/ids.ts";
import { readDdbCharacter } from "../../shared/ddb/read.ts";
const NUMBER = "12345678";
const proficiency = (subType: string) => ({ type: "proficiency", subType, fixedValue: null, value: null });
const shortbow = { equipped: true, definition: { id: 101, name: "Shortbow", filterType: "Weapon", damage: { diceString: "1d6" }, damageType: "Piercing", attackType: 2, properties: [] } };
const cantrip = (name: string, dice: string, type: string) => ({ prepared: true, definition: { name, level: 0, requiresAttackRoll: true, modifiers: [{ type: "damage", subType: type, die: { diceString: dice }, usePrimaryStat: true }] } });
const moonbeam = { prepared: true, definition: { name: "Moonbeam", level: 2, requiresSavingThrow: true, saveDcAbilityId: 3, modifiers: [{ type: "damage", subType: "radiant", die: { diceString: "2d10" } }] } };
function wren(o: { level?: number; scores?: number[]; baseHp?: number; spells?: unknown[] } = {}) {
  return {
    success: true,
    data: {
      id: Number(NUMBER),
      name: "Wren Ashdown",
      stats: (o.scores ?? [10, 14, 14, 12, 16, 8]).map((value, i) => ({ id: i + 1, value })),
      bonusStats: [],
      overrideStats: [],
      baseHitPoints: o.baseHp ?? 28,
      race: { weightSpeeds: { normal: { walk: 30 } } },
      classes: [{ level: o.level ?? 5, definition: { name: "Druid", spellCastingAbilityId: 5 }, classFeatures: [] }],
      modifiers: { race: [], class: ["intelligence", "wisdom"].map((a) => proficiency(`${a}-saving-throws`)), background: ["nature", "perception"].map(proficiency), feat: [], item: [], condition: [] },
      inventory: [shortbow],
      classSpells: [{ spells: o.spells ?? [cantrip("Shillelagh", "1d8", "bludgeoning")] }],
      spells: { race: [], class: [], item: [], feat: [] },
      actions: { race: [], class: [], feat: [] },
    },
  };
}
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const answers: unknown[] = [wren(), wren({ level: 6, scores: [10, 14, 14, 12, 18, 8], baseHp: 33, spells: [cantrip("Shillelagh", "1d10", "bludgeoning"), moonbeam] })];
  const asked: string[] = [];
  await dm.route("**/api/rooms/*/ddb-import", async (route: any) => {
    const next = answers.shift();
    asked.push(String((route.request().postDataJSON() ?? {}).link));
    if (!next) return route.fulfill({ status: 502, json: { error: "fetch_failed" } });
    return route.fulfill({ status: 200, json: { fill: readDdbCharacter(next as any, () => randomUUID()) } });
  });
  const id = randomUUID();
  c.state.wren = id;
  const actor = { hp: { cur: 30, max: 38, temp: 0 }, life: "alive", ac: 15, speeds: { walk: 30 }, initBonus: 2, passivePerception: 15, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
  const stats = {
    abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 16, cha: 8 },
    saves: ["int", "wis"],
    skills: { nature: "prof", perception: "prof" },
    spellAbility: "cha",
    adjust: {},
    defenses: {},
    rolls: [
      { id: "typed-shortbow", name: "Shortbow", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6", mod: true, type: "piercing" }] },
      { id: "typed-shillelagh", name: "Shillelagh", kind: "spell", ability: "spell", level: 0, attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", mod: true, type: "bludgeoning" }] },
    ],
  };
  await ops.send({ t: "character.create", character: { id, name: "Wren", size: "medium", ownerIds: [c.state.patId], defaultImage: { icon: "delapouite/woman-elf-face", color: "#15803d" }, actor } });
  await ops.send({ t: "character.update", characterId: id, patch: { stats, level: 5, actor: { sheetUrl: `https://www.dndbeyond.com/characters/${NUMBER}` } } });
  await dm.waitForTimeout(800);
  const { charactersList } = await import(`./lib.ts?t=${Date.now()}`);
  await charactersList(c, dm);
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByText("Wren", { exact: true }).first().click();
  await dm.waitForTimeout(800);
  const sb = panel.getByRole("button", { name: /^Stat block/ }).first();
  if ((await sb.getAttribute("aria-expanded")) === "false") await sb.click();
  await dm.waitForTimeout(500);
  // The first sync, in the editor: Charisma kept.
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = dm.getByRole("dialog", { name: "Wren's stat block" });
  await editor.waitFor();
  await editor.getByRole("button", { name: "D&D Beyond" }).click();
  const step = dm.getByRole("dialog", { name: "D&D Beyond" });
  await step.getByRole("button", { name: "Get it", exact: true }).click();
  const read = dm.getByRole("dialog", { name: "Import review" });
  await read.waitFor();
  await read.getByRole("checkbox", { name: "Keep mine", exact: true }).first().check();
  const ac = read.getByRole("checkbox", { name: /^AC \d+, now 15/ });
  if (await ac.count()) await ac.uncheck();
  await read.getByRole("button", { name: "Use it", exact: true }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await dm.waitForTimeout(800);
  // The re-sync, after a level-up.
  const resync = panel.getByRole("button", { name: "Re-sync from D&D Beyond", exact: true });
  await resync.scrollIntoViewIfNeeded();
  await resync.click();
  const review = dm.getByRole("dialog", { name: /^(Re-sync review|Check what changes)/ });
  await review.waitFor();
  await dm.waitForTimeout(800);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "rs-review");
  return { asked, review: await review.innerText() };
};
