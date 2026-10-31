import type { RollTarget } from "#shared/model.ts";
import { targetKey } from "./logic.ts";
import { rolledNews } from "./card.ts";

type FocusNode = { readonly isConnected: boolean };
export type RollFocus = {
  card: FocusNode | null;
  active: FocusNode | null;
  body: FocusNode;
  prior: { key: string; node: FocusNode } | null;
};

/** A result leaves connected controls alone and recovers focus lost with its answer row. */
export function focusRollHeader(landed: readonly string[], focus: RollFocus): boolean {
  const { card, active, body, prior } = focus;
  const leftRow = prior && !prior.node.isConnected && landed.includes(prior.key);
  return card !== null && (active === null || active === body || !!leftRow && (active === card || active === prior.node));
}

/** Only answers that changed since the card opened announce and engage the card. */
export function rollArrival(before: ReadonlyMap<string, string | undefined> | null, targets: readonly RollTarget[], names: string, focus: RollFocus): { keys: string[]; news: string; focusHeader: boolean } | null {
  if (!before) return null;
  const landed = targets.filter((t) => t.dice !== undefined && before.has(targetKey(t)) && before.get(targetKey(t)) !== t.tag);
  if (landed.length === 0) return null;
  const keys = landed.map(targetKey);
  const list = names.split("|");
  return {
    keys,
    news: landed.map((t) => rolledNews(list[targets.indexOf(t)] || "Your creature", t)).join(" "),
    focusHeader: focusRollHeader(keys, focus),
  };
}
