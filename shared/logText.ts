import { compareLogIds } from "./keys.ts";
import { CONDITION_KEYS, type ConditionKey, type LogEntry, type LogEvent, type Member, type RoomState, type Token } from "./model.ts";
import { testText } from "./rules/skills.ts";
import { CONDITIONS } from "./srd/conditions.ts";
import { STATUSES } from "./srd/statuses.ts";

/**
 * How log entries read, on a device and in the session log export
 * (docs/design-v1-dm-tools.md 3.10), so the Log panel and the exported file
 * use one wording. It moved here from client/features/log/format.ts, which
 * re-exports it.
 *
 * Events arrive as structured data that names entities by id (design 7.3),
 * already projected for the viewer. They are rendered here with the names
 * the viewer's own view holds, so a player reads "Huge figure" where the DM
 * reads "Stone giant", and an entity the view does not hold reads as "a
 * creature" rather than leaking anything.
 */

/** The parts of a view that log text reads. A player's projected view and a DM's full view both fit. */
export type LogNames = Pick<RoomState, "members" | "tokens" | "characters" | "handouts" | "encounter">;

const SOMEONE = "Someone";
const A_CREATURE = "A creature";

/** "Goblin 3" for numbered duplicates. Players' projections already carry the public name. */
function displayName(token: Pick<Token, "name" | "number">): string {
  return token.number === undefined ? token.name : `${token.name} ${token.number}`;
}

export type AreaEvent = Extract<LogEvent, { type: "area" }>;

/** "Goblin 2 ended its turn in Spirit Guardians." */
export function areaReminderText(data: AreaEvent, who: string): string {
  switch (data.trigger) {
    case "enter":
      return data.moved ? `${data.area} moved onto ${who}.` : `${who} entered ${data.area}.`;
    case "turnStart":
      return `${who} started its turn in ${data.area}.`;
    case "turnEnd":
      return `${who} ended its turn in ${data.area}.`;
  }
}

type RollEvent = Extract<LogEvent, { type: "roll" }>;

/**
 * An answer to a roll request (docs/design-v1-dm-tools.md 3.3): "Thorn
 * rolled 17 on a Dexterity saving throw against DC 15: pass." With two
 * choices it names the one rolled. Without a total it is a save failed
 * without rolling, "Thorn failed a Dexterity saving throw without
 * rolling.", or the DM's mark: "Thorn failed a Dexterity saving throw." The
 * DC and the result are there only when the viewer's line kept them.
 */
export function rollText(data: RollEvent, who: string): string {
  const chosen = data.choice === undefined ? undefined : data.test.choices[data.choice];
  const test = testText(chosen ? { kind: data.test.kind, choices: [chosen] } : data.test);
  const dc = data.dc !== undefined ? ` against DC ${data.dc}` : "";
  if (data.total === undefined) {
    // A DM who overruled it to a pass shows that pass. Otherwise the player's own choice reads as theirs, the result shown or not.
    if (data.noRoll && data.result !== "pass") return `${who} failed ${test}${dc} without rolling.`;
    if (data.result === undefined) return `${who} answered ${test}${dc}.`;
    return `${who} ${data.result === "pass" ? "passed" : "failed"} ${test}${dc}.`;
  }
  const result = data.result !== undefined ? `: ${data.result}` : "";
  return `${who} rolled ${data.total} on ${test}${dc}${result}.`;
}

export function memberName(names: { members: Readonly<Record<string, Member | undefined>> }, id: string | undefined): string {
  return (id !== undefined && names.members[id]?.name) || SOMEONE;
}

/** The viewer's own name for the creature an event is about: its token on this view, else its character. */
export function creatureName(names: LogNames, ref: { tokenId?: string; characterId?: string }): string {
  const token = ref.tokenId !== undefined ? names.tokens[ref.tokenId] : undefined;
  if (token) return displayName(token);
  const character = ref.characterId !== undefined ? names.characters[ref.characterId] : undefined;
  if (character) return character.name;
  return A_CREATURE;
}

const CONDITION_SET: ReadonlySet<string> = new Set(CONDITION_KEYS);

export function effectName(key: string): string {
  if (CONDITION_SET.has(key)) return CONDITIONS[key as ConditionKey].name;
  const status = (STATUSES as Record<string, { label: string } | undefined>)[key];
  if (status) return status.label;
  return "a custom effect";
}

function entryName(names: LogNames, entryId: string): string | null {
  const entry = names.encounter?.entries.find((e) => e.id === entryId);
  if (!entry) return null;
  if (entry.tokenId !== undefined || entry.characterId !== undefined) {
    const name = creatureName(names, entry);
    if (name !== A_CREATURE || entry.label === undefined) return name;
  }
  return entry.label ?? null;
}

/** "3/7", with temporary HP when there is any: "3/7 +5 temp". */
function hpNow(hp: { cur: number; max: number; temp: number }): string {
  return `${hp.cur}/${hp.max}${hp.temp > 0 ? ` +${hp.temp} temp` : ""}`;
}

