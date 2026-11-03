import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { revokeMember } from "../auth/admit.ts";
import { accessErrors, type AuthKit, HttpError, requireGrant, roomParam } from "../auth/http.ts";

const MemberParam = z.string().min(1).max(64);

/**
 * Kicking (design section 10.2): every grant the member holds in this room,
 * on every device, goes through the shared cleanup, which also deletes the
 * invites those devices minted, closes their sockets with 4001 and sets a
 * kicked DM member back to 'player'. The member stays in the roster, and a
 * kicked player who knows the password can rejoin, so keeping someone out
 * means changing the password too.
 *
 * Removing (S-15) is a kick that also takes the member off the roster, so a
 * leaked password cannot fill the roster with junk for good. A member that
 * still holds a grant must never be removed, so the kick comes first. A
 * device could still continue as the member, or a DM let a requester in as
 * it, between the kick and the removal, so its grants are swept once more
 * after: a grant committed before that sweep is deleted by it, and one
 * committed after it finds the member gone and gives itself up, exactly that
 * grant and no other (server/auth/admit.ts). A join that rolls back takes
 * its new member off the same way: revoke, remove, revoke again.
 *
 * Both revoke through `revokeMember`, which orders the kick after every
 * admission naming the member that began before it, so a grant from such
 * an admission is either never written or deleted before the kick answers.
 */
export async function registerMemberRoutes(app: FastifyInstance, kit: AuthKit): Promise<void> {
  await app.register(async (r) => {
    r.setErrorHandler(accessErrors);
    r.delete("/api/rooms/:id/members/:memberId/grants", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const target = MemberParam.safeParse((req.params as { memberId?: unknown }).memberId);
      if (!target.success) throw new HttpError(404, "member_not_found");
      if (target.data === grant.memberId) throw new HttpError(400, "cannot_kick_self");
      if (!(await kit.gateway.getMember(roomId, target.data))) throw new HttpError(404, "member_not_found");
      await revokeMember(kit, roomId, target.data);
      return reply.code(204).send();
    });

    r.delete("/api/rooms/:id/members/:memberId", async (req, reply) => {
      const roomId = roomParam(req);
      const grant = await requireGrant(kit, req, reply, roomId, "dm");
      const target = MemberParam.safeParse((req.params as { memberId?: unknown }).memberId);
      if (!target.success) throw new HttpError(404, "member_not_found");
      if (target.data === grant.memberId) throw new HttpError(400, "cannot_remove_self");
      if (!(await kit.gateway.getMember(roomId, target.data))) throw new HttpError(404, "member_not_found");
      await revokeMember(kit, roomId, target.data);
      await kit.gateway.removeMember(roomId, target.data);
      await revokeMember(kit, roomId, target.data);
      return reply.code(204).send();
    });
  });
}
