/**
 * The DM guide's pictures of spell slots and Hit Point Dice (docs/dm-guide.md,
 * "Classes, spell slots and Hit Point Dice" and "Rests",
 * docs/design/design-v1-slots.md), on a phone held upright, taken from the
 * real server on the production build so they always show the app as it is:
 * - spell-slots-turn.webp: Bree's turn card with the folded Spell slots row
 *   and Use a slot… open.
 * - short-rest-dice.webp: her Short Rest card after one d6 rolled.
 *
 * It needs `pnpm build` first and a Postgres in DATABASE_URL. It makes a
 * room, writes both pictures at 390 x 844, as the guide's other phone
 * pictures are, and deletes the room:
 *
 *   DATABASE_URL=postgres://... GUIDE_PORT=3198 node scripts/guide-slots.ts
 */
import { uuidv7 as randomUUID } from "../shared/ids.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import sharp from "sharp";
import { OpSocket, ROOT, SocketWatch, startServer, waitFor } from "../e2e/harness.ts";

const PORT = Number(process.env.GUIDE_PORT ?? 3198);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://raccoon:raccoon@localhost:5434/raccoon";
const OUT = path.join(ROOT, "docs", "dm-guide");
const PHONE = { width: 390, height: 844 };

function actor(hp: number) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" };
}

/** The page as the guide shows it, at the quality its other pictures use. */
async function picture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(800);
  const png = await page.screenshot();
  const info = await sharp(png).webp({ quality: 78, effort: 6 }).toFile(path.join(OUT, `${name}.webp`));
  console.log(`${name}.webp ${info.width} x ${info.height}, ${Math.round(info.size / 1024)} KB`);
}

function section(scope: Locator, title: string): Locator {
  return scope.locator(`xpath=.//section[*[self::h3 or self::h4][normalize-space()="${title}"]]`);
}

