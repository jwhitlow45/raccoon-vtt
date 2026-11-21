import { uuidv7 as randomUUID } from "../../shared/ids.ts";
export default async (c: any) => {
  const { OpSocket } = c.harness;
  c.state.ops ??= await OpSocket.open({ origin: c.origin, roomId: c.state.roomId, cookie: c.state.cookie });
  const ops = c.state.ops;
  const pat = c.state.patId;
  const sam = c.state.samId;
  const actor = (hp: number, ac: number, pp: number, senses = "", speed = 30) => ({
    hp: { cur: hp, max: hp, temp: 0 },
    life: "alive",
    ac,
    speeds: { walk: speed },
    initBonus: 0,
    passivePerception: pp,
    senses,
    effects: [],
    deathSaves: { ok: 0, fail: 0 },
    notes: "",
    dmNotes: "",
  });
  const chars = [
    {
      key: "thorn", name: "Thorn", owners: [pat], icon: "kier-heyl/dwarf-helmet", color: "#1d4ed8", actor: actor(52, 18, 13, "Darkvision 60 ft", 25),
      stats: {
        abilities: { str: 17, dex: 10, con: 16, int: 8, wis: 12, cha: 10 },
        saves: ["str", "con"],
        skills: { athletics: "prof", perception: "prof", intimidation: "prof" },
        adjust: {},
        defenses: {},
        rolls: [
          { id: "r-axe", name: "Battleaxe", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d10", type: "slashing", mod: true }] },
          { id: "r-handaxe", name: "Handaxe", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6", type: "slashing", mod: true }] },
        ],
      },
    },
    {
      key: "bree", name: "Bree", owners: [sam], icon: "delapouite/sun-priest", color: "#b45309", actor: actor(38, 18, 15, "", 30),
      stats: {
        abilities: { str: 12, dex: 10, con: 14, int: 10, wis: 17, cha: 13 },
        saves: ["wis", "cha"],
        skills: { insight: "prof", medicine: "prof", religion: "prof" },
        spellAbility: "wis",
        adjust: {},
        defenses: {},
        rolls: [
          { id: "r-mace", name: "Mace", kind: "weapon", ability: "str", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d6", type: "bludgeoning", mod: true }] },
          { id: "r-guardians", name: "Spirit Guardians", kind: "spell", ability: "spell", level: 3, save: { ability: "wis" }, dice: [{ formula: "3d8", type: "radiant", upcast: "1d8" }] },
          { id: "r-cure", name: "Cure Wounds", kind: "spell", ability: "spell", level: 1, dice: [{ formula: "2d8", type: "healing", mod: true, upcast: "2d8" }] },
        ],
      },
    },
    {
      key: "mara", name: "Mara", owners: [pat], icon: "darkzaitzev/hooded-figure", color: "#6d28d9", actor: actor(33, 15, 15, "", 30),
      stats: {
        abilities: { str: 8, dex: 18, con: 12, int: 13, wis: 12, cha: 14 },
        saves: ["dex", "int"],
        skills: { stealth: "expert", perception: "prof", acrobatics: "prof", "sleight-of-hand": "expert" },
        evasion: true,
        adjust: {},
        defenses: {},
        rolls: [
          { id: "r-rapier", name: "Rapier", kind: "weapon", ability: "dex", attack: { prof: true, bonus: 0 }, dice: [{ formula: "1d8", type: "piercing", mod: true }, { formula: "3d6", type: "piercing", optional: true, name: "Sneak Attack" }] },
        ],
      },
    },
    {
      key: "ivo", name: "Ivo", owners: [sam], icon: "delapouite/wizard-face", color: "#0f766e", actor: actor(27, 12, 11, "", 30),
      stats: {
        abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 },
        saves: ["int", "wis"],
        skills: { arcana: "prof", history: "prof", investigation: "prof" },
        spellAbility: "int",
        adjust: {},
        defenses: {},
        rolls: [
          { id: "r-firebolt", name: "Fire Bolt", kind: "spell", ability: "spell", level: 0, attack: { prof: true, bonus: 0 }, dice: [{ formula: "2d10", type: "fire" }] },
          { id: "r-fireball", name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] },
        ],
      },
    },
  ];
  const ids: Record<string, string> = {};
  for (const ch of chars) {
    const id = randomUUID();
    ids[ch.key] = id;
    await ops.send({
      t: "character.create",
      character: { id, name: ch.name, size: "medium", ownerIds: ch.owners, defaultImage: { icon: ch.icon, color: ch.color }, actor: ch.actor, level: 5, stats: ch.stats },
    });
  }
  c.state.chars = ids;
  c.state.pat = c.state.pat;
  c.state.patId = pat;
  c.state.samId = sam;
  return ids;
};
