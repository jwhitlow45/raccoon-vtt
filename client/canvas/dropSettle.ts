import type { Point } from "../lib/camera.ts";

/** A node the board drew a dragged token on, with the token's id. */
export type SettleNode = { id: string; node: { position(at: Point): void; getLayer(): { batchDraw(): void } | null } };

/**
 * Puts each node of a drop's followers where this viewer's copy holds its
 * token, once the drop's answer lands (live play 40, LP40-HEXFILE-2). The
 * board draws a follower at its named holder's offset while the drop is on
 * its way, and the server's move may put it elsewhere: in single file each
 * walks its own walk, and one may end where it stood. The board redraws a
 * node only where its token's place changes, so a follower whose place
 * stayed kept the offset spot until a reload. `placeOf` is where a token is
 * drawn in the copy, or null for one this viewer no longer holds.
 */
export function settleFollowers(followers: readonly SettleNode[], placeOf: (id: string) => Point | null): void {
  for (const f of followers) {
    const at = placeOf(f.id);
    if (!at) continue;
    f.node.position(at);
    f.node.getLayer()?.batchDraw();
  }
}
