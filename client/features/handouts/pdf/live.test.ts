import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { JobSlotState, Phase, PdfJob } from "./job.ts";
import { RoomScope } from "../../../state/scope.ts";
import { dmPanelFoldsSlot } from "../../../lib/folds.ts";
import { pdfJobSlot } from "./job.ts";
import { revealHandoutsOnWait, revealOnWait } from "./live.ts";

/*
 * A PDF upload that starts to wait on the DM reveals the DM panel's Handouts
 * (docs/design/design-v1-panel-groups.md 6.1, D-261102-758), even with the
 * panel closed, so a folded Handouts shows the block when the DM looks. Only
 * a new wait reveals: the DM may fold Handouts while one lasts.
 */

const job = (k: Phase["k"]): PdfJob => ({ fileName: "Map.pdf", docId: "d1", title: "Map", numPages: 3, from: "1", to: "3", range: null, pages: [], leftOut: [], phase: { k } as Phase, uncertain: null, announce: "", announced: 0 }) as PdfJob;

test("a job reveals Handouts each time it starts to wait on the DM, and never while it goes on waiting or works", () => {
  const store = createStore<JobSlotState>(() => ({ job: null, blockShown: false }));
  let reveals = 0;
  const stop = revealOnWait(store, () => reveals++);
  store.setState({ job: job("loading") });
  assert.equal(reveals, 0, "opening the file waits on nobody");
  store.setState({ job: job("range") });
  assert.equal(reveals, 1, "the range to pick waits on the DM");
  store.setState({ job: job("range") });
  store.setState({ job: { ...job("range"), title: "Old map" } });
  assert.equal(reveals, 1, "a change inside the same wait reveals nothing more");
  store.setState({ job: job("preparing") });
  store.setState({ job: job("paused") });
  assert.equal(reveals, 2, "a pause after the upload ran is a new wait");
  store.setState({ job: job("titleInvalid") });
  assert.equal(reveals, 2, "a wait that goes on from one step to the next is the same wait");
  store.setState({ job: job("saved") });
  store.setState({ job: null });
  store.setState({ job: job("recovery") });
  assert.equal(reveals, 3, "a recovery offered on a later load waits on the DM");
  stop();
  store.setState({ job: null });
  store.setState({ job: job("refused") });
  assert.equal(reveals, 3, "nothing after the room stops listening");
});

test("a wait already showing when the room starts listening is not revealed again", () => {
  const store = createStore<JobSlotState>(() => ({ job: job("paused"), blockShown: false }));
  let reveals = 0;
  revealOnWait(store, () => reveals++);
  store.setState({ job: job("titleInvalid") });
  assert.equal(reveals, 0);
});

test("the Room's wiring reveals the DM panel's Handouts from its own job, with the panel closed, until the panel next closes", () => {
  const scope = new RoomScope();
  const folds = scope.get(dmPanelFoldsSlot);
  folds.tap("handouts", false, false);
  const room = { clock: false, scenes: true };
  assert.equal(folds.get(390, room).handouts, false);
  const stop = revealHandoutsOnWait(scope);
  scope.get(pdfJobSlot).store.setState({ job: job("range") });
  assert.equal(folds.get(390, room).handouts, true, "revealed while the panel is closed");
  assert.equal(folds.get(390, room).screens, true, "and nothing else changes");
  // The panel opens and closes: the reveal ends, and the DM's fold is as it was.
  folds.follow(true, room);
  folds.follow(false, room);
  assert.equal(folds.get(390, room).handouts, false);
  stop();
});
