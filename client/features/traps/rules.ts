import { LIMITS } from "#shared/limits.ts";
import { MIN_HEIGHT_FT, type BuildChunk, type CellRect, type Token, type Trap, type TrapArea, type TrapCheck, type TrapRig, type TrapZone } from "#shared/model.ts";
import type { TrapInput } from "#shared/protocol.ts";
import { footprintRect } from "#shared/rules/footprint.ts";
import { rangeGround } from "#shared/rules/heights.ts";
import { ABILITY_NAMES, choiceText } from "#shared/rules/skills.ts";
import { damageTypeName } from "#shared/rules/damage.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import { LEVEL_BANDS, TRAP_PRESET_IDS, trapPreset, type LevelBand } from "#shared/srd/traps.ts";
import type { AskFill } from "../rolls/logic.ts";
import { findDoor, segmentDistance, type Point } from "../doors/doors.ts";

/*
 * The Trap tool's rules (docs/design-v1-traps.md 4.1 and 4.2), as plain
 * functions for node --test: snapping the zone being drawn, finding the
 * trap under a tap, a new trap from Blank, Alarm or an SRD preset, the
 * pane's one-line summaries, and what Ask to search and Ask to disarm fill.
 */

export type ZoneKind = "squares" | "wire" | "door";

/** A trap the tool starts from: blank, an alarm, or an SRD preset's id. */
export const START_BLANK = "blank";
export const START_ALARM = "alarm";

export const BAND_NAMES: Record<LevelBand, string> = { "1-4": "Levels 1–4", "5-10": "Levels 5–10", "11-16": "Levels 11–16", "17-20": "Levels 17–20" };

/** The Start from choices, Blank and Alarm first, then the SRD's traps in its order. */
export function startChoices(): { value: string; label: string; detail?: string }[] {
  const presets = TRAP_PRESET_IDS.map((id) => {
    const p = trapPreset(id, "1-4")!;
    return { value: id, label: p.name };
  });
  return [{ value: START_BLANK, label: "Blank" }, { value: START_ALARM, label: "Alarm", detail: "a note only" }, ...presets];
}

/** The zone kind a start picks, or null for one that leaves the choice as it is. */
export function startKind(start: string): ZoneKind | null {
  const preset = trapPreset(start, "1-4");
  return preset ? preset.zone.kind : null;
}

export function zoneKind(zone: TrapZone): ZoneKind {
  return "cells" in zone ? "squares" : "wire" in zone ? "wire" : "door";
}

// ------------------------------------------------------------ drawing a zone

type Bounds = { w: number; h: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The squares between where a drag began and where it is, snapped to whole
 * cells and kept on the scene. A side stops at 20 cells, counted from the
 * cell the drag began on, so the rectangle never jumps away from it.
 */
export function rectBetween(a: Point, b: Point, bounds: Bounds): CellRect {
  const side = LIMITS.trapRectSide;
  const ax = clamp(Math.floor(a.x), 0, bounds.w - 1);
  const ay = clamp(Math.floor(a.y), 0, bounds.h - 1);
  const bx = clamp(Math.floor(b.x), 0, bounds.w - 1);
  const by = clamp(Math.floor(b.y), 0, bounds.h - 1);
  const w = Math.min(Math.abs(bx - ax) + 1, side);
  const h = Math.min(Math.abs(by - ay) + 1, side);
  return { x: bx < ax ? ax - w + 1 : ax, y: by < ay ? ay - h + 1 : ay, w, h };
}

/** Whether a point is a wire's end: a cell corner or an edge midpoint, never a cell's center. */
function wireSpot(x: number, y: number): boolean {
  return Number.isInteger(x * 2) && Number.isInteger(y * 2) && (Number.isInteger(x) || Number.isInteger(y));
}

/** The wire end nearest a point: a cell corner or an edge midpoint, on the scene. */
export function wireEnd(p: Point, bounds: Bounds): [number, number] {
  const x = clamp(p.x, 0, bounds.w);
  const y = clamp(p.y, 0, bounds.h);
  const candidates: [number, number][] = [
    [Math.round(x), Math.round(y)],
    [Math.round(x), Math.min(bounds.h, Math.floor(y) + 0.5)],
    [Math.min(bounds.w, Math.floor(x) + 0.5), Math.round(y)],
  ];
  let best = candidates[0]!;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c[0] - x, c[1] - y);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

const wireLength = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * A wire from one snapped end toward a point, or null while it is shorter
 * than half a cell. One drawn past 20 cells stops at the end nearest the
 * 20-cell mark along the drag that keeps it within 20.
 */
export function wireBetween(a: [number, number], to: Point, bounds: Bounds): { a: [number, number]; b: [number, number] } | null {
  let b = wireEnd(to, bounds);
  const max = LIMITS.trapWireMax;
  if (wireLength(a, b) > max) {
    const len = Math.hypot(to.x - a[0], to.y - a[1]);
    const target = { x: a[0] + ((to.x - a[0]) * max) / len, y: a[1] + ((to.y - a[1]) * max) / len };
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const c: [number, number] = [Math.round(target.x * 2) / 2 + dx / 2, Math.round(target.y * 2) / 2 + dy / 2];
        if (!wireSpot(c[0], c[1]) || c[0] < 0 || c[1] < 0 || c[0] > bounds.w || c[1] > bounds.h || wireLength(a, c) > max) continue;
        const d = Math.hypot(c[0] - target.x, c[1] - target.y);
        if (d < bestD) {
          best = c;
          bestD = d;
        }
      }
    }
    if (!best) return null;
    b = best;
  }
  return wireLength(a, b) < LIMITS.trapWireMin ? null : { a, b };
}

