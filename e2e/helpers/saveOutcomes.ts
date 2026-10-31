import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { RoomState } from "#shared/model.ts";
import type { SaveOutcomeLedger } from "#shared/saveOutcomeContract.ts";
import type { SocketWatch } from "../harness.ts";

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
