import { d20Formula } from "#shared/dice/formula.ts";
import { LIMITS } from "#shared/limits.ts";
import type { CastAsk, CastEnd, DiceRoll, LogEntry, RollRequest, RollTest } from "#shared/model.ts";
import type { ActorTarget, ClientOp, OpOf } from "#shared/protocol.ts";
import type { AdvantageSource } from "#shared/dice/formula.ts";
import { dcOnLine } from "#shared/dice/secret.ts";
import { ANSWERED_MEANWHILE, ASK_CLOSED } from "#shared/permissions.ts";
import { askOp } from "../../rolls/logic.ts";
import { MAX_OP_AGE_MS } from "../../../state/store.ts";
import { asSave, cutLabel, testLabel, withExtra } from "../options.ts";
import type { PanelRoll } from "../useDicePanel.ts";
import { rollsOf } from "../logic.ts";
import { parseParts } from "./outcome.ts";
import { d20Of, rowResult, type GroupTest, type Mark, type RowBase, type RowState, type Way } from "./rows.ts";

/**
 * A group save's page as one state and the steps that move it
 * (docs/design-v1-roll-options.md 5.1 to 5.5 and 5.10), pure, so the
 * randomized test drives every order of events through the same code the
 * page runs. A step returns the page after it and the commands to send:
 * the page itself never sends anything on its own, and nothing that rolls
 * or applies is ever sent again unless the DM's own step asks for it.
 */

export type Phase = "setup" | "rolled" | "applying" | "applied";

/**
 * Where a page's rows come from until the roll freezes them (5.1): the
 * tokens a quick tap rolled, the room's selection as it changes (`live`,
 * less the creature acting, `except`), an area's caught creatures, or a
 * trap's springing (docs/design-v1-traps.md 4.4), whose rows are the
 * creatures it hits, frozen when it went off, and which Apply settles.
 * `tokenIds` of a live source are its last picks (followSelection), kept in
 * the draft, so a reload, which selects nothing, shows the same rows.
 */
export type Source =
  | { kind: "selection"; tokenIds: string[]; live?: true; except?: string }
  | { kind: "area"; templateId: string }
  | { kind: "trap"; trapId: string; due: string; tokenIds: string[] };

/** The name players read in what the page sends them (Fill.publicName). */
export function publicName(fill: Pick<Fill, "name" | "publicName">): string {
  return fill.publicName ?? fill.name;
}

/** The name a server roll's label carries: the real one only on a roll players never see. */
function rollName(page: Pick<Page, "fill" | "secret">): string {
  return page.secret ? page.fill!.name : publicName(page.fill!);
}

/** The tokens a page in setup reads its rows from: the selection now for a live source, less the acting creature, or its last picks while nothing is selected. */
export function sourceIds(source: Source, selected: readonly string[], area?: (templateId: string) => string[]): string[] {
  if (source.kind === "area") return area ? area(source.templateId) : [];
  if (source.kind === "trap") return source.tokenIds;
  if (!source.live || selected.length === 0) return source.tokenIds;
  return selected.filter((id) => id !== source.except);
}

/** A live page in setup keeps its picks as the selection changes, so the draft holds them (W7B-R2-1). The same page when nothing changed. */
export function followSelection(page: Page, selected: readonly string[]): Page {
  const source = page.source;
  if (page.phase !== "setup" || source.kind !== "selection" || !source.live || selected.length === 0) return page;
  const ids = sourceIds(source, selected);
  if (ids.length === source.tokenIds.length && ids.every((id, i) => id === source.tokenIds[i])) return page;
  return { ...page, source: { ...source, tokenIds: ids } };
}

export type Fill = {
  /** The spell's or action's name: "Fireball". The page and the DM's own secret lines name it. */
  name: string;
  /**
   * The name every string the page sends to players uses, each request's
   * note and the label of a roll made in the open, where it differs from
   * `name`: a trap's name once found, else "Trap" (docs/design-v1-traps.md
   * 4.4), so the page never names a trap the players have not found.
   */
  publicName?: string;
  /** What the page cannot know, under the fill line: a trap's DM note. */
  note?: string;
  /** The fill line: "From Fireball: Dexterity save, DC 15, 8d6 fire, half on a pass." */
  from: string;
  /** The recharge action it came from, marked Used on Apply (6.4). */
  recharge?: { holder: string; key: string };
  /** The type a bare number in the damage field takes: "28" from Fireball is fire. */
  damageType?: import("#shared/rules/damage.ts").DamageType;
  /** The token whose action or spell it is, whose own damage a player's creature rolls in the open. */
  caster?: string;
};