/** Cells the rectangles cover, a cell two share counted once. */
export function rectsCells(rects: readonly CellRect[]): number {
  const seen = new Set<string>();
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) seen.add(`${x},${y}`);
  return seen.size;
}

/** The rectangles with one more added, or why it does not fit: at most 8 rectangles and 400 cells. */
export function withRect(rects: readonly CellRect[], rect: CellRect): { ok: true; rects: CellRect[] } | { ok: false; why: string } {
  if (rects.length >= LIMITS.trapRects) return { ok: false, why: `A trap holds at most ${LIMITS.trapRects} rectangles of squares.` };
  const next = [...rects, rect];
  if (rectsCells(next) > LIMITS.trapCells) return { ok: false, why: `A trap's squares are at most ${LIMITS.trapCells} cells.` };
  return { ok: true, rects: next };
}

// ------------------------------------------------------------ where a trap lies

export type Box = { x0: number; y0: number; x1: number; y1: number };

/** A trap's zone on the map in cells, or null for a door trap whose door is gone. */
export function zoneBox(trap: Pick<Trap, "zone" | "sceneId">, chunks: Readonly<Record<string, BuildChunk>>): Box | null {
  const zone = trap.zone;
  if ("cells" in zone) {
    let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const r of zone.cells) box = { x0: Math.min(box.x0, r.x), y0: Math.min(box.y0, r.y), x1: Math.max(box.x1, r.x + r.w), y1: Math.max(box.y1, r.y + r.h) };
    return box;
  }
  if ("wire" in zone) {
    const { a, b } = zone.wire;
    return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
  }
  const door = findDoor(chunks, trap.sceneId, zone.door);
  return door ? { x0: Math.min(door.a.x, door.b.x), y0: Math.min(door.a.y, door.b.y), x1: Math.max(door.a.x, door.b.x), y1: Math.max(door.a.y, door.b.y) } : null;
}

export function boxCenter(box: Box): Point {
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

/**
 * The trap under a tap: one whose squares hold the point, or whose wire or
 * door lies within `slop` cells of it. Of several, the nearest, then the
 * last made (the higher id), which draws on top.
 */
export function trapAt<T extends Pick<Trap, "id" | "zone" | "sceneId">>(traps: readonly T[], chunks: Readonly<Record<string, BuildChunk>>, p: Point, slop: number): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const trap of traps) {
    const d = trapDistance(trap, chunks, p);
    if (d > slop) continue;
    if (d < bestD || (d === bestD && best !== null && trap.id > best.id)) {
      best = trap;
      bestD = d;
    }
  }
  return best;
}

