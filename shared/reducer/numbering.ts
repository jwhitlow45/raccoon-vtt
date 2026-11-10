import { keys, parseKey, type EntityKey } from "../keys.ts";
import { NUMBERING_OP_VERSION } from "../migrate.ts";
import type { RoomState, Scene, Token, Viewer } from "../model.ts";
import { NUMBER_NAMES_MOST, NUMBERS_MOST, memberOf, numberable, numberScope, numbersOf, shownName } from "../numbering.ts";
import { partyHolds } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { ownEntry } from "../records.ts";
import { onPlayersScene } from "../rules/floors.ts";
import { Tx, type Env } from "./tx.ts";

/*
 * Creature numbers the table gives (shared/numbering.ts) as the room
 * changes: the creatures a batch's end meets, the three rules `sys.meet`
 * applies to each, a restore's reconciling of a creature's mark, and the
 * upgrade that settles an older room's numbers once. The step and the
 * upgrade share the candidates' rules and the meeting rules, so the two
 * never number apart.
 */

/** The upgrade writes as the server's bookkeeping does, never as a member. */
const UPGRADE_ACTOR: Viewer = { memberId: "server", role: "dm" };

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The creatures a batch's end meets, in id order: (a) each numberable
 * creature the party's copy holds that is no member of its shown name's
 * group, and (b) each numberable member with no number while its name has
 * given two or more. A creature of (a) whose name could take no entry or no
 * number is left out, since the caps bind new entries and new numbers
 * alone. One of (b) never is: its 1 was owed when the second was met.
 *
 * Only the players' scene holds creatures of (a), and every creature
 * there is judged. Members of (b) elsewhere are looked for among the
 * creatures the batch touched, and among every creature when it touched a
 * member or a character, which can make a creature numberable without
 * touching it (shared/players.ts playersToken).
 */
export function meetCandidates(state: RoomState, touched: readonly EntityKey[], env: Pick<Env, "opVersion">): string[] {
  const holds = partyHolds(state, env);
  const meets = state.meta.playerSceneId !== null && state.meta.view?.blackout !== true;
  const found = new Set<string>();
  const namesMet = new Map<string, number>();
  const judge = (token: Token) => {
    if (found.has(token.id) || !numberable(state, token)) return;
    const scopeId = numberScope(state, token);
    const names = numbersOf(state, scopeId);
    const entry = ownEntry(names, shownName(token));
    if (entry !== undefined && token.met === entry[0]) {
      if (token.number === undefined && entry[1] >= 2) found.add(token.id);
      return;
    }
    if (!meets || !onPlayersScene(state, token.sceneId)) return;
    let met = namesMet.get(scopeId);
    if (met === undefined) namesMet.set(scopeId, (met = Object.keys(names).length));
    const fits = entry === undefined ? met < NUMBER_NAMES_MOST : entry[1] < NUMBERS_MOST;
    if (fits && holds(token)) found.add(token.id);
  };
  const everyone = touched.some((key) => {
    const kind = parseKey(key)?.kind;
    return kind === "member" || kind === "character";
  });
  for (const token of Object.values(state.tokens)) {
    if (token.kind !== "monster" && token.kind !== "npc") continue;
    if (everyone || (meets && onPlayersScene(state, token.sceneId))) judge(token);
  }
  if (!everyone) {
    for (const key of touched) {
      const parsed = parseKey(key);
      const token = parsed?.kind === "token" ? ownEntry(state.tokens, parsed.id) : undefined;
      if (token) judge(token);
    }
  }
  return [...found].sort();
}

/** `sys.meet`: each creature named, in order, by the meeting rules, skipping any the room no longer fits. */
export function sysMeet(tx: Tx, op: OpOf<"sys.meet">): void {
  for (const id of op.tokenIds) meet(tx, id);
}

/**
 * The meeting rules for one creature, on the state as the meetings before
 * it left it. Every write of `met` or `number` lands on a creature that is
 * numberable then, and only rule 1 makes a member without a number.
 *
 * 1. Its shown name has no entry on its scene: the name takes the room's
 *    next group id with one given, and the creature that group's mark and
 *    no number, so a creature met alone reads plain.
 * 2. An entry, and it is no member: the name gives its next number to it.
 *    When that number is 2, the group's member with no number, if it still
 *    stands on the scene and is numberable, takes 1.
 * 3. A member with no number while the name has given two or more: 1.
 */
export function meet(tx: Tx, tokenId: string): void {
  const token = ownEntry(tx.state.tokens, tokenId);
  if (!token || !numberable(tx.state, token)) return;
  const scope = ownEntry(tx.state.scenes, numberScope(tx.state, token));
  if (!scope) return;
  const name = shownName(token);
  const names = scope.numbers?.names ?? {};
  const entry = ownEntry(names, name);
  if (entry === undefined) {
    if (Object.keys(names).length >= NUMBER_NAMES_MOST) return;
    const g = newGroup(tx);
    writeEntry(tx, scope, name, [g, 1]);
    const { number: _old, ...rest } = token;
    tx.write(keys.token(token.id), { ...rest, met: g });
    return;
  }
  const [g, n] = entry;
  if (token.met !== g) {
    if (n >= NUMBERS_MOST) return;
    writeEntry(tx, scope, name, [g, n + 1]);
    tx.write(keys.token(token.id), { ...token, met: g, number: n + 1 });
    if (n + 1 === 2) firstTakesOne(tx, scope.id, g, token.id);
    return;
  }
  if (token.number === undefined && n >= 2) tx.write(keys.token(token.id), { ...token, number: 1 });
}