/** What a line taken back had done, as the object of "The DM took back". */
function changeTakenBack(data: Extract<LogEvent, { type: "hp" }>, who: string): string {
  const amount = data.amount;
  switch (data.change) {
    case "damage":
      return amount !== undefined ? `${amount} damage to ${who}` : `damage to ${who}`;
    case "heal":
      return amount !== undefined ? `${amount} HP of healing on ${who}` : `healing on ${who}`;
    case "set":
      return `a change to ${who}'s HP`;
    case "temp":
      return `${who}'s temporary HP`;
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One event as a sentence. Numbers appear only when the projection kept
 * them, which it does only for viewers who may see that creature's exact
 * HP. Otherwise the HP label (Bloodied, Dying) is all there is to say.
 */
export function describeEvent(data: LogEvent, names: LogNames): string {
  const text = eventText(data, names);
  // Only the DM's log holds these lines (design 7.3), so the DM can tell what players never read.
  return "hidden" in data && data.hidden ? `${text.replace(/\.$/, "")} (hidden from players).` : text;
}

function eventText(data: LogEvent, names: LogNames): string {
  switch (data.type) {
    case "hp": {
      const who = creatureName(names, data);
      // With the numbers, the HP after the change says it all, and the label adds only Dying or Dead.
      const numbers = data.left ? hpNow(data.left) : null;
      const label = data.label && (!numbers || data.label === "Dying" || data.label === "Dead") ? ` (${data.label})` : "";
      if (data.back) return `The DM took back ${changeTakenBack(data, who)}${numbers ? `, ${numbers} now` : ""}${label}.`;
      switch (data.change) {
        case "damage": {
          const amount = data.amount !== undefined ? `${data.amount} damage` : "damage";
          return `${who} takes ${amount}${data.crit ? " from a critical hit" : ""}${numbers ? `, ${numbers} left` : ""}${label}.`;
        }
        case "heal":
          return `${who} regains ${data.amount !== undefined ? `${data.amount} HP` : "HP"}${numbers ? `, ${numbers} now` : ""}${label}.`;
        case "set":
          if (numbers) return `${who}'s HP is set to ${numbers}${label}.`;
          return data.amount !== undefined ? `${who}'s HP is set to ${data.amount}${label}.` : `${who}'s HP was changed${label}.`;
        case "temp":
          return data.amount !== undefined
            ? `${who} gains ${data.amount} temporary HP${label}.`
            : `${who} gains temporary HP${label}.`;
      }
      return `${who}'s HP changed${label}.`;
    }
    case "life": {
      const who = creatureName(names, data);
      switch (data.life) {
        case "alive":
          return `${who} is back on their feet.`;
        case "dying":
          return `${who} is dying.`;
        case "stable":
          return `${who} is stable.`;
        case "dead":
          return `${who} is dead.`;
      }
      return `${who}'s state changed.`;
    }
    case "effect": {
      const who = creatureName(names, data);
      if (data.key === "concentrating") {
        const on = data.spell ? ` on ${data.spell}` : "";
        switch (data.action) {
          case "add":
            return `${who} is concentrating${on}.`;
          case "remove":
            return `${who} stops concentrating${on}.`;
          case "expire":
            return `${who}'s concentration${on} ran out.`;
          case "pause":
            return `${who}'s concentration${on} is paused outside combat.`;
        }
      }
      const effect = effectName(data.key);
      switch (data.action) {
        case "add":
          return `${who} gains ${effect}.`;
        case "remove":
          return `${who} loses ${effect}.`;
        case "expire":
          return `${effect} ends on ${who}.`;
        case "pause":
          return `${effect} on ${who} is paused outside combat.`;
      }
      return `${who}'s effects changed.`;
    }
    case "concentration": {
      const who = creatureName(names, data);
      const on = data.spell ? ` on ${data.spell}` : "";
      if (data.ended) return `${who} loses concentration${on}.`;
      if (data.dc !== undefined) return `${who} makes a DC ${data.dc} Constitution save to keep concentrating${on}.`;
      return `${who} makes a Constitution save to keep concentrating${on}.`;
    }
    case "rest": {
      const who = creatureName(names, data);
      const numbers = data.left ? `, ${hpNow(data.left)} now` : data.label ? ` (${data.label})` : "";
      if (data.kind === "long") return `${who} finishes a long rest${numbers}.`;
      const regained = data.amount !== undefined && data.amount > 0 ? ` and regains ${data.amount} HP` : "";
      return `${who} finishes a short rest${regained}${numbers}.`;
    }
    case "deathSave": {
      const who = creatureName(names, data);
      if (data.ok === undefined || data.fail === undefined) return `${who}'s death saves changed.`;
      return `${who}'s death saves: ${plural(data.ok, "success", "successes")}, ${plural(data.fail, "failure", "failures")}.`;
    }
    case "turn": {
      const who = entryName(names, data.entryId);
      const turn = who ? `${who}'s turn` : "another creature's turn";
      return data.back ? `Round ${data.round}: the DM took back ${turn}.` : `Round ${data.round}: ${turn}.`;
    }
    case "area":
      return areaReminderText(data, creatureName(names, data));
    case "encounter":
      return data.action === "start" ? "Combat starts." : "Combat ends.";
    case "handout": {
      const handout = names.handouts[data.handoutId];
      return handout ? `The DM shows a handout: ${handout.title}.` : "The DM shows a handout.";
    }
    case "member": {
      const who = memberName(names, data.memberId);
      switch (data.action) {
        case "join":
          return `${who} joins the room.`;
        case "kick":
          return `${who} was signed out by the DM.`;
        case "dm":
          return `${who} is now a DM.`;
        case "undm":
          return `${who} is no longer a DM.`;
        case "remove":
          return `${who} was removed from the room.`;
      }
      return `${who} changed.`;
    }
    case "teleport":
      // Only the DM's log holds it (docs/design-v1-maps-vision.md 4.1).
      return `${creatureName(names, data)} teleported past a ${data.past}.`;
    case "roll":
      return rollText(data, creatureName(names, data));
  }
}

/** Members the viewer may whisper to, as the composer's choices. */
export type ChatTarget = { kind: "all" } | { kind: "dm" } | { kind: "member"; memberId: string };

export function targetKey(target: ChatTarget): string {
  return target.kind === "member" ? `m:${target.memberId}` : target.kind;
}

/**
 * The composer's "To" choices (design 8.1, features 16): everyone, the DM,
 * or one player. "The DM" is every DM member at once, so a whisper reaches
 * a co-DM too. A DM whispering to the DM role is offered only when another
 * DM exists. Nobody whispers to themselves.
 */
export function chatTargets(members: Record<string, Member | undefined>, me: string): { target: ChatTarget; label: string }[] {
  const list = Object.values(members).filter((m): m is Member => m !== undefined);
  const out: { target: ChatTarget; label: string }[] = [{ target: { kind: "all" }, label: "Everyone" }];
  if (list.some((m) => m.kind === "dm" && m.id !== me)) out.push({ target: { kind: "dm" }, label: "The DM (whisper)" });
  const players = list.filter((m) => m.kind === "player" && m.id !== me).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of players) out.push({ target: { kind: "member", memberId: p.id }, label: `${p.name} (whisper)` });
  return out;
}

/**
 * The composer's recipient, from the key the person picked. A whisper's
 * recipient can leave the list while a draft waits (the only other DM is
 * demoted, or a player is removed). Falling back to Everyone would send
 * words meant for one person to the whole table, so the pick stays, marked
 * gone, and the composer waits for a new one.
 */
export function composerTarget(
  targets: readonly { target: ChatTarget; label: string }[],
  key: string,
  members: Record<string, Member | undefined>,
): { gone: false; target: ChatTarget; label: string } | { gone: true; label: string } {
  const found = targets.find((t) => targetKey(t.target) === key);
  if (found) return { gone: false, ...found };
  if (key.startsWith("m:")) {
    const name = members[key.slice(2)]?.name;
    return { gone: true, label: name ? `${name} (not available)` : "A player who left" };
  }
  return { gone: true, label: "The DM (nobody else is DM now)" };
}

/** The op a message becomes: a chat for everyone, or a whisper to its recipients. Null when nobody is left to receive it. */
export function messageOp(
  target: ChatTarget,
  text: string,
  members: Record<string, Member | undefined>,
  me: string,
): { t: "log.chat"; text: string } | { t: "log.whisper"; to: string[]; text: string } | null {
  if (target.kind === "all") return { t: "log.chat", text };
  if (target.kind === "dm") {
    const to = Object.values(members)
      .filter((m): m is Member => m !== undefined && m.kind === "dm" && m.id !== me)
      .map((m) => m.id);
    return to.length > 0 ? { t: "log.whisper", to, text } : null;
  }
  if (target.memberId === me || !members[target.memberId]) return null;
  return { t: "log.whisper", to: [target.memberId], text };
}

/**
 * The line above a whisper: where it went, from this viewer's side. The
 * sender's name is on the message itself. The server sends a whisper only
 * to its sender and recipients (design 7.3), so the viewer is one of them.
 */
export function whisperHeading(entry: Pick<LogEntry, "from" | "to">, members: Record<string, Member | undefined>, me: string): string {
  const to = entry.to ?? [];
  if (to.length > 0 && to.every((id) => members[id]?.kind === "dm")) return "Whisper to the DM";
  const names = to.map((id) => (id === me ? "you" : memberName({ members }, id)));
  // "you" first reads naturally: "to you and Thorn".
  names.sort((a, b) => (a === "you" ? -1 : b === "you" ? 1 : 0));
  if (names.length <= 2) return `Whisper to ${names.join(" and ")}`;
  return `Whisper to ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Older pages from the archive joined to the live log, oldest first. The
 * live tail wins where both hold an entry, because it is the current
 * projection, and an entry never appears twice.
 */
export function mergeLog(older: readonly LogEntry[], live: readonly LogEntry[]): LogEntry[] {
  const liveIds = new Set(live.map((e) => e.id));
  const kept = older.filter((e) => !liveIds.has(e.id));
  return [...kept, ...live].sort((a, b) => compareLogIds(a.id, b.id));
}
