// Known forms: Wren, a level 5 druid played by Sam, with six Beast forms she knows. Her page's Stat block shows them as
// buttons, and Take a shape lists them first at Druid level 5. She is made only for this picture and deleted after it.
import { uuidv7 as randomUUID } from "../../shared/ids.ts";
export default async (c: any) => {
  const dm = c.state.dm;
  const ops = c.state.ops;
  const id = randomUUID();
  const actor = { hp: { cur: 38, max: 38, temp: 0 }, life: "alive", ac: 14, speeds: { walk: 30 }, initBonus: 2, passivePerception: 16, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
  const stats = {
    abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 17, cha: 8 },
    saves: ["int", "wis"],
    skills: { nature: "prof", perception: "prof", survival: "prof" },
    spellAbility: "wis",
    adjust: {},
    defenses: {},
    rolls: [{ id: "r-produce-flame", name: "Produce Flame", kind: "spell", ability: "spell", level: 0, attack: { prof: true, bonus: 0 }, dice: [{ formula: "2d8", type: "fire" }] }],
  };
  await ops.send({ t: "character.create", character: { id, name: "Wren", size: "medium", ownerIds: [c.state.samId], defaultImage: { icon: "delapouite/woman-elf-face", color: "#15803d" }, actor, level: 5, stats } });
  await ops.send({ t: "character.update", characterId: id, patch: { knownForms: ["wolf", "black-bear", "panther", "giant-badger", "ape", "crocodile"] } });
  await dm.waitForTimeout(600);
  const { charactersList, panelScroll } = await import(`./lib.ts?t=${Date.now()}`);
  await charactersList(c, dm);
  const panel = dm.locator('[role="tabpanel"]').first();
  await panel.getByText("Wren", { exact: true }).first().click();
  await dm.waitForTimeout(800);
  const sb = panel.getByRole("button", { name: /^Stat block/ }).first();
  if ((await sb.getAttribute("aria-expanded")) === "false") await sb.click();
  await dm.waitForTimeout(800);
  await panelScroll(dm, null);
  await panel.getByRole("button", { name: "Take a shape" }).click();
  await dm.waitForTimeout(1200);
  const dlg = dm.getByRole("dialog").last();
  const level = dlg.locator("select").first();
  if ((await level.inputValue()) !== "5") await level.selectOption("5");
  await dm.waitForTimeout(400);
  await dm.mouse.move(5, 790);
  await c.shot(dm, "final-known-forms");
  const text = (await dlg.innerText()).slice(0, 700);
  await dm.keyboard.press("Escape");
  await dm.waitForTimeout(400);
  await ops.send({ t: "character.delete", characterId: id });
  await dm.waitForTimeout(600);
  return text;
};