const work = mkdtempSync(path.join(tmpdir(), "raccoon-guide-slots-"));
const server = await startServer({ port: PORT, assetDir: path.join(work, "assets"), databaseUrl: DATABASE_URL });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const roomName = "Guide examples";
let roomId = "";
let ops: OpSocket | null = null;
const dmContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const kimContext = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true });
try {
  const origin = server.origin;
  const dm = await dmContext.newPage();
  const dmSocket = new SocketWatch("dm");
  await dmSocket.attach(dmContext, dm);
  await dm.goto(`${origin}/`);
  await dm.getByLabel("Room name").fill(roomName);
  await dm.getByLabel("Your name").fill("Dana the DM");
  const password = await dm.getByLabel("Player password").inputValue();
  await dm.getByRole("button", { name: "Create room" }).click();
  await dm.getByRole("heading", { name: "Save your DM link" }).waitFor();
  const link = (await dm.locator("code").first().textContent()) ?? "";
  roomId = /\/r\/([0-9A-Z]{4}-[0-9A-Z]{4})#dm=/.exec(link)![1]!.replace("-", "");
  await dm.getByLabel("I saved my DM link").check();
  await dm.getByRole("button", { name: "Continue to the room" }).click();
  await waitFor("the DM's snapshot", () => dmSocket.state);
  const sceneId = dmSocket.state!.meta.playerSceneId!;

  const headers = { Origin: origin, "content-type": "application/json" };
  const joined = await kimContext.request.post(`${origin}/api/rooms/${roomId}/join`, { headers, data: { password } });
  const { ticket } = (await joined.json()) as { ticket: string };
  const done = await kimContext.request.post(`${origin}/api/rooms/${roomId}/join/complete`, { headers, data: { ticket, name: "Kim", color: "#30a46c" } });
  const kimId = ((await done.json()) as { member: { id: string } }).member.id;

  const cookie = (await dmContext.cookies(origin)).map((c) => `${c.name}=${c.value}`).join("; ");
  ops = await OpSocket.open({ origin, roomId, cookie });
  await ops.send({ t: "scene.update", sceneId, patch: { name: "The Gilded Boar", bounds: { w: 12, h: 16 }, fogEnabled: false } });
  await ops.send({ t: "build.rect", sceneId, terrain: "wood", x: 1, y: 1, w: 10, h: 14 });
  const bree = randomUUID();
  const breeToken = randomUUID();
  const goblin = randomUUID();
  await ops.send({ t: "character.create", character: { id: bree, name: "Bree", size: "medium", ownerIds: [kimId], actor: actor(20), level: 4 } });
  await ops.send({ t: "character.update", characterId: bree, patch: { classes: [{ id: "wizard", level: 3 }, { id: "cleric", level: 1 }] } });
  await ops.send({ t: "token.create", token: { id: breeToken, sceneId, kind: "pc", name: "Bree", size: "medium", x: 4, y: 6, visibility: "all", disposition: "ally", actor: { ref: bree } } });
  await ops.send({ t: "token.create", token: { id: goblin, sceneId, kind: "monster", name: "Goblin", size: "medium", x: 7, y: 6, visibility: "all", disposition: "hostile", actor: { inline: actor(7) } } });

  const kim = await kimContext.newPage();
  const kimSocket = new SocketWatch("kim");
  await kimSocket.attach(kimContext, kim);
  await kim.goto(`${origin}/r/${roomId}`);
  await kim.getByRole("status", { name: "Connected" }).first().waitFor();
  await waitFor("Kim's snapshot", () => kimSocket.state);

  // Her turn: the turn card's folded Spell slots row, with Use a slot… open.
  const breeEntry = randomUUID();
  await ops.send({ t: "encounter.start", entries: [{ id: breeEntry, tokenId: breeToken, value: 15 }, { id: randomUUID(), tokenId: goblin, value: 5 }] });
  await ops.send({ t: "encounter.next" });
  await waitFor("Bree's turn", () => (dmSocket.state?.encounter?.activeEntryId === breeEntry ? true : null));
  const turn = kim.locator('[data-alert="turn"]');
  await turn.getByRole("button", { name: "Show Bree's turn" }).tap();
  await turn.getByText("Left by level: 4, 3", { exact: true }).waitFor();
  await turn.getByRole("button", { name: "Use a slot…" }).tap();
  await turn.getByRole("group", { name: "Use a slot" }).waitFor();
  await picture(kim, "spell-slots-turn");
  await turn.getByRole("button", { name: "Dismiss Bree's turn" }).tap();
  await ops.send({ t: "encounter.end" });
  await waitFor("the fight over", () => (dmSocket.state && !dmSocket.state.encounter ? true : null));

  // A Short Rest after a fight: the die rows, one d6 rolled.
  await ops.send({ t: "actor.hp", target: { characterId: bree }, change: { kind: "damage", amount: 12 } });
  await waitFor("Bree hurt", () => (kimSocket.state?.characters[bree]?.actor.hp.cur === 8 ? true : null));
  await kim.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).click();
  await kim.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Characters/ }).click();
  const page = kim.locator('dialog[data-rvtt-sheet][aria-label="Characters"]');
  const heading = page.locator("[data-creature-heading]").filter({ hasText: "Bree" });
  const opener = page.locator(`[data-opener="character:${bree}"]`);
  await heading.or(opener).first().waitFor();
  if ((await heading.count()) === 0) await opener.click();
  await heading.waitFor();
  const rest = section(page, "Rest");
  await rest.getByRole("radio", { name: "Short Rest" }).check();
  await rest.getByRole("textbox", { name: "Constitution modifier" }).fill("1");
  await rest.getByRole("button", { name: "Roll a d6 Hit Point Die plus 1, 3 of 3 left" }).tap();
  await rest.locator('[data-hit-die="6"]').getByText(/^Rolled \d+ \+ 1: \d+ HP back\.$/).first().waitFor();
  await rest.getByText("Spend Hit Point Dice one at a time. Each one heals at once.", { exact: true }).evaluate((el) => (el as unknown as { scrollIntoView(o: object): void }).scrollIntoView({ block: "start" }));
  await picture(kim, "short-rest-dice");
} finally {
  ops?.close();
  if (roomId) await dmContext.request.delete(`${server.origin}/api/rooms/${roomId}`, { headers: { Origin: server.origin }, data: { name: roomName } }).catch(() => undefined);
  await browser.close();
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
