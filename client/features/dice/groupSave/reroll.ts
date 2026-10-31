import { d20Formula } from "#shared/dice/formula.ts";
import { dcOnLine } from "#shared/dice/secret.ts";
import { keys } from "#shared/keys.ts";
import { LIMITS } from "#shared/limits.ts";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import type { ActorTarget, OpOf } from "#shared/protocol.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import type { SavePageAskFields } from "#shared/saveOutcomeContract.ts";
import { askOp, targetKey, targetRef } from "../../rolls/logic.ts";
import { asSave, withExtra } from "../options.ts";
import { overrideRollSources, rollModeTo, type RollModeOverride } from "../rollMode.ts";
import type { Page, ServerRoll, Step } from "./chain.ts";
import { d20Of, type RowBase, type RowState } from "./rows.ts";

type RequestRef = Page["requests"][number] & { selected?: string[]; replaces?: string[]; dc?: number };

const stateOf = (page: Page, row: RowBase): RowState => page.states[row.holder] ?? { way: row.ways[0] ?? "type" };
const answered = (target: RollTarget) => target.total !== undefined || target.result !== undefined || target.mark !== undefined || target.noRoll === true;
const editable = (page: Page) => page.phase === "rolled" && page.test.kind !== "none" && page.apply !== "sending" && page.apply !== "unknown" && page.apply !== "taken";

/** Keep the explicit reroll wording even when the public name fills its limit. */
function againLabel(page: Page, limit: number): string {
  const name = (page.fill?.publicName ?? page.fill?.name ?? "").replace(/\s+/g, " ").trim();
  const suffix = page.test.kind === "check" ? "check again" : "save again";
  return name ? `${name.slice(0, limit - suffix.length - 2).trimEnd()}: ${suffix}` : suffix;
}

function withoutResult(state: RowState): RowState {
  const { rolled: _rolled, answer: _answer, typed: _typed, asked: _asked, mark: _mark, legendary: _legendary, batch: _batch, status: _status, says: _says, ...choices } = state;
  return choices;
}

export function rerollSaves(page: Page, input: { holders: readonly string[]; server: readonly ServerRoll[]; tag: string; override?: RollModeOverride }): Step {
  if (!editable(page)) return { page, send: [] };
  const rows = page.rows.filter(row => {
    const state = stateOf(page, row);
    return input.holders.includes(row.holder) && state.way === "server" && !state.gone && state.mark !== "skip" && !row.skip
      && !page.rolls.some(roll => roll.state === "sending" && roll.holders.includes(row.holder))
      && !page.dmRolls.some(roll => roll.state === "sending" && roll.holder === row.holder)
      && !page.requests.some(ask => ask.state === "sending" && ask.holders.includes(row.holder));
  });
  if (rows.length === 0) return { page, send: [] };
  if (page.rolls.some(roll => roll.tag === input.tag) || page.dmRolls.some(roll => roll.tag === input.tag) || page.damage?.tag === input.tag || page.plan?.plan === input.tag) {
    return { page, send: [], error: "Roll again needs a new roll id." };
  }
  const server = new Map(input.server.map(roll => [roll.holder, roll]));
  const untyped = rows.find(row => !server.has(row.holder));
  if (untyped) return { page, send: [], error: `Type ${untyped.name}'s bonus, or pick Type.` };
  const test = d20Of(page.test, page.spell)!;
  const ordinary = page.secret ? "dm" : "all";
  const to = rollModeTo(ordinary, ordinary, input.override);
  const dc = dcOnLine(to, page.dc ?? undefined, page.switches.dcShown);
  const label = againLabel(page, LIMITS.diceLabelChars);
  const rolls = rows.map(row => {
    const roll = server.get(row.holder)!;
    return asSave({ formula: withExtra(d20Formula(roll.bonus), roll.extra), creature: roll.target, label, sources: overrideRollSources(roll.sources, [], input.override) }, test);
  });
  const states = { ...page.states };
  for (const row of rows) states[row.holder] = { ...withoutResult(stateOf(page, row)), batch: { tag: input.tag, part: 0 } };
  return {
    page: { ...page, states, rolls: [...page.rolls, { tag: input.tag, holders: rows.map(row => row.holder), state: "sending" }] },
    send: [{ kind: "dice", tag: input.tag, rolls, to, ...(dc === undefined ? {} : { dc }) }],
  };
}

type Replacement = { selected: RowBase[]; old: Set<string> };

/**
 * Selected rows can refer to multiple old requests restored separately. Keep
 * their connected requests in one atomic replacement, or refuse if they cannot
 * fit. Splitting a retirement would lose its still-unanswered creatures.
 */
function partitions(page: Page, selected: RowBase[], requests: Readonly<Record<string, RollRequest | undefined>>): Replacement[] {
  const linked: Replacement[] = [];
  const fresh: RowBase[] = [];
  for (const row of selected) {
    const ids = new Set(page.requests.filter(ask => ask.holders.includes(row.holder) && requests[ask.rollId]).map(ask => ask.rollId));
    const asked = page.states[row.holder]?.asked?.rollId;
    if (asked && requests[asked]) ids.add(asked);
    if (ids.size === 0) {
      fresh.push(row);
      continue;
    }
    const joined: Replacement = { selected: [row], old: ids };
    for (let i = linked.length - 1; i >= 0; i--) {
      const group = linked[i]!;
      if (![...group.old].some(id => joined.old.has(id))) continue;
      joined.selected.unshift(...group.selected);
      for (const id of group.old) joined.old.add(id);
      linked.splice(i, 1);
    }
    linked.push(joined);
  }
  for (let i = 0; i < fresh.length; i += LIMITS.rollTargets) linked.push({ selected: fresh.slice(i, i + LIMITS.rollTargets), old: new Set() });
  return linked;
}