export type OutcomeForm = {
  /** The damage field as typed or filled. Empty with no damage. */
  damage: string;
  onPass: "half" | "none";
  conditions: string[];
  /** The conditions' end, as DurationFields keeps it, and the save that ends them. */
  lasts: { mode: "none" | "turnStart" | "turnEnd" | "rounds"; rounds: number; anchor: "own" | string };
  /** `dc` null is the page's DC, as a repeated save is against the first one's, read when Apply builds its plan. */
  saveEnds: { ability: "str" | "dex" | "con" | "int" | "wis" | "cha"; dc: number | null } | null;
  /** A spell's slot level, where it scales. */
  slot?: number;
};

export type Settle = "sending" | "committed" | "refused" | "unknown";

export type Page = {
  id: string;
  sceneId: string;
  phase: Phase;
  source: Source;
  fill: Fill | null;
  test: GroupTest;
  dc: number | null;
  secret: boolean;
  spell: boolean;
  switches: { dcShown: boolean; resultShown: boolean };
  /** Frozen at the roll. In setup the rows follow the source, and these are the last read. */
  rows: RowBase[];
  states: Record<string, RowState>;
  outcome: OutcomeForm;
  /** Each server roll the page sent, with the rows it rolled. */
  rolls: { tag: string; holders: string[]; state: Settle; says?: string }[];
  requests: { rollId: string; holders: string[]; state: "sending" | "open" | "refused" | "closed"; says?: string }[];
  /** The DM's one tap on an asked row (5.2). */
  dmRolls: { tag: string; holder: string; state: Settle; says?: string }[];
  /** The damage line. `imported` is the caster's own roll an ask brought (castFill), which the page never sent. */
  damage: { tag: string; state: Settle; amounts?: (number | undefined)[]; says?: string; imported?: true } | null;
  plan: OpOf<"actor.outcome"> | null;
  apply: "idle" | "sending" | "unknown" | "refused" | "taken";
  applySays?: string;
  rolledAt?: string;
  /** A quick tap from the Dice panel (4.4): the page rolls as soon as its rows are read, with the choices the tap took. */
  rollNow?: { sources: AdvantageSource[] };
  /** The player's ask for saves the page answers (docs/design-v1-player-save-spell.md 3.3), until it reads the ask's end. */
  cast?: PageCast;
  /** Why the page let go of its ask: "Thorn withdrew the ask." Apply then works as a plain group save. */
  castNote?: string;
};

/**
 * The ask a page holds: the ask as the DM's view had it at Open, and its
 * caster's name then, for the page's words. `blocked` is why Apply waits
 * for good: the ask was resolved elsewhere, or closed with an end the page
 * cannot read. `closing` is the phase a Close the ask left, while the
 * close is on its way or unknown. `says` is why the caster's roll was not
 * taken (castFill).
 */
export type PageCast = { ask: CastAsk; who: string; blocked?: string; closing?: "setup" | "rolled"; says?: string };

export type Command =
  | { kind: "dice"; tag: string; rolls: PanelRoll[]; to: "all" | "dm"; dc?: number }
  | { kind: "op"; op: ClientOp }
  | { kind: "outcome"; op: OpOf<"actor.outcome"> };

export type Step = { page: Page; send: Command[]; error?: string };

const EMPTY_OUTCOME: OutcomeForm = { damage: "", onPass: "half", conditions: [], lasts: { mode: "none", rounds: 10, anchor: "own" }, saveEnds: null };

export function newPage(input: {
  id: string;
  sceneId: string;
  source: Source;
  test: GroupTest;
  dc: number | null;
  secret: boolean;
  spell: boolean;
  switches: Page["switches"];
  fill?: Fill | null;
  outcome?: Partial<OutcomeForm>;
  rollNow?: { sources: AdvantageSource[] };
  cast?: PageCast;
  damage?: Page["damage"];
}): Page {
  return {
    ...(input.rollNow ? { rollNow: input.rollNow } : {}),
    ...(input.cast ? { cast: input.cast } : {}),
    id: input.id,
    sceneId: input.sceneId,
    phase: "setup",
    source: input.source,
    fill: input.fill ?? null,
    test: input.test,
    dc: input.dc,
    secret: input.secret,
    spell: input.spell,
    switches: input.switches,
    rows: [],
    states: {},
    outcome: { ...EMPTY_OUTCOME, ...input.outcome },
    rolls: [],
    requests: [],
    dmRolls: [],
    damage: input.damage ?? null,
    plan: null,
    apply: "idle",
  };
}

/** A row's state, its way the first it offers until the DM picks another. */
export function stateOf(page: Page, row: RowBase): RowState {
  return page.states[row.holder] ?? { way: row.skip ? "type" : row.ways[0]!, ...(row.skip ? { mark: "skip" as const } : {}) };
}

