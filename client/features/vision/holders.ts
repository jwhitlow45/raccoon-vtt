import { LIMITS } from "#shared/limits.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { ownsToken, perPlayerScene, sightHolders, withheldWhereItStands } from "#shared/project.ts";
import { holderOf } from "#shared/rules/attach.ts";
import { HOLDERS_FULL } from "#shared/reducer/map.ts";
import { displayName } from "../../lib/scene.ts";

/**
 * Who sees for themselves on a per-player scene, and what the Vision
 * settings say about it (docs/design-v1-per-player-vision.md 7.1), as
 * plain functions over the DM's view for node --test. The DM's view holds
 * the scene's holder list (RoomState.holders) and every owner, so these
 * answer exactly what the server's list says.
 */

/** One player of the roster in "Who sees for themselves": ticked while their entry is on, `listed` while they have an entry at all. */
export type HolderRow = { memberId: string; name: string; on: boolean; listed: boolean };

/** Every player of the roster, by name, each ticked as the scene's list says. A DM and a table display never hold sight. */
export function holderRows(view: Pick<RoomState, "members" | "holders">, sceneId: string): HolderRow[] {
  const entries = view.holders?.[sceneId]?.entries ?? [];
  const rows: HolderRow[] = [];
  for (const m of Object.values(view.members)) {
    if (!m || m.kind !== "player") continue;
    const entry = entries.find((e) => e.memberId === m.id);
    rows.push({ memberId: m.id, name: m.name, on: entry?.on === true, listed: entry !== undefined });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/**
 * What a tick or an untick asks of the server: the players who then see
 * for themselves, the whole list the `vision.holders` op names, in the
 * rows' order (by name, then id), the ticked one last. The reducer keeps
 * each entry's own place, so the order sent changes nothing. Ticking one
 * more than the cap allows is refused here with the server's own words,
 * so it never leaves the device.
 */
export function holdersAfter(rows: readonly HolderRow[], memberId: string, tick: boolean): { on: string[] } | { refused: string } {
  const on = rows.filter((r) => r.on && r.memberId !== memberId).map((r) => r.memberId);
  if (!tick) return { on };
  if (on.length >= LIMITS.sightHoldersPerScene) return { refused: HOLDERS_FULL };
  return { on: [...on, memberId] };
}

/**
 * Unticking asks once (7.1). The roster holds no pronouns, so the question
 * says "they", where the design's example says "She ... her".
 */
export function untickQuestion(name: string): string {
  return `Untick ${name}? They forget their map of this scene.`;
}

/** A player whose entry is off sees only what creatures that share sight see (6.1). */
export function sharedOnlyText(name: string): string {
  return `${name} sees only what creatures that share sight see here.`;
}

export const HOLDERS_UNDER = "Players not ticked, and the table display, see only what creatures that share sight with the party see.";

/** Names joined as a sentence lists them: "Ana", "Ana and Ben", "Ana, Ben and Cy". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The end of a lending creature's row on a per-player scene (7.1): one
 * marked to share sight lends it to every player, and any other to the
 * sight holders who own it, by name. A creature whose players hold no
 * sight here lends it to no player, a case the design leaves unworded.
 */
export function lendsText(view: Pick<RoomState, "members" | "holders" | "characters">, sceneId: string, token: Token): string {
  if (token.partyVision === true) return "Lends its sight to every player";
  // sightHolders reads the list and the roster, ownsToken the token and its character: the fields this function takes.
  const room = view as RoomState;
  const names = sightHolders(room, sceneId)
    .filter((memberId) => ownsToken(room, { memberId, role: "player" }, token))
    .map((memberId) => view.members[memberId]?.name ?? "")
    .filter((name) => name !== "")
    .sort((a, b) => a.localeCompare(b));
  return names.length === 0 ? "Lends its sight to no player" : `Lends its sight to ${listed(names)}`;
}

/**
 * The riders whose controlled mount not every player sees, on a
 * per-player scene (7.1, risk 2): a mount shares a rider's turn only while
 * every player sees both (shared/reducer/encounter.ts sharedMounts), and
 * there every player sees only what creatures that share sight see. The
 * DM keeps the turn by making the mount always visible. A mount the DM hid
 * is left out, since being hidden is why. Behind a blackout the answer is
 * the same, since a blackout ends.
 */
export function unsharedMounts(view: RoomState, sceneId: string): string[] {
  if (!perPlayerScene(view.scenes[sceneId])) return [];
  const out: { key: string; text: string }[] = [];
  for (const rider of Object.values(view.tokens)) {
    if (!rider || rider.sceneId !== sceneId || rider.attached?.kind !== "ride" || rider.attached.steer !== true) continue;
    const mount = view.tokens[rider.attached.to];
    if (!mount || holderOf(view.tokens, rider) !== mount || mount.visibility === "dm" || rider.visibility === "dm") continue;
    if (withheldWhereItStands(view, rider) || !withheldWhereItStands(view, mount)) continue;
    const name = displayName(mount);
    out.push({ key: `${displayName(rider)}\u0000${rider.id}`, text: `${displayName(rider)} rides ${name}, which not every player sees, so they share no turn. Make ${name} always visible to keep it.` });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key)).map((o) => o.text);
}
