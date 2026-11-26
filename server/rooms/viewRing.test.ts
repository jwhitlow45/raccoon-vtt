import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { compactLink, stateOf, wholeLink, type ViewLink } from "./viewRing.ts";

/*
 * Views kept as deltas against the next view (viewRing.ts) read back as the
 * very states that were published, over random runs of batches that copy
 * each record before writing it, as transactions do (shared/writable.ts).
 * Invariants, at every step and for every view kept:
 * (R1) the same JSON, so the same fields, keys and values in the same order;
 * (R2) every field's own keys, and every record's, in the published order;
 * (R3) every record entry and every other field the very object published;
 * (R4) reading one view, in any order, twice, changes no other;
 * (R5) a view a newer one follows holds no whole state.
 */

type Loose = Record<string, unknown>;

function rng(seed: number): () => number {
  return () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
}

function start(random: () => number): Loose {
  const tokens: Loose = {};
  for (let i = 0; i < 40; i++) tokens[`t${i}`] = { id: `t${i}`, x: Math.floor(random() * 50) };
  const numbered: Loose = {};
  for (let i = 0; i < 10; i++) numbered[String(i * 3)] = { n: i };
  return { meta: { name: "R" }, members: { dm: { id: "dm" } }, tokens, numbered, log: [], empty: {}, gone: undefined };
}

/** The next published state: some records copied and written, an array grown, a field added or dropped, a record rebuilt in another order. */
function step(prev: Loose, random: () => number, k: number): Loose {
  const next: Loose = { ...prev };
  for (const field of ["tokens", "numbered", "members", "empty"]) {
    if (random() < 0.5) continue;
    const rec: Loose = { ...(prev[field] as Loose) };
    const keys = Object.keys(rec);
    const edits = 1 + Math.floor(random() * (random() < 0.1 ? 40 : 3));
    for (let e = 0; e < edits; e++) {
      const r = random();
      const key = keys[Math.floor(random() * keys.length)];
      if (r < 0.4 && key !== undefined) rec[key] = { ...(rec[key] as Loose), x: k };
      else if (r < 0.6 && key !== undefined) delete rec[key];
      else if (r < 0.7) rec[String(Math.floor(random() * 40))] = { n: k };
      else if (r < 0.8 && key !== undefined) rec[key] = undefined;
      else rec[`n${k}_${e}`] = { id: `n${k}_${e}` };
    }
    // Now and then a record built afresh in another key order.
    next[field] = random() < 0.1 ? Object.fromEntries(Object.entries(rec).reverse()) : rec;
  }
  if (random() < 0.3) next.log = [...(prev.log as unknown[]), { id: `${k}:0` }].slice(-20);
  if (random() < 0.1) next.meta = { ...(prev.meta as Loose), name: `R${k}` };
  if (random() < 0.1) {
    if (Object.hasOwn(next, "clock")) delete next.clock;
    else next.clock = { at: k };
  }
  if (random() < 0.05) next.tokens = [1, 2, 3];
  // A field that goes undefined, then absent, then holds a value again, in any order.
  const r = random();
  if (r < 0.15) next.opt = undefined;
  else if (r < 0.3) delete next.opt;
  else if (r < 0.4) next.opt = { x: k };
  return next;
}

function sameAsPublished(read: Loose, published: Loose, where: string): void {
  assert.equal(JSON.stringify(read), JSON.stringify(published), `${where}: R1`);
  assert.deepEqual(Object.keys(read), Object.keys(published), `${where}: R2 fields`);
  for (const field of Object.keys(published)) {
    const was = published[field];
    const now = read[field];
    if (was !== null && typeof was === "object" && !Array.isArray(was) && now !== was) {
      assert.deepEqual(Object.keys(now as Loose), Object.keys(was as Loose), `${where}: R2 ${field}`);
      for (const key of Object.keys(was as Loose)) assert.equal((now as Loose)[key], (was as Loose)[key], `${where}: R3 ${field}.${key}`);
    } else assert.equal(now, was, `${where}: R3 ${field}`);
  }
}

test("every kept view reads back as the state published, in its own key order, however the next views wrote their records", () => {
  for (let run = 0; run < 40; run++) {
    const random = rng(run + 1);
    const published: Loose[] = [start(random)];
    const links: ViewLink[] = [wholeLink(published[0] as unknown as RoomState)];
    const states: RoomState[] = [published[0] as unknown as RoomState];
    for (let k = 1; k <= 60; k++) {
      const next = step(published.at(-1)!, random, k);
      const link = wholeLink(next as unknown as RoomState);
      states[states.length - 1] = compactLink(links.at(-1)!, link);
      published.push(next);
      links.push(link);
      states.push(next as unknown as RoomState);
      // A view read now and then, as a reader would, before any later view joins.
      if (random() < 0.3) {
        const i = Math.floor(random() * states.length);
        sameAsPublished(states[i] as unknown as Loose, published[i]!, `run ${run} step ${k} view ${i} early`);
      }
    }
    const order = states.map((_, i) => i).sort(() => random() - 0.5);
    for (const pass of [1, 2]) for (const i of order) sameAsPublished(states[i] as unknown as Loose, published[i]!, `run ${run} pass ${pass} view ${i}`);
    for (const link of links.slice(0, -1)) assert.equal(link.whole, null, `run ${run}: R5`);
    assert.equal(stateOf(links.at(-1)!), published.at(-1), "the newest view is the state published");
  }
});

test("a field held as undefined that the next view lacks reads undefined, though a later view holds it again", () => {
  const s0 = { meta: 1, f: undefined } as unknown as RoomState;
  const s1 = { meta: 1 } as unknown as RoomState;
  const s2 = { meta: 1, f: { x: 5 } } as unknown as RoomState;
  const [l0, l1, l2] = [wholeLink(s0), wholeLink(s1), wholeLink(s2)];
  const v0 = compactLink(l0, l1);
  compactLink(l1, l2);
  assert.deepEqual(Object.keys(v0), ["meta", "f"]);
  assert.equal((v0 as unknown as Loose).f, undefined);
});

test("a view a batch moved one token of 2,000 in keeps that token alone", () => {
  const tokens: Record<string, unknown> = {};
  for (let i = 0; i < 2_000; i++) tokens[`t${i}`] = { id: `t${i}`, x: i };
  const older = { meta: {}, tokens } as unknown as RoomState;
  const newer = { ...older, tokens: { ...tokens, t7: { id: "t7", x: -1 } } } as unknown as RoomState;
  const link = wholeLink(older);
  const read = compactLink(link, wholeLink(newer));
  const delta = link.delta!.fields.get("tokens");
  assert.ok(delta?.kind === "record");
  assert.deepEqual([...delta.changed.keys()], ["t7"]);
  assert.equal(link.delta!.fields.has("meta"), false, "a field the newer view shares is not kept");
  assert.equal((read.tokens as unknown as Record<string, unknown>).t7, tokens.t7);
});