/** Every row's result now. */
export function results(page: Page): Map<string, Mark | null> {
  const out = new Map<string, Mark | null>();
  for (const row of page.rows) out.set(row.holder, rowResult(row, stateOf(page, row), page.test, page.dc));
  return out;
}

const withState = (page: Page, holder: string, patch: Partial<RowState>, row?: RowBase): Page => {
  const base = page.states[holder] ?? (row ? stateOf(page, row) : { way: "type" as Way });
  return { ...page, states: { ...page.states, [holder]: { ...base, ...patch } } };
};

function rowOf(page: Page, holder: string): RowBase | undefined {
  return page.rows.find((r) => r.holder === holder);
}

/** The words of the roll button: "Roll 4 saves and ask 2 players". */
export function rollWords(page: Page): string {
  if (page.test.kind === "none") return "No roll";
  const ways = page.rows.map((r) => stateOf(page, r)).filter((s) => s.mark !== "skip");
  const server = ways.filter((s) => s.way === "server").length;
  const ask = ways.filter((s) => s.way === "ask").length;
  const noun = page.test.kind === "save" ? "save" : "check";
  const parts: string[] = [];
  if (server > 0) parts.push(`Roll ${server} ${noun}${server === 1 ? "" : "s"}`);
  if (ask > 0) parts.push(`${parts.length > 0 ? "ask" : "Ask"} ${ask} player${ask === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" and ") : "Freeze the rows";
}

function rollTestOf(test: Exclude<GroupTest, { kind: "none" }>): RollTest {
  if (test.kind === "save") return { kind: "save", choices: [{ ability: test.ability }] };
  return { kind: "check", choices: [test.skill ? { ability: test.ability, skill: test.skill } : { ability: test.ability }] };
}

/** A server row's roll: its bonus and preset, its label naming the roll, its creature for who may see it. */
export type ServerRoll = { holder: string; target: ActorTarget; bonus: number; sources: AdvantageSource[]; extra: string[] };

/**
 * The roll (5.1): one tap freezes the rows and sends every server roll
 * in one tag and every request at once, 50 targets a request, after
 * checking the room's open requests leave room for them all. `taken` is
 * the panel's choices consumed at the tap, which start every server row.
 */
export function roll(page: Page, input: { rows: RowBase[]; server: readonly ServerRoll[]; tag: string; requestIds: () => string; openRequests: number; taken: readonly AdvantageSource[]; at: string }): Step {
  if (page.phase !== "setup") return { page, send: [] };
  const { rollNow: _now, ...rest } = page;
  let next: Page = { ...rest, rows: input.rows, phase: "rolled", rolledAt: input.at };
  if (page.test.kind === "none") return { page: next, send: [] };
  const test = page.test;
  const live = input.rows.filter((r) => stateOf(next, r).mark !== "skip");
  const asked = live.filter((r) => stateOf(next, r).way === "ask" && r.askRef);
  const requestsNeeded = Math.ceil(asked.length / LIMITS.rollTargets);
  const room = LIMITS.openRollsPerRoom - input.openRequests;
  if (requestsNeeded > room) return { page, send: [], error: `Close ${requestsNeeded - room} request${requestsNeeded - room === 1 ? "" : "s"} first.` };
  // A server row with no stat block rolls only once its bonus is typed, never with a +0 no one gave.
  const untyped = live.find((r) => stateOf(next, r).way === "server" && !input.server.some((s) => s.holder === r.holder));
  if (untyped) return { page, send: [], error: `Type ${untyped.name}'s bonus, or pick Type.` };
  const send: Command[] = [];
  const serverRows = input.server.filter((s) => live.some((r) => r.holder === s.holder && stateOf(next, r).way === "server"));
  if (serverRows.length > 0) {
    const d20 = d20Of(test, page.spell)!;
    const label = cutLabel(page.fill ? `${rollName(page)}, ${testLabel(d20)}` : testLabel(d20));
    const rolls = serverRows.map((s): PanelRoll => asSave({ formula: withExtra(d20Formula(s.bonus), s.extra), label, creature: s.target, sources: [...s.sources, ...input.taken] }, d20));
    send.push({ kind: "dice", tag: input.tag, rolls, ...diceEnvelope(page) });
    next = { ...next, rolls: [...next.rolls, { tag: input.tag, holders: serverRows.map((s) => s.holder), state: "sending" }] };
    for (const s of serverRows) next = withState(next, s.holder, { batch: { tag: input.tag, part: 0 } }, rowOf(next, s.holder));
  }
  for (let i = 0; i < asked.length; i += LIMITS.rollTargets) {
    const chunk = asked.slice(i, i + LIMITS.rollTargets);
    const rollId = input.requestIds();
    const made = askOp(
      {
        test: rollTestOf(test),
        ...(page.dc !== null ? { dc: page.dc } : {}),
        dcShown: page.switches.dcShown,
        resultShown: page.switches.resultShown,
        ...(page.spell && test.kind === "save" ? { spell: true as const } : {}),
        ...(page.fill ? { note: publicName(page.fill) } : {}),
        targets: chunk.map((r) => r.askRef!),
      },
      rollId,
      0,
    );
    if (!made.ok) return { page, send: [], error: made.error };
    send.push({ kind: "op", op: made.op });
    next = { ...next, requests: [...next.requests, { rollId, holders: chunk.map((r) => r.holder), state: "sending" }] };
    for (const r of chunk) next = withState(next, r.holder, { asked: { rollId, ...(page.dc !== null ? { dc: page.dc } : {}) } }, r);
  }
  return { page: next, send };
}

/** A request's answer from the server: taken, or refused, as another DM's request takes the last open place. */
export function askAnswered(page: Page, rollId: string, answer: { ok: true } | { ok: false; message: string }): Page {
  const request = page.requests.find((r) => r.rollId === rollId);
  if (!request || request.state !== "sending") return page;
  if (answer.ok) return { ...page, requests: page.requests.map((r) => (r.rollId === rollId ? { ...r, state: "open" } : r)) };
  let next: Page = { ...page, requests: page.requests.map((r) => (r.rollId === rollId ? { ...r, state: "refused", says: answer.message } : r)) };
  for (const holder of request.holders) {
    const s = next.states[holder];
    if (!s) continue;
    const { asked: _asked, ...rest } = s;
    next = { ...next, states: { ...next.states, [holder]: { ...rest, status: "notAsked", says: `Not asked: ${answer.message}` } } };
  }
  return next;
}

/**
 * The requests as the view holds them: each asked row copies its answer as
 * it arrives, kept once its request is closed elsewhere. A target the
 * request holds unanswered again, after Reopen, has no answer here either,
 * so its row waits, and the DM's one tap on it may go again (dmRoll).
 */
export function syncRequests(page: Page, rolls: Readonly<Record<string, RollRequest | undefined>>, key: (t: { tokenId?: string; characterId?: string }) => string): Page {
  let next = page;
  for (const request of page.requests) {
    const live = rolls[request.rollId];
    if (!live) continue;
    for (const holder of request.holders) {
      const row = rowOf(page, holder);
      if (!row?.askRef) continue;
      const target = live.targets.find((t) => key(t) === key(row.askRef as { tokenId?: string; characterId?: string }));
      const s = next.states[holder];
      if (!target || !s) continue;
      const answered = target.total !== undefined || target.result !== undefined || target.mark !== undefined;
      const dc = live.dc;
      const same = s.answer && JSON.stringify(s.answer) === JSON.stringify(target);
      if (!answered && !s.answer) continue;
      if (same && s.asked?.dc === dc) continue;
      const asked = { rollId: request.rollId, ...(dc !== undefined ? { dc } : {}) };
      if (answered) {
        next = withState(next, holder, { answer: target, asked });
        continue;
      }
      const { answer: _old, ...rest } = s;
      next = { ...next, states: { ...next.states, [holder]: { ...rest, asked } } };
    }
  }
  return next;
}

/**
 * A server roll's receipt (doc 1 1.2): committed fills each row its line
 * holds, by its creature. A row its lines do not hold was in a part
 * refused ("Not rolled", Roll them) or never settled ("This may have
 * happened"). Nothing rolls again on its own.
 */
export function rollSettled(page: Page, tag: string, settled: { state: "committed"; lines: readonly LogEntry[]; refused?: string } | { state: "refused"; says: string } | { state: "unknown" }, key: (t: { tokenId?: string; characterId?: string }) => string): Page {
  const sent = page.rolls.find((r) => r.tag === tag);
  if (!sent || sent.state !== "sending") return page;
  let next: Page = { ...page, rolls: page.rolls.map((r) => (r.tag === tag ? { ...r, state: settled.state, ...(settled.state === "refused" ? { says: settled.says } : {}) } : r)) };
  const found = new Map<string, DiceRoll>();
  if (settled.state === "committed") {
    for (const line of settled.lines) {
      if (line.data?.type !== "dice") continue;
      for (const r of line.data.rolls) found.set(key(r), r);
    }
  }
  for (const holder of sent.holders) {
    const row = rowOf(next, holder);
    if (!row) continue;
    const hit = found.get(key(row.target)) ?? (row.askRef ? found.get(key(row.askRef)) : undefined);
    if (hit) next = withState(next, holder, { rolled: hit, status: undefined, says: undefined }, row);
    else if (settled.state === "unknown") next = withState(next, holder, { status: "unknown", says: "This may have happened. Check the log." }, row);
    else {
      const says = settled.state === "refused" ? settled.says : (settled.refused ?? "Not rolled.");
      next = withState(next, holder, { status: "notRolled", says: `Not rolled: ${says}` }, row);
    }
  }
  return next;
}

/**
 * Where the page's server rolls go and the DC their line carries: in the
 * open only with "Players see the DC" on, since the page itself judges each
 * total against its DC (dcOnLine).
 */
function diceEnvelope(page: Page): { to: "all" | "dm"; dc?: number } {
  const to = page.secret ? "dm" : "all";
  const dc = dcOnLine(to, page.dc ?? undefined, page.switches.dcShown);
  return dc === undefined ? { to } : { to, dc };
}

/** Roll them again (5.10): only the DM's own step, under a new tag, for rows whose roll was refused or never settled. */
export function rollAgain(page: Page, input: { holders: readonly string[]; server: readonly ServerRoll[]; tag: string }): Step {
  if (page.phase !== "rolled" || page.test.kind === "none") return { page, send: [] };
  const again = input.server.filter((s) => input.holders.includes(s.holder) && (() => {
    const st = page.states[s.holder];
    return st?.status === "notRolled" || st?.status === "unknown";
  })());
  if (again.length === 0) return { page, send: [] };
  const d20 = d20Of(page.test, page.spell)!;
  const label = cutLabel(page.fill ? `${rollName(page)}, ${testLabel(d20)}` : testLabel(d20));
  let next: Page = { ...page, rolls: [...page.rolls, { tag: input.tag, holders: again.map((s) => s.holder), state: "sending" }] };
  for (const s of again) next = withState(next, s.holder, { status: undefined, says: undefined, batch: { tag: input.tag, part: 0 } });
  const rolls = again.map((s): PanelRoll => asSave({ formula: withExtra(d20Formula(s.bonus), s.extra), label, creature: s.target, sources: [...s.sources] }, d20));
  return { page: next, send: [{ kind: "dice", tag: input.tag, rolls, ...diceEnvelope(page) }] };
}

/**
 * The DM's one tap on a waiting asked row (5.2): `roll.dice` with
 * `unanswered`, so an answer that came first stands. Only a tap still on
 * its way holds another back. A settled one never does, whatever order its
 * receipt, a Reopen or the page's coming and going arrive in: the server
 * refuses a second answer by `unanswered` itself, so a row waiting on its
 * request can always be rolled once more.
 */
export function dmRoll(page: Page, holder: string, op: OpOf<"roll.dice">): Step {
  const s = page.states[holder];
  if (page.phase !== "rolled" || !s?.asked || s.answer || page.dmRolls.some((r) => r.holder === holder && r.state === "sending")) return { page, send: [] };
  return { page: { ...page, dmRolls: [...page.dmRolls, { tag: op.tag, holder, state: "sending" }] }, send: [{ kind: "op", op }] };
}

export function dmRollSettled(page: Page, tag: string, state: Settle, says?: string): Page {
  if (!page.dmRolls.some((r) => r.tag === tag && r.state === "sending")) return page;
  return { ...page, dmRolls: page.dmRolls.map((r) => (r.tag === tag ? { ...r, state, ...(says ? { says } : {}) } : r)) };
}

/** A receipt as the page reads it (doc 1 1.2): committed with its lines and any part refused, refused with its words, or unknown. */
export type Settled = { state: "committed"; lines: readonly LogEntry[]; refused?: string } | { state: "refused"; says: string; message?: string } | { state: "unknown" };

/** A damage line's amounts by part: each part with dice takes the next rolled total, a typed part none. */
export function damageAmounts(page: Page, lines: readonly LogEntry[]): (number | undefined)[] {
  const parsed = parseParts(page.outcome.damage, page.fill?.damageType);
  if (!parsed.ok) return [];
  const rolled = rollsOf(lines);
  let i = 0;
  return parsed.parts.map((p) => ("formula" in p ? rolled[i++]?.total : undefined));
}

/**
 * Whatever the page sent under this tag, settled by its receipt: a server
 * roll, the damage line, the DM's one tap on an asked row, or the plan. The
 * page applies each to the newest page, so two receipts that land together
 * both stay settled, and a reload settles what it sent before.
 */
export function settleTag(page: Page, tag: string, settled: Settled, key: (t: { tokenId?: string; characterId?: string }) => string): Page {
  if (page.rolls.some((r) => r.tag === tag)) return rollSettled(page, tag, settled, key);
  if (page.damage?.tag === tag) {
    return damageSettled(page, tag, settled.state === "committed" ? { state: "committed", amounts: damageAmounts(page, settled.lines) } : settled.state === "refused" ? { state: "refused", says: settled.says } : { state: "unknown" });
  }
  if (page.dmRolls.some((r) => r.tag === tag)) {
    const says = settled.state === "refused" ? (settled.message === ANSWERED_MEANWHILE ? "Answered before your roll." : settled.says) : undefined;
    return dmRollSettled(page, tag, settled.state, says);
  }
  if (page.plan?.plan === tag) {
    if (settled.state === "refused" && settled.message === ASK_CLOSED && page.cast) return applySettled(page, { state: "refused", says: closedMeanwhile(page.cast) });
    return applySettled(page, settled.state === "committed" ? { state: "committed" } : settled);
  }
  return page;
}

/** The tags the page waits on a receipt for: its rolls, its damage line, the DM's taps and the plan, as Watchers mounts one each. */
export function waitingTags(page: Page): string[] {
  const out = [...page.rolls.filter((r) => r.state === "sending").map((r) => r.tag), ...page.dmRolls.filter((r) => r.state === "sending").map((r) => r.tag)];
  if (page.damage?.state === "sending") out.push(page.damage.tag);
  if (page.plan && (page.apply === "sending" || page.apply === "unknown")) out.push(page.plan.plan);
  return out;
}

export function mark(page: Page, holder: string, value: Mark | null): Page {
  if (page.phase === "applying" || page.phase === "applied") return page;
  const s = page.states[holder] ?? (rowOf(page, holder) ? stateOf(page, rowOf(page, holder)!) : undefined);
  if (!s) return page;
  const { mark: _mark, ...rest } = s;
  return { ...page, states: { ...page.states, [holder]: value ? { ...rest, mark: value } : rest } };
}

export function typeTotal(page: Page, holder: string, total: number | null): Page {
  if (page.phase === "applying" || page.phase === "applied") return page;
  const row = rowOf(page, holder);
  const s = page.states[holder] ?? (row ? stateOf(page, row) : undefined);
  if (!s) return page;
  const { typed: _typed, ...rest } = s;
  return { ...page, states: { ...page.states, [holder]: total === null ? rest : { ...rest, typed: total } } };
}

/** A row's damage as the DM types it (5.4), which wins over what the outcome works out. Null goes back to the worked-out amount. */
export function setAmount(page: Page, holder: string, amount: number | string | null): Page {
  if (page.phase === "applying" || page.phase === "applied") return page;
  const row = rowOf(page, holder);
  const s = page.states[holder] ?? (row ? stateOf(page, row) : undefined);
  if (!s) return page;
  const { amount: _amount, ...rest } = s;
  return { ...page, states: { ...page.states, [holder]: amount === null || (typeof amount === "string" && amount.trim() === "") ? rest : { ...rest, amount } } };
}

/** A changed DC judges every total again at once and never a mark (5.3). */
export function setDc(page: Page, dc: number | null): Page {
  if (page.phase === "applying" || page.phase === "applied") return page;
  return { ...page, dc };
}

/** The damage line (5.4): rolled once on the server, Roll again replacing it until Apply. */
export function damageSent(page: Page, tag: string): Page {
  if (page.phase === "applying" || page.phase === "applied") return page;
  return { ...page, damage: { tag, state: "sending" } };
}

export function damageSettled(page: Page, tag: string, settled: { state: "committed"; amounts: (number | undefined)[] } | { state: "refused"; says: string } | { state: "unknown" }): Page {
  if (page.damage?.tag !== tag || page.damage.state !== "sending") return page;
  return { ...page, damage: { tag, state: settled.state, ...(settled.state === "committed" ? { amounts: settled.amounts } : {}), ...(settled.state === "refused" ? { says: settled.says } : {}) } };
}

/**
 * Apply (5.5): the frozen plan, sent after the page's open requests are
 * closed, alone, so the outcome is the newest undo step. The plan's id is
 * its receipt's tag. Refused leaves the rows as they were, and Apply
 * builds a new plan next time.
 */
export function apply(page: Page, plan: OpOf<"actor.outcome">): Step {
  if (page.phase !== "rolled" && !(page.phase === "setup" && page.test.kind === "none")) return { page, send: [] };
  if (page.apply === "sending" || page.apply === "unknown" || page.apply === "taken") return { page, send: [] };
  // An ask resolved elsewhere, or closed with an end the page cannot read, is never applied (docs/design-v1-player-save-spell.md 3.3).
  if (page.cast?.blocked) return { page, send: [], error: page.cast.blocked };
  // The plan closes the ask the page holds now, and only that one, so a page that let its ask go closes none.
  const { cast: _built, ...rest } = plan;
  const op: OpOf<"actor.outcome"> = page.cast ? { ...rest, cast: page.cast.ask.id } : rest;
  const open = page.requests.filter((r) => r.state === "open" || r.state === "sending").map((r) => r.rollId);
  const send: Command[] = [];
  if (open.length > 0) send.push({ kind: "op", op: { t: "roll.close", rollIds: open } });
  send.push({ kind: "outcome", op });
  return { page: { ...page, phase: "applying", plan: op, apply: "sending", requests: page.requests.map((r) => (open.includes(r.rollId) ? { ...r, state: "closed" } : r)) }, send };
}

export function applySettled(page: Page, settled: { state: "committed" } | { state: "refused"; says: string } | { state: "unknown" }): Page {
  if (page.phase !== "applying" || (page.apply !== "sending" && page.apply !== "unknown")) return page;
  if (settled.state === "committed") return { ...page, phase: "applied", apply: "taken" };
  if (settled.state === "refused") return { ...page, phase: "rolled", apply: "refused", applySays: settled.says, plan: null };
  return { ...page, apply: "unknown" };
}

/** When a UUIDv7 was made: its first 48 bits are its millisecond time (shared/ids.ts). */
function madeAt(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/**
 * Whether Apply again is offered (5.5): only while the plan is younger than
 * a pending op may be (doc 1 1.2), so a resend always falls inside the 24
 * hours the server answers a duplicate tag from its receipt.
 */
export function mayApplyAgain(page: Page, now: number): boolean {
  return page.phase === "applying" && page.apply === "unknown" && page.plan !== null && now - madeAt(page.plan.plan) < MAX_OP_AGE_MS;
}

/** Apply again (5.5): only from unknown, the same frozen plan under the same tag, which the server applies at most once. */
export function applyAgain(page: Page, now: number = Date.now()): Step {
  if (!mayApplyAgain(page, now)) return { page, send: [] };
  return { page: { ...page, apply: "sending" }, send: [{ kind: "outcome", op: page.plan! }] };
}

// ------------------------------------------------------------ a player's ask (docs/design-v1-player-save-spell.md 3.3)

/** Apply's refusal when the ask closed before the outcome landed: "Thorn's ask was closed meanwhile." */
export function closedMeanwhile(cast: Pick<PageCast, "who">): string {
  return `${cast.who}'s ask was closed meanwhile.`;
}

export const RESOLVED_ELSEWHERE = "Resolved on another device.";
export const CLOSED_UNREAD = "This ask was closed. Check the log.";

/**
 * Close the ask: where Apply would change nothing (Hold Person, and every
 * creature passed), the page's open requests close, then the ask closes as
 * done, and the page settles as Applied does. From an unknown close it
 * sends the same close again, which the server refuses as closed if the
 * first one landed, so the ask never closes twice.
 */
export function closeTheAsk(page: Page): Step {
  const cast = page.cast;
  if (!cast) return { page, send: [] };
  if (cast.blocked) return { page, send: [], error: cast.blocked };
  const again = page.phase === "applying" && page.apply === "unknown" && cast.closing !== undefined;
  if (!again && (page.phase === "applying" || page.phase === "applied" || page.apply === "sending" || page.apply === "unknown")) return { page, send: [] };
  if (!again && page.phase === "setup" && page.test.kind !== "none") return { page, send: [] };
  const open = page.requests.filter((r) => r.state === "open" || r.state === "sending").map((r) => r.rollId);
  const send: Command[] = [];
  if (open.length > 0) send.push({ kind: "op", op: { t: "roll.close", rollIds: open } });
  send.push({ kind: "op", op: { t: "cast.close", castId: cast.ask.id, end: "done" } });
  const from = again ? cast.closing! : (page.phase as "setup" | "rolled");
  return {
    page: { ...page, phase: "applying", apply: "sending", plan: null, cast: { ...cast, closing: from }, requests: page.requests.map((r) => (open.includes(r.rollId) ? { ...r, state: "closed" } : r)) },
    send,
  };
}

/** The close's answer: taken settles the page as Applied, refused goes back with the words, unknown waits for the view or Close the ask again. */
export function closeSettled(page: Page, settled: { state: "taken" } | { state: "refused"; says: string; message?: string } | { state: "unknown" }): Page {
  const cast = page.cast;
  if (!cast?.closing || page.phase !== "applying" || (page.apply !== "sending" && page.apply !== "unknown")) return page;
  if (settled.state === "taken") return { ...page, phase: "applied", apply: "taken" };
  if (settled.state === "refused") {
    const { closing, ...kept } = cast;
    return { ...page, phase: closing, apply: "refused", applySays: settled.message === ASK_CLOSED ? closedMeanwhile(cast) : settled.says, cast: kept };
  }
  return { ...page, apply: "unknown" };
}

/**
 * A reload loses a close's answer, which has no receipt to read, so a
 * close on its way reads as unknown: the view then settles it, or the DM
 * closes it again.
 */
export function restoredPage(page: Page): Page {
  return page.cast?.closing && page.phase === "applying" && page.apply === "sending" ? { ...page, apply: "unknown" } : page;
}

/**
 * The page's ask as the view holds it (3.3). While it waits nothing
 * changes, and an ask the DM's undo brought back frees Apply again. Once
 * it is gone the page reads its end from the closing line: a withdrawal or
 * a dismissal lets the ask go and Apply works as a plain group save, a
 * resolve elsewhere or an end the page cannot read (its line pruned while
 * the device was away) disables Apply with the reason, and Discard is the
 * way out. A close or an Apply of this page's own still on its way is
 * left to its answer, and an unknown close of its own that the view shows
 * done settles the page as Applied.
 */
export function castSeen(page: Page, seen: { present: true } | { present: false; end: CastEnd | null }): Page {
  const cast = page.cast;
  if (!cast || page.phase === "applied") return page;
  if (seen.present) {
    if (!cast.blocked) return page;
    const { blocked: _blocked, ...free } = cast;
    return { ...page, cast: free };
  }
  const closing = cast.closing;
  // An Apply or a close of the page's own on its way settles by its answer. Only an unknown close is the view's to settle.
  if (page.phase === "applying" && (closing === undefined || page.apply === "sending")) return page;
  if (seen.end === "withdrawn" || seen.end === "dismissed") {
    const { cast: _cast, ...rest } = page;
    const back: Partial<Page> = closing !== undefined ? { phase: closing, apply: "idle" } : {};
    return { ...rest, ...back, castNote: seen.end === "withdrawn" ? `${cast.who} withdrew the ask.` : "Another DM set it aside." };
  }
  if (closing !== undefined) return { ...page, phase: "applied", apply: "taken" };
  const blocked = seen.end === "done" ? RESOLVED_ELSEWHERE : CLOSED_UNREAD;
  return cast.blocked === blocked ? page : { ...page, cast: { ...cast, blocked } };
}

/** The end of an ask as the view's log reads it: its closing line's, or null when that line is gone. */
export function castEndOf(log: readonly LogEntry[], castId: string): CastEnd | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const data = log[i]!.data;
    if (data?.type === "cast" && data.castId === castId && data.end !== undefined) return data.end;
  }
  return null;
}

