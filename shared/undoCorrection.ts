import { parseKey, readEntity } from "./keys.ts";
import type { Character, CorrectionWitness, LineParts, LogEvent, RoomState, Token, Viewer } from "./model.ts";
import { ownsCharacter, ownsToken, projectEntity, stableStringify } from "./project.ts";
import type { CorrectionLogEvent, HistoryDirection, HistoryScope } from "./undoContract.ts";

const ACTOR_FIELDS = ["hp", "hpLabel", "hpBar", "life", "ac", "speeds", "initBonus", "initScore", "passivePerception", "senses", "creatureType", "cr", "xp", "srdId", "blockId", "wildShape", "effects", "deathSaves", "legendary", "uses", "hurt"];
const POSE_FIELDS = ["sceneId", "x", "y", "elevation", "rotation", "size", "w", "h", "squeeze", "path", "attached"];
type Value = Record<string, unknown>;

function object(value: unknown): Value {
  return value !== null && typeof value === "object" ? value as Value : {};
}

function pick(value: Value, fields: readonly string[]): Value {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function without(value: Value, fields: readonly string[]): Value {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
}

function mechanics(key: string, projected: Value, owner: boolean): Value {
  const kind = parseKey(key)?.kind;
  if (kind === "companionBlock") return without(projected, ["id", "rev", "characterId", "fromSrd", "name", "defaultImage"]);
  const actor = object(projected.actor);
  const actorFields = pick(kind === "token" ? object(actor.inline) : actor, ACTOR_FIELDS);
  if (Array.isArray(actorFields.effects)) actorFields.effects = actorFields.effects.map((effect) => without(object(effect), ["id", "due", "color", "glyph"]));
  const out: Value = { actor: actorFields };
  if (kind === "token" && owner) out.pose = pick(projected, POSE_FIELDS);
  if (kind === "character" && owner) {
    const stats = object(projected.stats);
    const rolls = Array.isArray(stats.rolls) ? stats.rolls.map((roll) => {
      const clean = without(object(roll), ["id", "name", "ddb"]);
      if (Array.isArray(clean.dice)) clean.dice = clean.dice.map((part) => without(object(part), ["name"]));
      return clean;
    }) : undefined;
    out.stats = { ...without(stats, ["rolls"]), ...(rolls ? { rolls } : {}) };
    out.level = projected.level;
    out.knownForms = projected.knownForms;
    out.resources = Array.isArray(projected.resources) ? projected.resources.map((resource) => without(object(resource), ["id", "edited", "atLevel"])) : projected.resources;
  }
  return out;
}

function ownerOf(state: RoomState, viewer: Viewer, key: string): boolean {
  const value = readEntity(state, key);
  if (!value) return false;
  switch (parseKey(key)?.kind) {
    case "token": return ownsToken(state, viewer, value as Token);
    case "character": return ownsCharacter(viewer, value as Character);
    case "companionBlock": {
      const character = state.characters[object(value).characterId as string];
      return character !== undefined && ownsCharacter(viewer, character);
    }
    default: return false;
  }
}

/** One copy per reader. The copy's private witnesses keep later access from widening the frozen audience. */
export function correctionViews(before: RoomState, after: RoomState, touched: readonly string[], from: HistoryDirection, scope: HistoryScope): [string, LogEvent, LineParts][] {
  const targets = [...new Set(touched)].filter((key) => ["token", "character", "companionBlock"].includes(parseKey(key)?.kind ?? "")).sort();
  const views: [string, LogEvent, LineParts][] = [];
  for (const member of Object.values(after.members).filter((m) => m.kind === "player").sort((a, b) => a.id.localeCompare(b.id))) {
    const viewer: Viewer = { memberId: member.id, role: "player" };
    const witnesses: CorrectionWitness[] = [];
    for (const key of targets) {
      const was = projectEntity(key, before, viewer, { sceneId: null });
      const now = projectEntity(key, after, viewer, { sceneId: null });
      const oldValue = readEntity(before, key);
      const newValue = readEntity(after, key);
      const characterId = parseKey(key)?.kind === "companionBlock" ? object(newValue ?? oldValue).characterId as string | undefined : undefined;
      const characterOwner = characterId !== undefined && before.characters[characterId]?.ownerIds.includes(member.id) === true && after.characters[characterId]?.ownerIds.includes(member.id) === true;
      // A reveal or loss of sight alone is not evidence of a mechanical correction. A missing definition still belongs to its character.
      if ((!was && oldValue !== null) || (!now && newValue !== null) || (!now && !characterOwner)) continue;
      const owner = characterOwner || ((oldValue === null || ownerOf(before, viewer, key)) && ownerOf(after, viewer, key));
      const a = mechanics(key, object(was), owner);
      const b = mechanics(key, object(now), owner);
      if (!owner) {
        // A change in who can see a field is not itself a correction to that field.
        const common = ACTOR_FIELDS.filter((field) => object(a.actor)[field] !== undefined && object(b.actor)[field] !== undefined);
        a.actor = pick(object(a.actor), common);
        b.actor = pick(object(b.actor), common);
      }
      if (stableStringify(a) === stableStringify(b)) continue;
      const fields = ACTOR_FIELDS.filter((field) => stableStringify(object(a.actor)[field] ?? null) !== stableStringify(object(b.actor)[field] ?? null));
      const name = owner && typeof object(now ?? was).name === "string" ? (object(now ?? was).name as string).slice(0, 200) : undefined;
      witnesses.push({ key, owner, ...(characterId ? { characterId } : {}), ...(!owner ? { fields } : {}), ...(name ? { name } : {}) });
    }
    if (witnesses.length === 0) continue;
    const names = new Set(witnesses.flatMap((w) => w.name ? [w.name] : []));
    const name = names.size === 1 && witnesses.every((w) => w.name !== undefined) ? [...names][0] : undefined;
    views.push([member.id, { type: "correction", from, scope, ...(name ? { name } : {}) }, { correction: witnesses }]);
  }
  return views;
}

export function projectCorrection(state: RoomState, viewer: Viewer, data: CorrectionLogEvent, witnesses: readonly CorrectionWitness[] | undefined, project: (key: string) => unknown): CorrectionLogEvent | null {
  const eligible = (witnesses ?? []).filter((w) => {
    const value = project(w.key);
    if (w.characterId !== undefined) {
      const character = state.characters[w.characterId];
      if (!character || !ownsCharacter(viewer, character)) return false;
      const current = readEntity(state, w.key);
      return current === null || (value !== null && object(current).characterId === w.characterId);
    }
    if (!value) return false;
    if (w.owner) return ownerOf(state, viewer, w.key);
    const actor = object(object(value).actor);
    const seen = parseKey(w.key)?.kind === "token" ? object(actor.inline) : actor;
    return w.fields?.some((field) => seen[field] !== undefined) === true;
  });
  if (eligible.length === 0) return null;
  const name = data.name && eligible.some((w) => w.name === data.name) ? data.name : undefined;
  return { type: "correction", from: data.from, scope: data.scope, ...(name ? { name } : {}) };
}