/** The room's next group id, taken: the count only goes up, so no id is used twice in the room. */
function newGroup(tx: Tx): number {
  const count = tx.state.numbering;
  const g = (count?.groups ?? 0) + 1;
  tx.write(keys.numbering, { rev: count?.rev ?? 0, groups: g });
  return g;
}

function writeEntry(tx: Tx, scope: Scene, name: string, entry: [number, number]): void {
  const names = { ...(scope.numbers?.names ?? {}), [name]: entry };
  tx.write(keys.scene(scope.id), { ...scope, numbers: { names } });
}

/** Rule 2's 1: the member of group `g` on the scene with no number, other than the one just met, while it is numberable. */
function firstTakesOne(tx: Tx, scopeId: string, g: number, metId: string): void {
  for (const other of Object.values(tx.state.tokens).sort(byId)) {
    if (other.id === metId || other.met !== g || other.number !== undefined) continue;
    if (numberScope(tx.state, other) !== scopeId || !memberOf(tx.state, other) || !numberable(tx.state, other)) continue;
    tx.write(keys.token(other.id), { ...other, number: 1 });
    return;
  }
}

/**
 * A restored creature's mark and number (docs: undo and redo are exact).
 * When the stored mark makes the stored value a member, of its scene's
 * group for its shown name, it takes that mark, and the stored number
 * unless the creature now is in that same group, whose number since is the
 * truth. Otherwise it keeps what it has now, or with nothing now what was
 * stored. So undoing a rename gives back "Goblin 2", a redo the number the
 * rename was met with, and no number repeats, since a group never gives
 * one twice. `scenes` are the scenes as the restore leaves them.
 */
export function keepNumbering(scenes: Pick<RoomState, "scenes">, stored: Token, current: Token | undefined): Token {
  let met: number | undefined;
  let number: number | undefined;
  if (stored.met !== undefined && memberOf(scenes, stored)) {
    met = stored.met;
    number = current !== undefined && current.met === stored.met ? current.number : stored.number;
  } else if (current !== undefined) {
    met = current.met;
    number = current.number;
  } else return stored;
  if (met === stored.met && number === stored.number) return stored;
  const { met: _met, number: _number, ...rest } = stored;
  return { ...rest, ...(met !== undefined ? { met } : {}), ...(number !== undefined ? { number } : {}) } as Token;
}

/**
 * The numbering upgrade: an older room's numbers settled once, on the
 * scene players see and only with no blackout on. Each numberable
 * creature the party's copy holds with a number players were shown (its
 * name not hidden) keeps it as a member of its name's group, the name
 * counting to its highest kept number. Of two with one number the lower id
 * keeps it. At most NUMBER_NAMES_MOST names are kept, names in the id
 * order of their lowest creature the party holds. Every other numberable
 * creature the party holds is then met by the rules, in id order, so names
 * met alone follow in the same order until the scene's register is full.
 * Every other old number counts for nothing from here (memberOf).
 *
 * A pure function of the state that reads sight by the rules of the op
 * version that brought it, so a reload before the next snapshot settles
 * the same numbers. Loading runs it where the map discovery upgrade runs
 * (server/rooms/persistence.ts), and an import after the file's migration.
 */
export function numberingUpgrade(state: RoomState): RoomState {
  if (state.meta.playerSceneId === null || state.meta.view?.blackout === true) return state;
  const holds = partyHolds(state, { opVersion: NUMBERING_OP_VERSION });
  const held = Object.values(state.tokens).filter((t) => numberable(state, t) && holds(t)).sort(byId);
  if (held.length === 0) return state;
  const tx = new Tx(state, UPGRADE_ACTOR, { seq: 0, at: new Date(0).toISOString(), opVersion: NUMBERING_OP_VERSION, uncounted: true });
  const lowest = new Map<string, string>();
  const shown = new Map<string, Token[]>();
  for (const token of held) {
    const name = shownName(token);
    if (!lowest.has(name)) lowest.set(name, token.id);
    if (token.number === undefined || token.nameHidden === true) continue;
    const list = shown.get(name);
    if (list) list.push(token);
    else shown.set(name, [token]);
  }
  const kept = [...shown.keys()].sort((a, b) => byId({ id: lowest.get(a)! }, { id: lowest.get(b)! })).slice(0, NUMBER_NAMES_MOST);
  for (const name of kept) {
    const g = newGroup(tx);
    const given = new Set<number>();
    for (const token of shown.get(name)!) {
      if (given.has(token.number!)) continue;
      given.add(token.number!);
      tx.write(keys.token(token.id), { ...tx.token(token.id), met: g });
    }
    const scope = tx.scene(numberScope(tx.state, shown.get(name)![0]!));
    writeEntry(tx, scope, name, [g, Math.max(...given)]);
  }
  for (const token of held) meet(tx, token.id);
  tx.finish();
  return tx.state;
}
