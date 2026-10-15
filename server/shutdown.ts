import type { FastifyInstance } from "fastify";

/**
 * The graceful shutdown (design 15.4), short of the process's exit.
 * `app.close()` closes every socket with 1012, cutting off a client slow to
 * answer (rooms/ws.ts), and lets each room finish its commit and write its
 * snapshot. A socket writes its session's last sight only once its close
 * has finished, so those writes may still be running then. The pool ends
 * after they settle, waiting at most `writesMs` so a slow database cannot
 * hold the deploy, and a write left behind is dropped without a word
 * (rooms/closeWrites.ts).
 */
export async function closeServer(app: FastifyInstance, endPool: () => Promise<void>, opts: { writesMs?: number } = {}): Promise<void> {
  await app.close();
  await app.rooms.closeWrites.close(opts.writesMs ?? 2_000);
  await endPool();
}
