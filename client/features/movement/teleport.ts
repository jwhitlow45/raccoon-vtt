import type { RoomState, Token } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { landing } from "#shared/rules/movement.ts";
import type { OpAnswer } from "../../state/types.ts";
import { dropLanding, landed, squeezedSpot, type DropState, type DropToken, type Landed, type Stop } from "./drop.ts";

/**
 * "Teleport here" (2026-10-14, docs/design-v1-maps-vision.md section
 * 4.1), for Misty Step and anything else that passes walls or ledges. The
 * SRD says teleportation spends no movement, so it replaces the walk to the
 * wall rather than adding to it: the walk is taken back first, with the
 * same undo the action bar's "Undo move" sends, and the teleport then goes
 * from where the walk began as one uncounted leg.
 *
 * The undo names the walk's own op (`of`), so it takes back that move or
 * nothing, never an older one. Each step waits for the server's answer, so
 * the teleport always starts from where the server put the token.
 */

/** A stopped walk the map offers to teleport past: the stop, and the `n` of the walk's move, null when it never moved. */
export type StopNote = Stop & { n: number | null };

export const WALK_STILL_COUNTS = "Could not take back the walk to the wall, so it still counts.";
export const ANSWER_LOST = "The connection dropped before the server answered. Check where the token stands, then try again.";

/** The refusal of a teleport sent after its walk was taken back, so the player knows the token is back where it began. */
export function teleportRefusedText(locked: boolean): string {
  return locked ? "Teleport refused: the token is locked. The walk was taken back." : "Teleport refused. The walk was taken back.";
}

/**
 * The teleport's move from where the token stands now to the ghost. It
 * lands by the drop rule (section 4.1, Squeezing), so a Large creature sent
 * into a 5 ft corridor lands on the half-cell spot where it fits, squeezed,
 * found as its drop would find it (drop.ts `squeezedSpot`), and it writes
 * the ground there like any landing (section 4.2).
 */
export function teleportMove(state: DropState, token: DropToken, note: Pick<Stop, "ghost" | "aim" | "blocker">): Landed & { teleport: Stop["blocker"] } {
  const squeezed = squeezedSpot(state, token, note.aim, "teleport");
  const land = squeezed ?? landing(state, token, { ...note.ghost, elevation: dropLanding(state, token, note.ghost) }, "teleport");
  return { ...landed(state, token, { x: land.x, y: land.y, squeeze: land.squeeze }), teleport: note.blocker };
}

export type TeleportDeps = {
  /** The room as this device sees it now. */
  view(): (Pick<RoomState, "scenes" | "buildChunks"> & Pick<DropState, "meta" | "seen"> & { tokens: Readonly<Record<string, (DropToken & Pick<Token, "kind"> & Partial<Pick<Token, "attached" | "locked">>) | undefined>> }) | null;
  dispatch(op: ClientOp, opts: { onAnswer(answer: OpAnswer): void; quiet?: boolean }): number | null;
  notify(text: string, tone: "info" | "error"): void;
  /** The flow is over, whichever way it went: the note goes. */
  done(): void;
};

/**
 * Runs the steps of section 4.1: a walk stopped at its first step sent no
 * move, so the teleport goes at once. Otherwise the walk is taken back, and
 * the teleport follows from where the token then stands, the start. When
 * the server refuses to take the walk back (the token was moved since, or
 * the walk is no longer this player's newest change), the teleport still
 * goes, from where the token stands, and the player hears that the walk
 * still counts.
 */
export function runTeleport(note: StopNote, deps: TeleportDeps): void {
  if (note.n === null) {
    sendTeleport(note, deps, false);
    return;
  }
  // The flow says itself what became of the walk, so the undo's own toast stays away.
  const n = deps.dispatch(
    { t: "undo", of: note.n },
    {
      quiet: true,
      onAnswer(answer) {
        if (answer === "taken") {
          sendTeleport(note, deps, true);
        } else if (answer === "refused") {
          deps.notify(WALK_STILL_COUNTS, "info");
          sendTeleport(note, deps, false);
        } else {
          deps.notify(ANSWER_LOST, "error");
          deps.done();
        }
      },
    },
  );
  if (n === null) deps.done();
}

function sendTeleport(note: StopNote, deps: TeleportDeps, walkTakenBack: boolean): void {
  const view = deps.view();
  const token = view?.tokens[note.tokenId];
  if (!view || !token || token.sceneId !== note.sceneId) {
    deps.done();
    return;
  }
  const n = deps.dispatch(
    { t: "token.move", ...teleportMove(view, token, note) },
    {
      onAnswer(answer) {
        deps.done();
        if (answer === "refused" && walkTakenBack) deps.notify(teleportRefusedText(deps.view()?.tokens[note.tokenId]?.locked === true), "error");
      },
    },
  );
  if (n === null) deps.done();
}
