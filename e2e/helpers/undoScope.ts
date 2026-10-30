import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Page } from "playwright-core";
import { clientOpSchema, type ServerMessage } from "../../shared/protocol.ts";
import { historyMessageSchema, type HistoryDirection, type HistoryMessage, type HistoryScope } from "../../shared/undoContract.ts";
import { openSideTab, untilReady, waitFor, type SocketWatch } from "../harness.ts";

type WireMessage = ServerMessage | HistoryMessage;
type Event = Extract<ServerMessage, { t: "ev" }>;

/** Keeps real wire heads so browser fixtures exercise the same member's committed history. */
export class UndoWire {
  readonly received: WireMessage[] = [];
  readonly socket: WebSocket;
  n = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => this.received.push(JSON.parse(String(data)) as WireMessage));
  }

  static async open(input: { origin: string; roomId: string; cookie: string }): Promise<UndoWire> {
    const socket = new WebSocket(`${input.origin.replace(/^http/, "ws")}/ws?room=${input.roomId}`, { headers: { Origin: input.origin, Cookie: input.cookie } });
    const client = new UndoWire(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ t: "hello", clientId: randomUUID(), resumeFrom: 1 }));
    await waitFor("undo fixture snapshot", () => client.received.find((m) => m.t === "snapshot"));
    await client.history();
    return client;
  }

  async history(watermark = this.n): Promise<HistoryMessage> {
    return historyMessageSchema.parse(await waitFor("covering history", () => this.received.findLast((m) => m.t === "history" && m.watermark >= watermark)));
  }

  async send(op: unknown, options: { g?: string; groupScope?: "setup" } = {}): Promise<Event> {
    const n = ++this.n;
    this.socket.send(JSON.stringify({ t: "op", n, op, ...options }));
    const event = await waitFor(`undo fixture terminal answer ${n}`, () => this.received.find((m): m is Event => m.t === "ev" && Boolean(m.acks?.includes(n) || m.rejects?.some((r) => r.n === n))));
    await this.history(n);
    return event;
  }

  async apply(op: unknown, options: { g?: string; groupScope?: "setup" } = {}): Promise<void> {
    const parsed = clientOpSchema.safeParse(op);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    const event = await this.send(op, options);
    assert.equal(event.rejects?.length ?? 0, 0, JSON.stringify(event.rejects));
  }

  async restore(scope: HistoryScope, direction: HistoryDirection = "undo"): Promise<void> {
    const head = (await this.history())[scope]?.[direction].head;
    assert.ok(head, `${scope} ${direction} exists`);
    await this.apply({ t: direction, scope, head: head.id });
  }

  close(): void { this.socket.close(1000); }
}

export function historyOf(watch: SocketWatch): HistoryMessage | undefined {
  for (const raw of [...watch.received].reverse()) {
    const parsed = historyMessageSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Opens the Menu: its side panel tab from 900 px up, else its sheet from Panels, as a phone shows it. */
export async function openMenu(page: Page): Promise<void> {
  const menuSheet = page.locator('dialog[data-rvtt-sheet][aria-label="Menu"]');
  const tabs = page.getByRole("tablist", { name: "Panels" });
  const panels = page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ });
  // A page just loaded shows neither yet. Wait for the one its width gives it.
  await tabs.or(panels).or(menuSheet).first().waitFor();
  if (await tabs.isVisible()) await openSideTab(page, "Menu");
  else if (!(await menuSheet.isVisible())) {
    await panels.click();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Menu/ }).click();
    await menuSheet.waitFor();
  }
}

/** Opens Setup history from the Menu. */
export async function setupHistory(page: Page) {
  await openMenu(page);
  const back = page.getByRole("button", { name: "Back to Menu", exact: true });
  if (await back.isVisible()) await back.click();
  // The Menu's row, named with its detail, never a toast that starts with the same words.
  const opener = page.getByRole("button", { name: /^Setup history Undo or redo/ });
  await opener.click();
  const sheet = page.getByRole("dialog", { name: "Setup history", exact: true });
  await sheet.waitFor();
  return { sheet, opener };
}

export function playControl(page: Page, direction: HistoryDirection) {
  return page.locator("header:has(h1)").first().getByRole("button", { name: direction === "undo" ? "Undo" : "Redo", exact: true });
}

/** Takes back the newest Setup step from Setup history, as a DM does, and closes the sheet. The top bar's Undo never reaches it. */
export async function undoSetup(page: Page): Promise<void> {
  const { sheet } = await setupHistory(page);
  const undo = sheet.getByRole("button", { name: "Undo setup", exact: true });
  await untilReady(undo, "Undo setup");
  await undo.click();
  await sheet.locator("[data-history-result]").filter({ hasText: /^Undid setup: / }).waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
}
