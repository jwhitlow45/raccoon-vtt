// @ts-nocheck
// Page functions in this file run in the browser, so they use DOM names the server's type setup does not have.
import { uuidv7 as randomUUID } from "../../shared/ids.ts";
import WebSocket from "ws";

/** The room's state as the DM's session would get it in a snapshot. */
export function roomState(c: any, sceneId?: string): Promise<any> {
  const url = `${c.origin.replace(/^http/, "ws")}/ws?room=${c.state.roomId}`;
  const ws = new WebSocket(url, { headers: { Origin: c.origin, Cookie: c.state.cookie } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no snapshot")), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", clientId: randomUUID(), resumeFrom: 1, ...(sceneId ? { sceneId } : {}) })));
    let switched = false;
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.t !== "snapshot") return;
      clearTimeout(timer);
      ws.close(1000);
      numberCopies(msg.state);
      resolve(msg.state);
    });
    ws.on("error", reject);
  });
}

/**
 * Gives a token's copies on one scene the `number` a step finds them by, in the order they were made. A token no
 * longer carries it (the app numbers copies as the party meets them), so a step that says "Goblin Warrior 2" means the
 * second one made, which is the order an encounter places them in.
 */
function numberCopies(state: any): void {
  const groups = new Map<string, any[]>();
  for (const t of Object.values(state.tokens ?? {}) as any[]) {
    const key = `${t.sceneId}|${t.kind}|${t.name}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.id < b.id ? -1 : 1));
    group.forEach((t, i) => (t.number = i + 1));
  }
}

export function sceneByName(state: any, name: string): any {
  return Object.values(state.scenes).find((s: any) => s.name === name);
}

export function actor(hp: number, ac = 12, extra: Record<string, unknown> = {}) {
  return { hp: { cur: hp, max: hp, temp: 0 }, life: "alive", ac, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "", ...extra };
}

export async function pcToken(c: any, sceneId: string, key: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await c.state.ops.send({ t: "token.create", token: { id, sceneId, kind: "pc", name: key[0]!.toUpperCase() + key.slice(1), size: "medium", x, y, disposition: "ally", visibility: "all", actor: { ref: c.state.chars[key] }, ...extra } });
  return id;
}

/** Scrolls the side panel so the first element matching `selectorText` sits at its top, and puts the page itself back at 0, 0. */
export async function panelScroll(page: any, text: string | null, extra = 8): Promise<void> {
  await page.evaluate(([needle, extra]: [string | null, number]) => {
    const panel = document.querySelector('[role="tabpanel"]') as HTMLElement | null;
    if (!panel) return;
    let box: HTMLElement | null = panel;
    while (box && !(box.scrollHeight > box.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (box) {
      if (needle === null) box.scrollTop = 0;
      else {
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.includes(needle)) {
            const el = node.parentElement!;
            box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - extra;
            break;
          }
        }
      }
    }
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (let e: HTMLElement | null = document.getElementById("root"); e; e = e.firstElementChild as HTMLElement | null) {
      if (getComputedStyle(e).overflowY === "hidden" || getComputedStyle(e).overflowY === "visible") e.scrollTop = 0;
      if (e === box) break;
    }
  }, [text, extra]);
}

/**
 * Scrolls the side panel so the first element whose whole text matches `pattern` sits just under the panel's sticky
 * header (or `pad` px below the top when there is none). Matches inside a sticky element, such as the tracker's
 * "Goblin Boss's turn", are skipped.
 */
export async function rowsIntoView(page: any, pattern: string, pad = 8): Promise<string> {
  return page.evaluate(([source, pad]: [string, number]) => {
    const panel = document.querySelector('[role="tabpanel"]') as HTMLElement | null;
    if (!panel) return "no panel";
    let box: HTMLElement | null = panel;
    while (box && !(box.scrollHeight > box.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (!box) return "no scroll box";
    const re = new RegExp(source);
    const sticky = (el: Element | null): HTMLElement | null => {
      for (let e = el as HTMLElement | null; e && e !== box; e = e.parentElement) if (getComputedStyle(e).position === "sticky") return e;
      return null;
    };
    let header = 0;
    for (const el of Array.from(box.querySelectorAll("*")) as HTMLElement[]) {
      if (getComputedStyle(el).position === "sticky" && el.getBoundingClientRect().top - box.getBoundingClientRect().top < 4) header = Math.max(header, el.getBoundingClientRect().height);
    }
    const hits = (Array.from(panel.querySelectorAll("*")) as HTMLElement[]).filter((el) => el.children.length === 0 && re.test((el.textContent ?? "").trim()) && !sticky(el));
    if (hits.length === 0) return "no match";
    const top = Math.min(...hits.map((h) => h.getBoundingClientRect().top));
    box.scrollTop += top - box.getBoundingClientRect().top - header - pad;
    return `moved to ${hits[0]!.textContent} under ${header}px`;
  }, [pattern, pad]);
}

/**
 * Opens the Characters panel on its list. The panel remembers the page last open (a character's page, or a form on it),
 * so Back is pressed until the list shows.
 */
export async function charactersList(c: any, page: any): Promise<void> {
  await c.harness.openSideTab(page, "Characters");
  for (let i = 0; i < 4; i++) {
    const back = page.getByRole("button", { name: /^Back to / }).first();
    if (!(await back.count())) break;
    const label = (await back.getAttribute("aria-label")) ?? (await back.textContent()) ?? "";
    await back.click();
    await page.waitForTimeout(400);
    const discard = page.getByRole("button", { name: /^Discard changes\?/ });
    if (await discard.count()) await discard.first().click();
    if (/Back to Characters/.test(label)) break;
  }
  await page.waitForTimeout(300);
}

/**
 * guidepass6: a picture of a 640 by 400 part of the 1280 by 800 window at twice the pixels, so a panel's detail reads
 * at the guide's width. The page is drawn at a device scale of 2 for the shot through the browser's own emulation,
 * then put back at 1.
 */
export async function shot2x(c: any, page: any, name: string, clip: { x: number; y: number }): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(1800);
  const file = `${c.RAW}/${name}.png`;
  // The browser's own capture, so the picture takes the emulated scale: 1280 by 800 pixels for the 640 by 400 part.
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: clip.x, y: clip.y, width: 640, height: 400, scale: 1 } });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(500);
  await cdp.detach();
  return file;
}

/** guidepass6: drags the action bar window by its grip ("Move window") so its left edge sits near `toX`, out of a picture's way. */
export async function moveBarLeft(page: any, toX = 40): Promise<void> {
  const grip = page.getByRole("button", { name: "Move window" }).first();
  if (!(await grip.count())) return;
  const box = await grip.boundingBox();
  if (!box) return;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(toX + box.width / 2, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}
