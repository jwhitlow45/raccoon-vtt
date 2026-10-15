import type { Member } from "#shared/model.ts";

/**
 * What a Members row says beside the name: the role, and whether the
 * member is online. Your own row puts the online state in the detail line
 * with the role ("Player · Online"), since its Color button takes the
 * trailing room, and a tag beside the button squeezed the name and
 * "(you)" to an ellipsis on a phone (LPD-REGRESS-2). Every other row keeps
 * the tag, where a DM scans the roster for who is missing.
 */
export function memberRow(input: { kind: Member["kind"]; own: boolean; online: boolean }): { detail: string; tag: string | null } {
  const role = input.kind === "dm" ? "DM" : "Player";
  const state = input.online ? "Online" : "Offline";
  return input.own ? { detail: `${role} · ${state}`, tag: null } : { detail: role, tag: state };
}