/** Discard (5.1): closes the requests the page opened, if open, and nothing else. */
export function discard(page: Page): Command[] {
  if (page.phase === "applying") return [];
  const open = page.requests.filter((r) => r.state === "open" || r.state === "sending").map((r) => r.rollId);
  return open.length > 0 ? [{ kind: "op", op: { t: "roll.close", rollIds: open } }] : [];
}

/**
 * A new group save in place of this one (5.1): the old one's requests close
 * as Discard closes them, so no player is left asked and no open place is
 * spent. A page Applying is never replaced, since its outcome may still land.
 */
export function replace(old: Page | null): { ok: true; send: Command[] } | { ok: false; error: string } {
  if (!old) return { ok: true, send: [] };
  if (old.phase === "applying") return { ok: false, error: APPLYING };
  return { ok: true, send: discard(old) };
}

export const APPLYING = "The open group save is applying. Wait for it to finish.";

/**
 * Creatures the view no longer holds: after the roll their rows hold, and Apply leaves them out.
 * The view holds only the scene on screen, so with the DM on another scene a missing token says
 * nothing about whether it was deleted, and every row keeps what it had.
 */
export function markGone(page: Page, viewing: string | null, present: (row: RowBase) => boolean): Page {
  if (page.sceneId !== viewing) return page;
  let next = page;
  for (const row of page.rows) {
    const gone = !present(row);
    const s = next.states[row.holder];
    if ((s?.gone ?? false) === gone) continue;
    next = withState(next, row.holder, { gone }, row);
  }
  return next;
}

// ------------------------------------------------------------ the draft (5.10)

function draftKey(roomId: string): string {
  return `rvtt.groupSave.${roomId}`;
}

export function readDraft(roomId: string): Page | null {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(draftKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Page;
    return parsed && typeof parsed === "object" && typeof parsed.id === "string" && Array.isArray(parsed.rows) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDraft(roomId: string, page: Page | null): void {
  try {
    if (page) sessionStorage.setItem(draftKey(roomId), JSON.stringify(page));
    else sessionStorage.removeItem(draftKey(roomId));
  } catch {
    // Storage blocked or full: the page lasts until it closes.
  }
}