export function askAgain(page: Page, input: { holders: readonly string[]; requests: Readonly<Record<string, RollRequest | undefined>>; requestIds: () => string }): Step {
  if (!editable(page)) return { page, send: [] };
  if (page.requests.some(ask => ask.state === "sending")) return { page, send: [], error: "Wait for the current request to finish." };
  const selected = page.rows.filter(row => {
    const state = stateOf(page, row);
    return input.holders.includes(row.holder) && state.way === "ask" && row.askRef && !state.gone && state.mark !== "skip" && !row.skip;
  });
  if (selected.length === 0 || page.test.kind === "none") return { page, send: [] };
  if (page.dmRolls.some(roll => roll.state === "sending" && selected.some(row => row.holder === roll.holder))) return { page, send: [], error: "Wait for the current roll to finish." };
  const groups = partitions(page, selected, input.requests);
  const retired = new Set(groups.flatMap(group => [...group.old]));
  const open = Object.values(input.requests).filter(Boolean).length;
  const excess = open - retired.size + groups.length - LIMITS.openRollsPerRoom;
  if (excess > 0) return { page, send: [], error: `Close ${excess} request${excess === 1 ? "" : "s"} first.` };
  const usedIds = new Set([...Object.keys(input.requests), ...page.requests.map(ask => ask.rollId)]);
  const send: Step["send"] = [];
  const pending: RequestRef[] = [];
  for (const group of groups) {
    const targets = new Map<string, ActorTarget>(group.selected.map(row => [targetKey(row.askRef!), row.askRef!]));
    const selectedKeys = new Set(targets.keys());
    const old = [...group.old].map(id => input.requests[id]!);
    const answeredKeys = new Set(old.flatMap(ask => ask.targets.filter(answered).map(targetKey)));
    for (const ask of old) {
      for (const target of ask.targets) {
        const key = targetKey(target);
        if (!selectedKeys.has(key) && !answeredKeys.has(key)) targets.set(key, targetRef(target));
      }
    }
    if (targets.size > LIMITS.rollTargets || group.old.size > LIMITS.openRollsPerRoom) {
      return { page, send: [], error: `The replacement and its waiting creatures must fit in one request of at most ${LIMITS.rollTargets}.` };
    }
    const id = input.requestIds();
    if (!id || id.length > 64 || usedIds.has(id)) return { page, send: [], error: "Ask again needs a new request id." };
    usedIds.add(id);
    const made = askOp({
      test: { kind: page.test.kind, choices: [{ ability: page.test.ability, ...(page.test.kind === "check" && page.test.skill ? { skill: page.test.skill } : {}) }] },
      ...(page.dc === null ? {} : { dc: page.dc }),
      dcShown: page.switches.dcShown,
      resultShown: page.switches.resultShown,
      ...(page.spell && page.test.kind === "save" ? { spell: true } : {}),
      note: againLabel(page, LIMITS.rollNoteChars),
      targets: [...targets.values()],
    }, id, 0);
    if (!made.ok) return { page, send: [], error: made.error };
    const replaces = old.map(ask => ({ id: ask.id, expectHash: guardHash(keys.roll(ask.id), ask) }));
    const op: OpOf<"roll.ask"> & SavePageAskFields = { ...made.op, reason: "savePage", ...(replaces.length ? { replaces } : {}) };
    send.push({ kind: "op", op });
    const holders = page.rows.filter(row => row.askRef && targets.has(targetKey(row.askRef)) && stateOf(page, row).way === "ask").map(row => row.holder);
    pending.push({ rollId: id, holders, selected: group.selected.map(row => row.holder), replaces: [...group.old], ...(page.dc === null ? {} : { dc: page.dc }), state: "sending" });
  }
  return { page: { ...page, requests: [...page.requests, ...pending] }, send };
}

export function settleAskAgain(page: Page, rollId: string, answer: { ok: true } | { ok: false; message: string }): Page {
  const request = page.requests.find(ask => ask.rollId === rollId) as RequestRef | undefined;
  if (!request?.selected || request.state !== "sending") return page;
  if (!answer.ok) {
    return { ...page, requests: page.requests.map(ask => ask.rollId === rollId ? { ...ask, state: "refused", says: answer.message } : ask) };
  }
  const states = { ...page.states };
  for (const holder of request.holders) {
    const row = page.rows.find(row => row.holder === holder);
    if (!row) continue;
    const state = stateOf(page, row);
    states[holder] = { ...(request.selected.includes(holder) ? withoutResult(state) : state), asked: { rollId, ...(request.dc === undefined ? {} : { dc: request.dc }) } };
  }
  return {
    ...page,
    states,
    requests: page.requests.map(ask => ask.rollId === rollId ? { ...ask, state: "open" } : request.replaces?.includes(ask.rollId) ? { ...ask, state: "closed" } : ask),
  };
}
