import type { Actor, CompanionBlock, CreatureSize, ImageRef, MonsterSize, RoomState, Token } from "#shared/model.ts";
import type { ActorPatch, ClientOp, TokenPatch } from "#shared/protocol.ts";
import { fitLine, type SrdMonster, type StatBlockMonster } from "#shared/srd/monsters.ts";
import { signed, sizeAndType } from "#shared/statBlock.ts";
import type { OnAnswer, OpAnswer, OpRefusal } from "../../state/types.ts";
import { viewOf } from "../monsters/draft.ts";
import type { ListedRow } from "../monsters/MonsterList.tsx";
import { attachPatch, nameSuggestions, type BlockLink } from "../monsters/statBlockLink.ts";
import { canResize } from "./access.ts";
import { monsterMatcher } from "./monsterSearch.ts";
import { resizePatch } from "./resize.ts";
import type { Growth } from "./resizeMemory.ts";

/**
 * Companion stat blocks as the picker, the numbers step and the stat
 * blocks page build them (docs/design-v1-companion-stat-blocks.md 5 and
 * 6), as plain functions for node --test. Every block a companion can link
 * is read in the SRD monsters' shape, a stored one through `monsterView`,
 * so an SRD block and a pasted one go through one path.
 */

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** "Bree's", the tag a character's own blocks carry in a list, and the owner the text names them by. */
export function whose(name: string): string {
  return `${name}’s`;
}

/**
 * An SRD monster's name from its slug, "dire-wolf" read as "Dire Wolf", for
 * lists that should not load the SRD chunk to name a link. The slug stands
 * in for the printed name, which it nearly always matches.
 */
