import { writeFile } from "node:fs/promises";
import { blockDefenses } from "../shared/dice/defenses.ts";
import { loadMonsters } from "../shared/srd/monsters.ts";

// The synchronous HP reducer needs defenses without pulling every monster's full block into the client bundle.
const monsters = await loadMonsters();
const lines = monsters.map((monster) => `${JSON.stringify(monster.srdId)}:${JSON.stringify(blockDefenses(monster))}`);
await writeFile(new URL("../shared/srd/damage-defenses.json", import.meta.url), `{\n${lines.join(",\n")}\n}\n`);