function trapDistance(trap: Pick<Trap, "zone" | "sceneId">, chunks: Readonly<Record<string, BuildChunk>>, p: Point): number {
  const zone = trap.zone;
  if ("cells" in zone) return zone.cells.some((r) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h) ? 0 : Infinity;
  if ("wire" in zone) return segmentDistance(p, { x: zone.wire.a[0], y: zone.wire.a[1] }, { x: zone.wire.b[0], y: zone.wire.b[1] });
  const door = findDoor(chunks, trap.sceneId, zone.door);
  return door ? segmentDistance(p, door.a, door.b) : Infinity;
}

/** The ground under a trap's squares: the highest, as a footprint stands on the highest ground under it. */
export function zoneGround(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, rects: readonly CellRect[]): number {
  let top = -Infinity;
  for (const r of rects) top = Math.max(top, rangeGround(chunks, sceneId, { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }));
  return top === -Infinity ? 0 : top;
}

/** A pit's floor for a depth under the lid's ground, stopping at the height rules' −100 ft. */
export function pitFloor(ground: number, depth: number): number {
  return Math.max(MIN_HEIGHT_FT, Math.round(ground - depth));
}

/** The creatures on a trap's squares now, for Set it off with none selected. A wire or a door has none standing on it. */
export function tokensOn(trap: Pick<Trap, "zone" | "sceneId">, tokens: Readonly<Record<string, Token | undefined>>): string[] {
  const zone = trap.zone;
  if (!("cells" in zone)) return [];
  const out: string[] = [];
  for (const t of Object.values(tokens)) {
    if (!t || t.sceneId !== trap.sceneId) continue;
    const f = footprintRect(t);
    if (zone.cells.some((r) => f.x < r.x + r.w && f.x + f.w > r.x && f.y < r.y + r.h && f.y + f.h > r.y)) out.push(t.id);
  }
  return out.sort();
}

// ------------------------------------------------------------ a new trap

/** A blank trap's rig: it goes off for party creatures stepping onto it, stops them and hits them, and does nothing else until the DM says. */
function blankRig(squares: boolean): TrapRig {
  return { on: squares ? ["enter"] : [], who: "party", floor: false, resets: "never", stops: true, foundOnSpring: true, hits: "trigger", actions: [], find: [], notice: false };
}

/**
 * An alarm: a line in the DM's log and nothing players can see. It never
 * stops the creature, whose player would notice, never marks itself found,
 * and arms again for the next creature.
 */
function alarmRig(squares: boolean): TrapRig {
  return { ...blankRig(squares), resets: "nextTurn", stops: false, foundOnSpring: false };
}

/** The cells a wire's box covers, at least one: a preset's squares to draw start there. */
function wireCells(wire: { a: [number, number]; b: [number, number] }): CellRect {
  const x0 = Math.floor(Math.min(wire.a[0], wire.b[0]));
  const y0 = Math.floor(Math.min(wire.a[1], wire.b[1]));
  const x1 = Math.max(x0 + 1, Math.ceil(Math.max(wire.a[0], wire.b[0])));
  const y1 = Math.max(y0 + 1, Math.ceil(Math.max(wire.a[1], wire.b[1])));
  return { x: x0, y: y0, w: Math.min(x1 - x0, LIMITS.trapRectSide), h: Math.min(y1 - y0, LIMITS.trapRectSide) };
}

/**
 * A new trap as the tool makes it (4.1), from Blank, Alarm or a preset at
 * a party level. The zone is the one drawn, whatever kind the preset has:
 * a squares-only rule (its triggers, its pit, hitting everyone on it) falls
 * away on a wire or a door. A preset's squares to draw start as its own
 * squares, and its cone at the zone's middle, aimed east, for the DM to
 * place.
 */
