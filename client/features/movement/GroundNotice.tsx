import { useMemo } from "react";
import type { Token } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { tokenAccess } from "../tokens/access.ts";
import { belowGround, belowGroundText } from "./ground.ts";

const EMPTY = {};

/**
 * "Inside the ground (10 ft below). Stand on it" (docs/design-v1-maps-vision.md
 * 4.2), on a token's action bar and its panel, for its owners and the DM.
 * Stand on it sets its elevation to the ground under it, which only those
 * who may change its elevation see.
 */
export function GroundNotice(props: { token: Token }) {
  const { token } = props;
  const actions = useRoomActions();
  const you = useRoomView((s) => s.you);
  const chunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY);
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const below = useMemo(() => belowGround(chunks, token), [chunks, token]);
  if (!below || !you) return null;
  const access = tokenAccess({ role: you.role, memberId: you.memberId, view: { characters: character ? { [character.id]: character } : {} }, token });
  if (!access.dm && !access.owner) return null;
  return (
    <div role="note" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(2), color: theme.color.warning, fontSize: theme.font.body14 }}>
      <span style={{ flex: "1 1 160px" }}>{belowGroundText(below.depth)}</span>
      {access.canEditToken("elevation") ? (
        <Button size="sm" onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { elevation: below.ground } })}>
          Stand on it
        </Button>
      ) : null}
    </div>
  );
}
