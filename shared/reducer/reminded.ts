import { LIMITS } from "../limits.ts";
import type { AreaTrigger, Member, Reminded, RemindedPairs } from "../model.ts";
import type { LineReach } from "../project.ts";

/**
 * Which reminders each audience read in the turn that is running
 * (RoomState.reminded), so an area reminds about a creature once a turn
 * (areaTriggers.ts) by who read what, never by what the log still holds.
 * Each ring of the log drops its own oldest lines, the DM's after any 200
 * DM lines, so a reminder read from the log could come again once hidden
 * work had pushed out a line only the DM got. From op version 19 the room
 * keeps this record instead, and older ops read the log as they did.
 *
 * A reminder is held back only from readers who already read a matching
 * one this turn: for an area that hits once a turn one of any trigger,
 * else one of the same trigger. Who read a reminder is who its line
 * reached as the op left the room (Tx.settleLog, lineReach), kept by
 * audience as the log keeps its rings:
 *
 * - every player read a shared line, kept in `shared`,
 * - a party line's readers read their own copies, kept for each of them,
 * - and the DM read every line, so `dm` keeps only lines no player read.
 *
 * A reminder nobody still needs is not written. One only some of its
 * readers still need goes to them alone, as a party line, which the DM
 * reads as well, so the DM may read a second one. A reminder only the DM
 * read never holds back one a player would read. Each audience records its
 * pairs under a cap of its own (LIMITS.remindedShared, remindedPerPlayer
 * and remindedDm) and past it records no new pair, so a player is only
 * ever reminded twice because of reminders they read themselves.
 *
 * A turn that starts (Next, the removal of the acting row, Previous)
 * starts an empty record, so a turn put back with Previous reminds again,
 * as it did before op version 19. The record is the DM's alone, in no
 * projection, no size measure and no undo, and an import leaves it behind.
 */

const BIT: Record<AreaTrigger, number> = { enter: 1, turnStart: 2, turnEnd: 4 };

/** A reminder an op wrote: its area and creature, its trigger, and whether its area hits once a turn. */
export type Reminder = { templateId: string; tokenId: string; trigger: AreaTrigger; once: boolean };

/**
 * One audience's pairs as an op changes them. The room's own record is
 * shared with the state the op started from, so each map is copied on its
 * first change.
 */
class Pairs {
  private value: RemindedPairs;
  private copied = false;
  private readonly copiedAreas = new Set<string>();
  private size: number | null = null;

  constructor(value: RemindedPairs = {}) {
    this.value = value;
  }

  has(r: Reminder): boolean {
    const mask = this.value[r.templateId]?.[r.tokenId] ?? 0;
    return r.once ? mask !== 0 : (mask & BIT[r.trigger]) !== 0;
  }

  /** Records the reminder, unless it is a new pair past `cap`. Whether anything changed. */
  add(r: Reminder, cap: number): boolean {
    const mask = this.value[r.templateId]?.[r.tokenId];
    const bit = BIT[r.trigger];
    if (mask !== undefined && (mask & bit) !== 0) return false;
    const count = this.count();
    if (mask === undefined && count >= cap) return false;
    if (!this.copied) {
      this.value = { ...this.value };
      this.copied = true;
    }
    if (!this.copiedAreas.has(r.templateId)) {
      this.value[r.templateId] = { ...this.value[r.templateId] };
      this.copiedAreas.add(r.templateId);
    }
    this.value[r.templateId]![r.tokenId] = (mask ?? 0) | bit;
    if (mask === undefined) this.size = count + 1;
    return true;
  }

  count(): number {
    this.size ??= Object.values(this.value).reduce((n, tokens) => n + Object.keys(tokens).length, 0);
    return this.size;
  }

  get(): RemindedPairs | undefined {
    return this.count() === 0 ? undefined : this.value;
  }
}

/** The record of one turn's reminders, as an op reads and adds to it. */
export class Book {
  private readonly from: Reminded;
  private readonly shared: Pairs;
  private readonly dm: Pairs;
  private readonly players = new Map<string, Pairs>();
  /** Whether the room's record must be written: a turn started, or the op recorded a reminder. */
  changed: boolean;

  /** The room's record, or an empty one for a turn that starts. */
  constructor(from: Reminded | undefined, fresh = false) {
    this.from = fresh ? {} : (from ?? {});
    this.shared = new Pairs(this.from.shared);
    this.dm = new Pairs(this.from.dm);
    this.changed = fresh;
  }

  private player(id: string): Pairs {
    let pairs = this.players.get(id);
    if (!pairs) {
      pairs = new Pairs(this.from.players?.[id]);
      this.players.set(id, pairs);
    }
    return pairs;
  }

  /** Every player the record holds a copy for. */
  private playerIds(): Set<string> {
    return new Set([...Object.keys(this.from.players ?? {}), ...this.players.keys()]);
  }

  /** Whether the DM read a matching reminder this turn: every line, a party line's included, is the DM's too. */
  private dmRead(r: Reminder): boolean {
    if (this.dm.has(r) || this.shared.has(r)) return true;
    for (const id of this.playerIds()) if (this.player(id).has(r)) return true;
    return false;
  }

  /**
   * Who the reminder still goes to: its line's reach less the readers who
   * read a matching one this turn, or null when none is left. A shared
   * line's reach lists every player's view (lineReader), so it can narrow
   * to a party line for those who still need it.
   */
  narrow(r: Reminder, reach: LineReach): LineReach | null {
    if (this.shared.has(r)) return null;
    if (reach.audience === "dm") return this.dmRead(r) ? null : reach;
    const views = reach.views;
    if (!views) throw new Error("a reminder's shared reach must list its readers");
    const left = views.filter(([id]) => !this.player(id).has(r));
    if (left.length === views.length) return reach;
    // A player who read one is on the record, so the DM read it too.
    return left.length === 0 ? null : { audience: "party", views: left };
  }

  /** Records who read the reminder: every player, the DM alone, or these players' copies. */
  record(r: Reminder, readers: "shared" | "dm" | readonly string[]): void {
    if (readers === "shared") this.changed = this.shared.add(r, LIMITS.remindedShared) || this.changed;
    else if (readers === "dm") this.changed = this.dm.add(r, LIMITS.remindedDm) || this.changed;
    else for (const id of readers) this.changed = this.player(id).add(r, LIMITS.remindedPerPlayer) || this.changed;
  }

  /** The record to keep, only players still on the roster keeping theirs, or undefined when it holds nothing. */
  value(members: Readonly<Record<string, Member>>): Reminded | undefined {
    const out: Reminded = {};
    const shared = this.shared.get();
    if (shared) out.shared = shared;
    const players: Record<string, RemindedPairs> = {};
    for (const id of [...this.playerIds()].sort()) {
      const pairs = members[id]?.kind === "player" ? this.player(id).get() : undefined;
      if (pairs) players[id] = pairs;
    }
    if (Object.keys(players).length > 0) out.players = players;
    const dm = this.dm.get();
    if (dm) out.dm = dm;
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