export function newTrapInput(input: { id: string; sceneId: string; start: string; band: LevelBand; zone: TrapZone; chunks: Readonly<Record<string, BuildChunk>> }): TrapInput {
  const { zone } = input;
  const squares = "cells" in zone;
  const base = { id: input.id, sceneId: input.sceneId, zone };
  if (input.start === START_ALARM) return { ...base, name: "Alarm", rig: alarmRig(squares) };
  const preset = trapPreset(input.start, input.band);
  if (!preset) return { ...base, name: "Trap", rig: blankRig(squares) };
  const box = zoneBox({ zone, sceneId: input.sceneId }, input.chunks);
  const center = box ? boxCenter(box) : { x: 0, y: 0 };
  let hits: TrapRig["hits"] = "trigger";
  if (preset.hits === "draw") {
    if ("cells" in zone) hits = { cells: zone.cells.map((r) => ({ ...r })) };
    else if ("wire" in zone) hits = { cells: [wireCells(zone.wire)] };
  } else if (typeof preset.hits === "object") {
    const ground = rangeGround(input.chunks, input.sceneId, { x0: Math.floor(center.x), y0: Math.floor(center.y), x1: Math.floor(center.x) + 1, y1: Math.floor(center.y) + 1 });
    hits = { area: { shape: "cone", size: preset.hits.cone, origin: { x: center.x, y: center.y, z: ground }, yaw: 0, includeOrigin: false } };
  }
  const { on, ...rest } = preset.rig;
  const rig: TrapRig = { ...rest, on: squares ? (on.length > 0 ? on : ["enter"]) : [], hits };
  if (squares && preset.pitDepth !== undefined) rig.pit = { floor: pitFloor(zoneGround(input.chunks, input.sceneId, zone.cells), preset.pitDepth) };
  return { ...base, name: preset.name, rig };
}

/**
 * The pane's first line (4.1): "From Hidden Pit, levels 1–4", the party
 * level read back from the save's DC and the damage, or the preset's name
 * alone once they no longer match any level's.
 */
export function presetLine(rig: Pick<TrapRig, "preset" | "save" | "damage">): string | null {
  if (!rig.preset) return null;
  const any = trapPreset(rig.preset, "1-4");
  if (!any) return null;
  const formulas = (d: TrapRig["damage"]) => (d ?? []).map((p) => `${p.formula} ${p.type}`).join(",");
  const band = LEVEL_BANDS.find((b) => {
    const p = trapPreset(rig.preset!, b)!;
    return p.rig.save?.dc === rig.save?.dc && formulas(p.rig.damage) === formulas(rig.damage);
  });
  return band ? `From ${any.name}, ${BAND_NAMES[band].toLowerCase()}` : `From ${any.name}`;
}

// ------------------------------------------------------------ the pane's lines

const TRIGGER_WORDS: Record<TrapRig["on"][number], string> = {
  enter: "A creature steps onto it",
  turnStart: "starts its turn on it",
  turnEnd: "ends its turn on it",
  leave: "steps off it",
};

export const TRIGGER_ORDER: readonly TrapRig["on"][number][] = ["enter", "turnStart", "turnEnd", "leave"];

export const WHO_WORDS: Record<TrapRig["who"], string> = { party: "Party creatures", others: "Other creatures", any: "Any creature" };

/** "Steps onto it or starts its turn on it, party creatures on the floor". */
export function triggerSummary(trap: Pick<Trap, "zone"> & { rig: TrapRig }): string {
  const rig = trap.rig;
  const kind = zoneKind(trap.zone);
  const how =
    kind === "wire"
      ? "Crossed"
      : kind === "door"
        ? "Opened"
        : TRIGGER_ORDER.filter((t) => rig.on.includes(t))
            .map((t, i) => (i === 0 ? TRIGGER_WORDS[t].replace(/^A creature /, "") : TRIGGER_WORDS[t]))
            .join(" or ")
            .replace(/^./, (c) => c.toUpperCase());
  const who = [WHO_WORDS[rig.who].toLowerCase(), rig.minSize ? "Small or larger" : null, rig.floor ? "on the floor" : null].filter(Boolean).join(", ");
  return `${how}, by ${who}`;
}

/** "Goes off once, stops the creature" or "Arms again each turn, at most 3 times". */
export function afterSummary(rig: TrapRig, pitDepth: number | null): string {
  const parts = [rig.resets === "never" ? "Goes off once" : "Arms again each turn"];
  if (rig.usesLeft !== undefined) parts.push(rig.usesLeft === 0 ? "no uses left" : `${rig.usesLeft} ${rig.usesLeft === 1 ? "use" : "uses"} left`);
  if (rig.stops) parts.push("stops the creature");
  if (pitDepth !== null) parts.push(`opens a ${pitDepth} ft pit`);
  return parts.join(", ");
}

