import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { RoomState } from "#shared/model.ts";
import type { SaveOutcomeLedger } from "#shared/saveOutcomeContract.ts";
import { waitFor, type SocketWatch } from "../harness.ts";

export const OUTCOME_UNDONE = "Outcome undone. Change the DC, roll again, or apply again.";
export const OUTCOME_RESTORED = "Outcome restored. Undo it before changing this save.";
export const OUTCOME_UNAVAILABLE = "This save's outcome cannot be checked. Start a new group save to continue.";

export async function openSaveDice(page: Page) {
  const sheet = page.locator('dialog[data-rvtt-sheet][aria-label="Dice"]');
  if (!(await sheet.isVisible())) {
    await page.getByRole("navigation", { name: "Tools" }).getByRole("button", { name: /^Panels/ }).tap();
    await page.getByRole("region", { name: "Panels" }).getByRole("button", { name: /^Dice/ }).tap();
  }
  await sheet.waitFor();
  return sheet;
}

export function saveOutcomes(watch: SocketWatch): SaveOutcomeLedger {
  return (watch.state as (RoomState & { saveOutcomes?: SaveOutcomeLedger }) | null)?.saveOutcomes ?? {};
}

export function assertPrivateOutcome(watch: SocketWatch, id: string, plan = id): void {
  for (const secret of [id, plan, "saveOutcomes", "firstAppliedAt", "beforeApply", "redoHeld", "checkpoint"]) {
    assert.equal(watch.received.some((frame) => frame.includes(secret)), false, `private save metadata reached ${watch.label}: ${secret}`);
  }
}

/**
 * Closes the toasts an Undo or Redo step leaves over the map, by their words, so the next step's taps reach the map as
 * they did before these steps ran. An action toast's words come before its button, so its button is never pressed.
 */
export async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const toast = page.locator("button[data-toast], div[data-toast] > button").filter({ visible: true });
    if ((await toast.count()) === 0) return;
    await toast.first().click({ timeout: 1000 }).catch(() => {});
  }
}

/**
 * Closes the toasts an Undo and Redo of the DM's left on this page, once its socket holds a Redo line newer than
 * `linesBefore`. That line comes in the frame that brings the toast, which still has to be drawn.
 */
export async function dismissRedoToasts(page: Page, watch: SocketWatch, linesBefore: number): Promise<void> {
  await waitFor(`${watch.label}'s line for the Redo`, () => watch.state?.log.slice(linesBefore).some((line) => line.data?.type === "correction" && line.data.from === "redo") || null);
  await page.locator("[data-toast]").filter({ visible: true }).first().waitFor({ timeout: 2_000 }).catch(() => undefined);
  await dismissToasts(page);
}
