import type { FastifyInstance } from "fastify";
import { request, type Dispatcher } from "undici";
import { z } from "zod";
import { ddbCharacterId, ddbCharacterUrl } from "#shared/ddb/link.ts";
import { readDdbCharacter } from "#shared/ddb/read.ts";
import { checkedFill } from "#shared/rules/pcFill.ts";
import { WindowLimiter } from "../assets/limits.ts";
import { Semaphore } from "../assets/slots.ts";
import { accessRoutes, HttpError, parseBody, roomParam } from "../auth/http.ts";
import { clientIp } from "../auth/clientIp.ts";
import { ipKey } from "../auth/ipKey.ts";

/**
 * A public D&D Beyond character read into a stat block's fill
 * (docs/design-v1-pc-stats.md 6.3): `POST /api/rooms/:id/ddb-import`, for
 * any member with a grant, under the app's CSRF rule. The server builds the
 * one address it fetches from the character's digits, so no member's URL
 * is ever fetched, and goes out on the strict egress port, whose squid
 * list names that host alone. It reads numbers and names, never text,
 * answers a few KB, and keeps no copy: the log line holds the status and
 * the byte count.
 *
 * What it costs is bounded three ways. Hourly budgets per session, address
 * and server are checked before and spent only when the request goes out.
 * A slot of two for the server and one for the room is held from before
 * the fetch through the read, and every end gives both back, so at most
 * two bodies of 5 MiB are in memory at once. Ten seconds for the whole
 * exchange, and a body counted as it streams.
 */

export type DdbImportOptions = {
  /** The strict egress port (server/assets/egress.ts), or a test's fake. */
  dispatcher: Dispatcher;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  budgets?: { session: number; ip: number; server: number };
  slots?: { server: number; room: number };
};

const DEFAULTS = { timeoutMs: 10_000, maxBytes: 5 * 1024 * 1024, budgets: { session: 20, ip: 60, server: 300 }, slots: { server: 2, room: 1 } };
const HOUR = 3600_000;

const Body = z.strictObject({ link: z.string().min(1).max(300) });

type Fetched = { kind: "body"; status: number; json: unknown; bytes: number } | { kind: "failed" };

/**
 * The pending request, ended by the signal however far it got. undici
 * aborts a request only once it holds a connection, and a proxy that keeps
 * its CONNECT open never gives it one, so the route would wait for the
 * proxy's own limit, a minute or more on squid, with both slots held and
 * the room's next import refused as busy. A request that answers after the
 * signal is thrown away.
 */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal, discard: (late: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      pending.then(discard, () => undefined);
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * One GET of the character's JSON: no cookie or credential, identity
 * encoding, no redirect followed (undici's request follows none), and at
 * most `maxBytes` counted while it streams. A body that is not JSON reads
 * as null, so a challenge page and a block in front of D&D Beyond read
 * alike.
 */
async function fetchCharacter(dispatcher: Dispatcher, url: string, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<Fetched> {
  try {
    const pending = request(url, {
      dispatcher,
      method: "GET",
      headers: { accept: "application/json", "accept-encoding": "identity", "user-agent": "raccoon-vtt (self-hosted virtual tabletop)" },
      signal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const res = await untilAborted(pending, signal, (late) => late.body.destroy());
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += (chunk as Buffer).length;
      if (bytes > maxBytes) {
        res.body.destroy();
        return { kind: "failed" };
      }
      chunks.push(chunk as Buffer);
    }
    let json: unknown = null;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json = null;
    }
    return { kind: "body", status: res.statusCode, json, bytes };
  } catch {
    // A timeout, an abort, a refused connection or a TLS failure: one answer, so none says more about the network.
    return { kind: "failed" };
  }
}

/** D&D Beyond's answer as the route's: a JSON 200 is read, a refusal with JSON or `success: false` is private, 404 is not found, anything else failed. */
function judge(fetched: Fetched): { ok: true; json: unknown } | { ok: false; status: number; code: "private" | "not_found" | "fetch_failed" } {
  if (fetched.kind === "failed") return { ok: false, status: 502, code: "fetch_failed" };
  const { status, json } = fetched;
  const body = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (status === 200 && body) return body.success === false ? { ok: false, status: 403, code: "private" } : { ok: true, json };
  if ((status === 401 || status === 403) && body) return { ok: false, status: 403, code: "private" };
  if (status === 404) return { ok: false, status: 404, code: "not_found" };
  return { ok: false, status: 502, code: "fetch_failed" };
}

export async function registerDdbImportRoutes(app: FastifyInstance, options: DdbImportOptions): Promise<void> {
  const opts = { ...DEFAULTS, ...options };
  const hourly = new WindowLimiter(HOUR, opts.now);
  const server = new Semaphore(opts.slots.server);
  // A room's slot exists only while an import of that room runs, so the map holds at most the server's slots.
  const rooms = new Map<string, Semaphore>();
  const trustCf = app.config.TRUST_CF_CONNECTING_IP === "1";

  function roomSlot(roomId: string): (() => void) | null {
    let slot = rooms.get(roomId);
    if (!slot) {
      slot = new Semaphore(opts.slots.room);
      rooms.set(roomId, slot);
    }
    const release = slot.tryAcquire();
    if (!release) return null;
    const held = slot;
    return () => {
      release();
      if (held.inUse === 0 && rooms.get(roomId) === held) rooms.delete(roomId);
    };
  }

  await accessRoutes(app, (r) => {
    r.post("/api/rooms/:id/ddb-import", async (req, reply) => {
      const roomId = roomParam(req);
      const { link } = parseBody(Body, req.body);
      const grant = await app.auth.grant(req, reply, roomId);
      if (!grant) throw new HttpError(403, "no_access");
      const id = ddbCharacterId(link);
      if (!id) throw new HttpError(400, "bad_url");

      const ip = ipKey(clientIp(req, trustCf));
      const budgets = [
        { code: "quota_member" as const, check: { key: `s:${grant.sessionId}`, limit: opts.budgets.session } },
        { code: "quota_ip" as const, check: { key: `ip:${ip}`, limit: opts.budgets.ip } },
        { code: "quota_global" as const, check: { key: "server", limit: opts.budgets.server } },
      ];
      for (const b of budgets) {
        const wait = hourly.retryAfter([b.check]);
        if (wait > 0) throw new HttpError(429, b.code, { retryAfter: wait });
      }

      const releaseServer = server.tryAcquire();
      const releaseRoom = releaseServer ? roomSlot(roomId) : null;
      if (!releaseServer || !releaseRoom) {
        releaseServer?.();
        throw new HttpError(429, "busy", { retryAfter: 5 });
      }
      // The member's request closing aborts the fetch, so a closed tab frees both slots at once.
      const closed = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableFinished) closed.abort();
      };
      reply.raw.once("close", onClose);
      try {
        hourly.record(budgets.map((b) => b.check));
        const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(opts.timeoutMs)]);
        const fetched = await fetchCharacter(opts.dispatcher, ddbCharacterUrl(id), signal, opts.timeoutMs, opts.maxBytes);
        req.log.info({ ddbStatus: fetched.kind === "body" ? fetched.status : "failed", bytes: fetched.kind === "body" ? fetched.bytes : 0 }, "ddb import");
        const verdict = judge(fetched);
        if (!verdict.ok) throw new HttpError(verdict.status, verdict.code);
        const fill = checkedFill(readDdbCharacter(verdict.json));
        if (!fill) throw new HttpError(422, "unreadable");
        reply.header("cache-control", "no-store");
        return { fill };
      } finally {
        reply.raw.off("close", onClose);
        releaseServer();
        releaseRoom();
      }
    });
  });
}
