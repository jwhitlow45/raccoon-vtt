import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { hiddenIn, idAt, type Hidden } from "#shared/privTestutil.ts";
import { rng } from "#shared/testutil.ts";
import type { ActorOptions } from "./actor.ts";
import { each, openRooms, Room, same as sameFrames, type Event, type Rooms, type Who } from "./numberingTesting.ts";
import { until } from "./undoScopeTesting.ts";

/**
 * The player limits twins (limits.twin.test.ts, ids.twin.test.ts,
 * limits.random.test.ts) on the creature number tests' rooms
 * (numberingTesting.ts): room A and room B differ only where P1's copy
 * never reaches, take the same members' ops at the same clock times, and
 * give P1 and the display the same frames. Each twin's frames are scanned
 * raw for what only that twin holds before they are compared.
 */

/** An op's answer: "taken", "retry" when the room asked the device to send it again later, or its refusal's code and words. */
export type Answer = "taken" | "retry" | { code: string; message: string };

export type Twins = Rooms & { hidden: [Hidden, Hidden] };

/** Opens room A and room B with P1's first chat taken in each, whose batch explores what the fixture shows. */
export async function openTwins(t: TestContext, a: RoomState, b: RoomState, hidden: { a?: string[]; b?: string[] } = {}, options: Partial<ActorOptions> = {}): Promise<Twins> {
  const pair = (await openRooms(t, a, b, options)) as Twins;
  pair.hidden = [{ ids: [...(hidden.a ?? [])], names: [] }, { ids: [...(hidden.b ?? [])], names: [] }];
  await each(pair, (room) => room.apply("p1", { t: "log.chat", text: "ready" }));
  return pair;
}

function answerOf(event: Event, n: number): Answer {
  const refusal = event.rejects?.find((r) => r.n === n);
  return refusal ? { code: refusal.code, message: refusal.message ?? "" } : "taken";
}

/** A member's op, sent as Room.send does, and its answer. */
export async function answer(room: Room, who: Who, op: Op): Promise<Answer> {
  const event = await room.send(who, op);
  return answerOf(event, room.clients[who].n);
}

/**
 * Members' ops sent at once, each without waiting for the one before, so
 * they land in one batch, and each op's answer in order. The clock moves a
 * second first, as Room.send moves it, unless `tick` is false.
 */
export async function together(room: Room, sends: ReadonlyArray<readonly [Who, Op]>, tick = true): Promise<Answer[]> {
  if (tick) room.clock.now += 1_000;
  const ns = sends.map(([who, op]) => {
    const client = room.clients[who];
    const n = ++client.n;
    void room.actor.op(client.conn, n, op);
    return [client, n] as const;
  });
  const answers = await Promise.all(
    ns.map(([client, n]) =>
      until((): Answer | undefined => {
        for (const m of client.sent) {
          if (m.t === "retry" && m.n === n) return "retry";
          if (m.t === "ev" && (m.acks?.includes(n) || m.rejects?.some((r) => r.n === n))) return answerOf(m, n);
        }
        return undefined;
      }, `answer ${n}`),
    ),
  );
  await room.settle();
  return answers;
}

/** Each room's answer to the same op, the same in both, and that answer. */
export async function bothAnswer(pair: Twins, who: Who, op: Op | ((room: Room) => Op), what: string): Promise<Answer> {
  const answers: Answer[] = [];
  for (const room of pair) answers.push(await answer(room, who, typeof op === "function" ? op(room) : op));
  assert.deepEqual(answers[0], answers[1], `${what}: the same answer in both rooms`);
  return answers[0]!;
}

/** P1's and the display's frames, scanned raw for each room's own ids, then compared whole. */
export function same(pair: Twins, what: string): void {
  for (const [i, room] of pair.entries()) {
    const frames = room.pages.flatMap((p) => p.sent);
    assert.deepEqual(hiddenIn(frames, pair.hidden[i]!), [], `${what}: ${room.name}: no frame names what only this room holds`);
  }
  sameFrames(pair, what);
}

/**
 * Members' ids alike in both rooms, as a device mints at send: each room
 * draws from its own source seeded alike, and dates each id by its own
 * clock, which both rooms move alike, so the nth id is the same in both.
 */
export class Mint {
  readonly #sources = new Map<Room, () => number>();
  next(room: Room, aheadMs = 0): string {
    let r = this.#sources.get(room);
    if (!r) this.#sources.set(room, (r = rng(61)));
    return idAt(r, room.clock.now + aheadMs);
  }
}