export function hitsSummary(rig: TrapRig): string {
  if (rig.hits === "trigger") return "The creature that set it off";
  if (rig.hits === "zone") return "Everyone on the trap";
  if ("cells" in rig.hits) return `Everyone in ${rectsCells(rig.hits.cells)} drawn ${rectsCells(rig.hits.cells) === 1 ? "square" : "squares"}`;
  return `Everyone in a ${rig.hits.area.size} ft ${rig.hits.area.shape}`;
}

/** "Dexterity save, DC 13, 2d10 Bludgeoning, half on a pass", as the group save's fill line reads (4.4). */
export function saveSummary(rig: TrapRig): string {
  const parts: string[] = [];
  if (rig.save) parts.push(`${ABILITY_NAMES[rig.save.ability]} save, DC ${rig.save.dc}`);
  else parts.push("No save");
  if (rig.damage) parts.push(rig.damage.map((d) => `${d.formula} ${damageTypeName(d.type)}`).join(" + "));
  if (rig.save && rig.damage) parts.push(rig.save.onPass === "half" ? "half on a pass" : "none on a pass");
  if (rig.conditions) parts.push(`${rig.conditions.map((c) => CONDITIONS[c].name).join(" and ")} on a fail`);
  if (!rig.damage && !rig.conditions) return rig.save ? `${parts[0]}, no effect yet` : "None";
  return parts.join(", ");
}

/** "Wisdom (Perception) DC 15: the pressure plate". */
export function checkText(check: TrapCheck): string {
  return `${choiceText(check)} DC ${check.dc}${check.what ? `: ${check.what}` : ""}`;
}

export function findSummary(rig: TrapRig): string {
  const parts = rig.find.map(checkText);
  if (rig.disarm?.check) parts.push(`disarm ${checkText(rig.disarm.check)}`);
  return parts.length > 0 ? parts.join(", ") : "No checks";
}

// ------------------------------------------------------------ asking for rolls

/**
 * Ask to search (4.2): Request a roll filled with its first find check and
 * its DC, and a second check of the same DC as the other choice. The note
 * is "Search", never the trap's name, which players may not know.
 */
export function searchFill(rig: Pick<TrapRig, "find">): AskFill | null {
  const first = rig.find[0];
  if (!first) return null;
  const choices = rig.find.filter((c) => c.dc === first.dc).map((c) => (c.skill ? { ability: c.ability, skill: c.skill } : { ability: c.ability }));
  const unique = choices.filter((c, i) => choices.findIndex((o) => o.ability === c.ability && o.skill === c.skill) === i);
  return { test: { kind: "check", choices: unique }, dc: first.dc, note: "Search" };
}

/** Ask to disarm: its disarm check, with the note "Disarm". None without a check. */
export function disarmFill(rig: Pick<TrapRig, "disarm">): AskFill | null {
  const check = rig.disarm?.check;
  if (!check) return null;
  return { test: { kind: "check", choices: [check.skill ? { ability: check.ability, skill: check.skill } : { ability: check.ability }] }, dc: check.dc, note: "Disarm" };
}

// ------------------------------------------------------------ text fields

/** A single line as the trap's fields take it: trimmed, and cut to `max` without splitting a character. Empty is null. */
export function cleanLine(text: string, max: number): string | null {
  let s = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (s.length > max) {
    s = s.slice(0, max);
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s === "" ? null : s;
}

/** The DM note: line breaks kept, other control characters dropped, cut to 1,000 without splitting a character. Empty is null. */
export function cleanNote(text: string): string | null {
  let s = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
  if (s.length > LIMITS.trapNoteChars) {
    s = s.slice(0, LIMITS.trapNoteChars);
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
  }
  return s === "" ? null : s;
}

/** The area a trap hits, from an area tool draft's template, without its caster, owner or look. */
export function trapAreaOf(t: TrapArea): TrapArea {
  return {
    shape: t.shape,
    size: t.size,
    ...(t.width !== undefined ? { width: t.width } : {}),
    ...(t.height !== undefined ? { height: t.height } : {}),
    origin: { x: t.origin.x, y: t.origin.y, z: t.origin.z },
    yaw: t.yaw,
    ...(t.pitch !== undefined ? { pitch: t.pitch } : {}),
    ...(t.faceOffset !== undefined ? { faceOffset: { ...t.faceOffset } } : {}),
    ...(t.anchor !== undefined ? { anchor: t.anchor } : {}),
    includeOrigin: t.includeOrigin,
  };
}