export function srdTitle(srdId: string): string {
  return srdId
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A character's blocks this device holds, by name. */
export function characterBlocks(view: Pick<RoomState, "companionBlocks"> | null | undefined, characterId: string): CompanionBlock[] {
  return Object.values(view?.companionBlocks ?? {})
    .filter((b): b is CompanionBlock => !!b && b.characterId === characterId)
    .sort((a, b) => byName(a, b) || (a.id < b.id ? -1 : 1));
}

/** A row of the companion picker: a character's block or an SRD monster, with what it links. */
/** `picture` is a stored block's own, carried with the row so whoever takes the row never looks the block up in a collection that may be older than it. */
export type PickerRow = ListedRow & { link: BlockLink; source: "block" | "srd"; picture?: ImageRef };

/** A character's block as a list row, tagged with whose it is. */
export function blockRow(block: CompanionBlock, characterName: string): PickerRow {
  return { key: `block:${block.id}`, source: "block", view: viewOf(block), tag: whose(characterName), link: { blockId: block.id }, ...(block.defaultImage ? { picture: block.defaultImage } : {}) };
}

/** A block's second line in a character's list: "Small Fey, CR 1/4", or "Medium, CR 0" with no creature type. */
export function blockDetail(block: Pick<CompanionBlock, "size" | "type" | "cr">): string {
  return `${sizeAndType(block)}, CR ${block.cr}`;
}

/** An SRD monster as a list row. */
export function srdRow(m: SrdMonster): PickerRow {
  return { key: `srd:${m.srdId}`, source: "srd", view: m, link: { srdId: m.srdId } };
}

export type PickerLists = {
  /** The character's own blocks, searched. */
  own: PickerRow[];
  /** How many blocks the character keeps, searched or not. */
  ownCount: number;
  /** The character's and the SRD's of exactly the companion's name, searched. */
  sameName: PickerRow[];
  srd: PickerRow[];
};

/**
 * The companion picker's lists (section 6.1): the character's blocks, those
 * of exactly the companion's name, and the SRD's, each narrowed by the
 * Monsters panel's search. No room monster is among them, for the DM
 * either: every block it offers is one the companion's players read.
 */
export function pickerLists(input: { name: string; query: string; blocks: readonly CompanionBlock[]; characterName: string; srd: readonly SrdMonster[] | null }): PickerLists {
  const matches = monsterMatcher(input.query);
  const own = input.blocks.map((b) => blockRow(b, input.characterName));
  const byKey = new Map(own.map((r) => [r.key, r]));
  const sameName = nameSuggestions(input.name, own, input.srd ?? []).map((s) => byKey.get(s.key) ?? { key: s.key, view: s.view, source: "srd" as const, link: s.link });
  return {
    own: own.filter((r) => matches(r.view)),
    ownCount: own.length,
    sameName: sameName.filter((r) => matches(r.view)),
    srd: (input.srd ?? []).map(srdRow).filter((r) => matches(r.view)),
  };
}

/** A count for a list's label: "(3)", or "(1 of 3)" while a search narrows it. */
export function countLabel(shown: number, total: number): string {
  return shown === total ? `(${total})` : `(${shown} of ${total})`;
}

const SIZE_WORDS: Record<MonsterSize, string> = { tiny: "Tiny", small: "Small", medium: "Medium", large: "Large", huge: "Huge", gargantuan: "Gargantuan" };

/** Speeds as the numbers step and the add form say them: "5 ft, fly 60 ft (hover)", the walk first. */
export function speedText(speeds: Actor["speeds"]): string {
  const parts = [`${speeds.walk} ft`];
  for (const kind of ["burrow", "climb", "fly", "swim"] as const) {
    const feet = speeds[kind];
    if (feet !== undefined) parts.push(`${kind} ${feet} ft${kind === "fly" && speeds.hover ? " (hover)" : ""}`);
  }
  return parts.join(", ");
}

function sameSpeeds(a: Actor["speeds"] | undefined, b: Actor["speeds"]): boolean {
  if (!a) return false;
  return a.walk === b.walk && a.fly === b.fly && a.swim === b.swim && a.climb === b.climb && a.burrow === b.burrow && (a.hover ?? false) === (b.hover ?? false);
}

/** A senses line as said in a sentence, without the full stop it may be printed with. */
function sensesText(senses: string): string {
  return senses.trim().replace(/\.$/, "");
}

/** "From the block: speed 5 ft, fly 60 ft. Darkvision 120 ft. Passive Perception 15. Initiative +1.", what the add form takes besides its fields. */
export function fromTheBlock(view: StatBlockMonster): string {
  const senses = sensesText(fitLine(view.senses));
  return `From the block: speed ${speedText(view.speeds)}.${senses ? ` ${senses}.` : ""} Passive Perception ${view.passivePerception}. Initiative ${signed(view.initiative.bonus)}.`;
}

/** The max HP the numbers step sets: the block's average, a number typed, or the one it has. */
export type HpChoice = { kind: "average" } | { kind: "typed"; value: number | null } | { kind: "keep" };

export type BlockNumbers = {
  /** Every number but the size, for the attach's one `token.update` beside the link. Empty for "Keep". */
  patch: ActorPatch;
  /** One line per number that changes, the new value and the current one, such as "AC 13, now 11". */
  lines: string[];
  /** The block's first size, which the attach's resize sets. */
  size: MonsterSize;
  /** The block's average HP, offered only when it is at least 1. */
  average: number | null;
  /** The new maximum, or null when no max HP is set (Keep, or no number typed yet). */
  max: number | null;
  /** What happens to the companion's current HP, such as "Hoot is unhurt, so it stays at full HP: 11 of 11." */
  hpLine: string;
};

/**
 * The numbers a block sets on a creature companion (section 5.1), and the
 * lines that say so before anything is sent. The size is not in the patch:
 * it goes as a resize of its own once the link is taken. Never the
 * initiative score, type, CR, XP, legendary uses or the DM's notes, which
 * stay the DM's.
 *
 * Current HP follows one rule (5.2): attaching never brings a creature back
 * or puts it down. A living creature at its maximum stays at its maximum,
 * and any other gets the new maximum alone, its HP cut to it if higher.
 */
export function blockNumbers(view: StatBlockMonster, token: Pick<Token, "name">, actor: Partial<Actor> | undefined, hp: HpChoice): BlockNumbers {
  const patch: ActorPatch = {};
  const lines: string[] = [];
  const name = token.name;
  if (view.ac !== actor?.ac) {
    patch.ac = view.ac;
    lines.push(actor?.ac === undefined ? `AC ${view.ac}` : `AC ${view.ac}, now ${actor.ac}`);
  }
  if (!sameSpeeds(actor?.speeds, view.speeds)) {
    patch.speeds = { ...view.speeds };
    lines.push(actor?.speeds ? `Speed ${speedText(view.speeds)}, now ${speedText(actor.speeds)}` : `Speed ${speedText(view.speeds)}`);
  }
  const senses = fitLine(view.senses);
  if (senses !== (actor?.senses ?? "")) {
    patch.senses = senses;
    lines.push(`${sensesText(senses) || "No special senses"}, now ${sensesText(actor?.senses ?? "") || "none"}`);
  }
  if (view.passivePerception !== actor?.passivePerception) {
    patch.passivePerception = view.passivePerception;
    lines.push(`Passive Perception ${view.passivePerception}${actor?.passivePerception === undefined ? "" : `, now ${actor.passivePerception}`}`);
  }
  if (view.initiative.bonus !== actor?.initBonus) {
    patch.initBonus = view.initiative.bonus;
    lines.push(`Initiative ${signed(view.initiative.bonus)}${actor?.initBonus === undefined ? "" : `, now ${signed(actor.initBonus)}`}`);
  }
  const average = view.hp.average >= 1 ? view.hp.average : null;
  const now = actor?.hp;
  const max = hp.kind === "average" ? average : hp.kind === "typed" ? hp.value : (now?.max ?? null);
  let hpLine = "";
  if (max !== null && max >= 1 && now) {
    const full = actor?.life === "alive" && now.cur === now.max;
    if (full) {
      if (max !== now.max) patch.hp = { max, cur: max };
      hpLine = `${name} is unhurt, so it stays at full HP: ${max} of ${max}.`;
    } else {
      if (max !== now.max) patch.hp = { max };
      const cur = Math.min(now.cur, max);
      hpLine =
        actor?.life === "dead"
          ? `${name} is dead and stays so: ${cur} of ${max}.`
          : actor?.life === "dying" || actor?.life === "stable"
            ? `${name} is ${actor.life} and stays so: ${cur} of ${max}.`
            : cur < now.cur
              ? `${name}’s HP is cut to its new maximum: ${cur} of ${max}.`
              : `${name} keeps its ${cur} HP, now of ${max}.`;
    }
  }
  return { patch, lines, size: view.size, average, max: max !== null && max >= 1 ? max : null, hpLine };
}

/**
 * The attach's one `token.update` of the actor: the link and, with "Use
 * Owl's numbers", every number but the size. "Keep Hoot's numbers" sends
 * the link alone. The link names only the field it sets, so it clears any
 * other link, a room monster's the player never sees included.
 */
export function attachActorPatch(link: BlockLink, use: boolean, numbers: Pick<BlockNumbers, "patch">): ActorPatch {
  return { ...attachPatch(link), ...(use ? numbers.patch : {}) };
}

/** The size the block gives, as the Size line names it. */
export function sizeWord(size: MonsterSize): string {
  return SIZE_WORDS[size];
}

/** The words of the attach's refusal, the server's, as a line of the step. */
export function refusalLine(refusal: Pick<OpRefusal, "message"> | undefined, fallback: string): string {
  const text = refusal?.message.trim();
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}` : fallback;
}

/** The step's line when the connection dropped before the server answered the attach. */
export function attachUnknownLine(companion: string): string {
  return `The connection dropped before the server answered. Check ${companion}’s panel before attaching again.`;
}

/**
 * The toast for an attach answered after its dialog closed: none when it
 * was taken with nothing left to send, since the panel shows the block, the
 * size it kept when a resize was still to follow (no resize goes once the
 * dialog is gone), and the server's words when it was refused.
 */
export function lateAttachText(block: string, companion: string, answer: OpAnswer, refusal?: Pick<OpRefusal, "message">, keptSize?: CreatureSize): string | null {
  if (answer === "taken") return keptSize ? `${block} is attached to ${companion}. Its size stayed ${SIZE_WORD_ANY[keptSize]}.` : null;
  if (answer === "unknown") return `The connection dropped before the server answered, so ${block} may not be attached to ${companion}. Check ${companion}’s panel.`;
  const why = refusal?.message.trim().replace(/\.$/, "");
  return why ? `${block} was not attached to ${companion}. ${why[0]!.toUpperCase()}${why.slice(1)}.` : `${block} was not attached to ${companion}.`;
}

const SIZE_WORD_ANY: Record<CreatureSize, string> = { ...SIZE_WORDS, custom: "Custom" };

/**
 * What the numbers step does with the block's size (section 5.1), from the
 * view as it stands: nothing, when the numbers are kept or the size is the
 * same; a resize, built by the token window's `resizePatch` and judged by
 * the same rule as any resize, with whether it moves to clear a wall; or
 * why the size stays (a lock, a size the DM set, or no room to grow). The
 * DM's resize is never checked, so the DM's line shows no shift and no
 * refusal. `line` is the Size line under the size row.
 */
export type SizePlan =
  | { kind: "none" }
  | { kind: "resize"; line: string; patch: TokenPatch; growths: Growth[] }
  | { kind: "kept"; line: string };

export function sizePlan(input: {
  view: Pick<RoomState, "scenes" | "buildChunks">;
  token: Token;
  size: MonsterSize;
  use: boolean;
  role: "dm" | "player";
  owner: boolean;
  growths: readonly Growth[];
}): SizePlan {
  const { token, size, role } = input;
  if (!input.use || token.size === size) return { kind: "none" };
  const head = `Size ${SIZE_WORDS[size]}`;
  const now = `, now ${SIZE_WORD_ANY[token.size]}`;
  const dm = role === "dm";
  if (!canResize({ dm, owner: input.owner }, token)) {
    if (token.locked) return { kind: "kept", line: `${head}: ${token.name} is locked, so its size stays. Ask the DM.` };
    return { kind: "kept", line: `${head}: ${token.name}’s size is the DM’s to change, so it stays. Ask the DM.` };
  }
  const answer = resizePatch(input.view, token, { size }, role, input.growths);
  if ("refused" in answer) return { kind: "kept", line: `${head}${now}. ${answer.refused.replace(/\.$/, "")}: ${token.name} keeps its size.` };
  const shift = answer.shifted && !dm ? " It moves a little to clear the wall." : "";
  return { kind: "resize", line: `${head}${now}.${shift}`, patch: answer.patch, growths: answer.growths };
}

/**
 * Where the attach dialog stands once a block is picked (section 5.1):
 * choosing the numbers, waiting for the link's answer, refused with the
 * server's words, unknown, resizing after the link was taken, the size
 * kept or refused after it (the link and numbers applied, the footer's
 * Attach become Done), or done.
 */
export type AttachPhase =
  | { phase: "ready" }
  | { phase: "linking" }
  | { phase: "refused"; line: string }
  | { phase: "unknown"; line: string }
  | { phase: "resizing" }
  | { phase: "sizeStopped"; line: string }
  | { phase: "done" };

/** The step after the link's answer, while the dialog is still open. */
export function afterLinkAnswer(answer: OpAnswer, companion: string, refusal?: Pick<OpRefusal, "message">): AttachPhase {
  if (answer === "taken") return { phase: "done" };
  if (answer === "refused") return { phase: "refused", line: refusalLine(refusal, "The server refused it.") };
  return { phase: "unknown", line: attachUnknownLine(companion) };
}

/** The step after the resize's answer, while the dialog is still open: done, or the size line in the server's words. */
export function afterResizeAnswer(answer: OpAnswer, companion: string, refusal?: Pick<OpRefusal, "message">): AttachPhase {
  if (answer === "taken") return { phase: "done" };
  if (answer === "refused") return { phase: "sizeStopped", line: refusalLine(refusal, "The server refused the new size.") };
  return { phase: "sizeStopped", line: `The connection dropped before the server answered. Check ${companion}’s size in its panel.` };
}

/** What the attach's two ops need from the room and the dialog. */
export type AttachDeps = {
  dispatch(op: ClientOp, opts: { onAnswer: OnAnswer; quiet: true }): number | null;
  /** The view as it stands now, read again when the link is taken. */
  view(): (Pick<RoomState, "scenes" | "buildChunks"> & { tokens: Readonly<Record<string, Token | undefined>> }) | null;
  role: "dm" | "player";
  owner: boolean;
  growths(): readonly Growth[];
  setGrowths(growths: Growth[]): void;
  /** Whether the dialog is still open, so an answer may move it. */
  open(): boolean;
  phase(next: AttachPhase): void;
  notify(text: string): void;
};

/**
 * The attach (section 5.1), always two ops. The link and every number but
 * the size go in one `token.update`. Only once that is taken, and only
 * while the dialog is open, does the size go, as its own resize patch built
 * again from the view as it then stands, since a wall or a lock may have
 * changed meanwhile, and judged by the same rule as any resize. A resize
 * patch never carries other fields, so the size can never ride with the
 * link. Closed before the link's answer, nothing more is sent: a late
 * `taken` toasts the size it kept, a late refusal its words. Closed while
 * the resize waits, the resize lands, and a late refusal is the toast any
 * resize's is. `previewed` is the Size line the step showed before Attach,
 * so a size kept for that same reason closes the dialog. False when the
 * link was not sent, as in "view as a player".
 */
export function startAttach(
  deps: AttachDeps,
  input: { tokenId: string; patch: ActorPatch; size: MonsterSize; use: boolean; block: string; companion: string; previewed?: string },
): boolean {
  const before = deps.view()?.tokens[input.tokenId];
  const wanted = before && input.use && before.size !== input.size ? before.size : undefined;
  const onLink = (answer: OpAnswer, refusal?: OpRefusal) => {
    if (!deps.open()) {
      const text = lateAttachText(input.block, input.companion, answer, refusal, wanted);
      if (text) deps.notify(text);
      return;
    }
    const next = afterLinkAnswer(answer, input.companion, refusal);
    if (next.phase !== "done") return deps.phase(next);
    const view = deps.view();
    const token = view?.tokens[input.tokenId];
    if (!view || !token) return deps.phase(next);
    const plan = sizePlan({ view, token, size: input.size, use: input.use, role: deps.role, owner: deps.owner, growths: deps.growths() });
    if (plan.kind === "none") return deps.phase(next);
    // A size kept for the reason the step already showed has nothing new to say. One found only now stays on the Size line.
    if (plan.kind === "kept") return deps.phase(plan.line === input.previewed ? next : { phase: "sizeStopped", line: plan.line });
    const onResize = (answer: OpAnswer, refusal?: OpRefusal) => {
      if (deps.open()) deps.phase(afterResizeAnswer(answer, input.companion, refusal));
      else if (answer === "refused") deps.notify(refusal?.text ?? refusalLine(refusal, "The server refused the new size."));
    };
    if (deps.dispatch({ t: "token.update", tokenId: input.tokenId, patch: plan.patch }, { onAnswer: onResize, quiet: true }) === null) return deps.phase({ phase: "sizeStopped", line: `${input.companion} keeps its size.` });
    deps.setGrowths(plan.growths);
    deps.phase({ phase: "resizing" });
  };
  if (deps.dispatch({ t: "token.update", tokenId: input.tokenId, patch: { actor: input.patch } }, { onAnswer: onLink, quiet: true }) === null) return false;
  deps.phase({ phase: "linking" });
  return true;
}
