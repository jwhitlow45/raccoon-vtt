import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { ApiError } from "../../../lib/api.ts";
import { isFinal, SoundQueue } from "./job.ts";
import { assetRow, fakeFile, FakeWorld, flush, OUT_OF_SPACE, prepared } from "./job.testutil.ts";

/**
 * Random sequences of picks, cancels, dismissals, reads, uploads and
 * answers settling in any order (agent rules: one randomized test for code
 * that juggles cancels and late answers). The invariants:
 *
 * - at most one read is ever in flight, a cancelled one counted until it settles;
 * - nothing is uploaded for a file cancelled or stopped before its read ended,
 *   and no `sound.create` is sent for one cancelled or stopped before its upload ended;
 * - each file sends `sound.create` once at most;
 * - a row says Added only after `sound.create` was taken, or not heard and the room holds the sound;
 * - once everything settles, every row left is Added or refused: nothing hangs.
 */

type Action =
  | { t: "add"; count: number }
  | { t: "cancel"; pick: number }
  | { t: "dismiss"; pick: number }
  | { t: "read"; pick: number; how: "ok" | "refused" | "throws" }
  | { t: "upload"; pick: number; how: "ok" | "full" | "busy" | "progress" }
  | { t: "create"; pick: number; how: "taken" | "refused" | "unknownHeld" | "unknownLost" }
  | { t: "timer"; pick: number }
  | { t: "dispose" };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ t: fc.constant("add" as const), count: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("cancel" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("dismiss" as const), pick: fc.nat() }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("read" as const), pick: fc.nat(), how: fc.constantFrom("ok" as const, "ok" as const, "refused" as const, "throws" as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("upload" as const), pick: fc.nat(), how: fc.constantFrom("ok" as const, "ok" as const, "full" as const, "busy" as const, "progress" as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("create" as const), pick: fc.nat(), how: fc.constantFrom("taken" as const, "refused" as const, "unknownHeld" as const, "unknownLost" as const) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("timer" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ t: "dispose" as const }) },
);

test("the queue keeps its promises under any order of events", async (t) => {
  // A read that throws is logged, which here would only be noise.
  t.mock.method(console, "error", () => {});
  await fc.assert(
    fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 60 }), async (actions) => {
      const world = new FakeWorld();
      const queue = new SoundQueue(world.deps());
      let files = 0;
      const answered = new Map<string, "taken" | "held" | "other">();
      const createsByFile = new Map<string, number>();
      const pick = <T>(list: T[], n: number): T | undefined => (list.length === 0 ? undefined : list[n % list.length]);
      for (const a of actions) {
        const pendingReads = world.reads.filter((r) => !r.settled);
        const pendingUploads = world.uploads.filter((u) => !u.settled);
        const pendingCreates = world.creates.filter((c) => !c.settled);
        const rows = queue.store.getState().rows;
        switch (a.t) {
          case "add":
            queue.add(Array.from({ length: a.count }, () => fakeFile(`f${++files}.wav`)), "music");
            break;
          case "cancel": {
            const row = pick(rows, a.pick);
            if (row) queue.cancel(row.id);
            break;
          }
          case "dismiss": {
            const row = pick(rows, a.pick);
            if (row) queue.dismiss(row.id);
            break;
          }
          case "read": {
            const call = pick(pendingReads, a.pick);
            if (!call) break;
            if (call.signal.aborted) call.reject(call.signal.reason);
            else if (a.how === "ok") call.resolve(prepared());
            else if (a.how === "refused") call.resolve({ ok: false, why: { t: "unreadable" } });
            else call.reject(new Error("decoder crashed"));
            break;
          }
          case "upload": {
            const call = pick(pendingUploads, a.pick);
            if (!call) break;
            if (a.how === "progress") call.options.onProgress?.(0.5);
            else if (a.how === "ok") call.resolve(assetRow(`asset-${call.options.name}`));
            else call.reject(a.how === "full" ? OUT_OF_SPACE : new ApiError(503, "busy", "busy", null));
            break;
          }
          case "create": {
            const call = pick(pendingCreates, a.pick);
            if (!call) break;
            if (a.how === "taken") answered.set(call.op.id, "taken");
            else if (a.how === "unknownHeld") {
              answered.set(call.op.id, "held");
              world.held.add(call.op.id);
            } else answered.set(call.op.id, "other");
            call.resolve(a.how === "taken" ? { t: "taken" } : a.how === "refused" ? { t: "refused", text: "Not saved." } : { t: "unknown" });
            break;
          }
          case "timer": {
            const timer = pick(world.timers.filter((t) => !t.cleared), a.pick);
            if (timer) {
              timer.cleared = true;
              timer.run();
            }
            break;
          }
          case "dispose":
            queue.dispose();
            break;
        }
        await flush();
        assert.ok(world.readsInFlight() <= 1, "two reads at once");
        for (const row of queue.store.getState().rows) {
          if (row.step.t !== "added") continue;
          const create = world.creates.find((c) => `${c.op.name}.wav` === row.fileName);
          assert.ok(create && (answered.get(create.op.id) === "taken" || answered.get(create.op.id) === "held"), "Added without the room taking it");
        }
        for (const r of world.reads) if (r.signal.aborted) assert.equal(world.uploads.some((u) => u.options.name === `${r.file.name}.mp3` && u.options.signal !== r.signal), false);
      }
      // Every upload belongs to a read that ended well, and was started with that file's own signal.
      for (const u of world.uploads) {
        const read = world.reads.find((r) => `${r.file.name}.mp3` === u.options.name);
        assert.ok(read && read.signal === u.options.signal);
      }
      for (const c of world.creates) {
        const upload = world.uploads.find((u) => u.settled && c.op.assetId === `asset-${u.options.name}`);
        assert.ok(upload, "sound.create without an upload that answered");
        const name = upload.options.name!;
        createsByFile.set(name, (createsByFile.get(name) ?? 0) + 1);
      }
      for (const n of createsByFile.values()) assert.equal(n, 1, "sound.create twice for one file");
      // Settle whatever is left, in order, until nothing waits.
      for (let round = 0; round < 200; round++) {
        const read = world.reads.find((r) => !r.settled);
        const upload = world.uploads.find((u) => !u.settled);
        const create = world.creates.find((c) => !c.settled);
        if (!read && !upload && !create) break;
        if (read) read.signal.aborted ? read.reject(read.signal.reason) : read.resolve(prepared());
        if (upload) upload.resolve(assetRow(`asset-${upload.options.name}`));
        if (create) create.resolve({ t: "taken" });
        await flush();
        assert.ok(world.readsInFlight() <= 1);
      }
      for (const row of queue.store.getState().rows) assert.ok(isFinal(row.step), `${row.fileName} left ${row.step.t}`);
    }),
    { numRuns: 400 },
  );
});
