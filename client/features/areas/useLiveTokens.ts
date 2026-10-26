import { useEffect, useMemo, useState } from "react";
import type { Token } from "#shared/model.ts";
import { useTreeShownStore, useTreeShownView } from "../../canvas/relief/context.ts";
import { localDragSlot } from "../../state/localDrags.ts";
import { useScoped } from "../../state/scope.ts";
import { dragSpots, parseSpotsKey, spotsKey, withSpots } from "./liveTokens.ts";
import { REST_MS } from "./store.ts";

const EMPTY_TOKENS: Record<string, Token> = {};

/**
 * The view's tokens with every drag in progress applied (liveTokens.ts):
 * other members' previews and this device's own drags. `moving` is true
 * while a dragged token is still changing cells, so a caller samples area
 * boundaries coarsely then and refines once the drag rests for a moment,
 * as the area tool's own preview does (design 9.3). In a board's drawing
 * tree that is hidden it holds its last read (canvas/relief/context.ts), so
 * a drag in the other view works for nothing there.
 */
export function useLiveTokens(): { tokens: Record<string, Token>; moving: boolean } {
  const tokens = useTreeShownView((s) => s.view?.tokens ?? EMPTY_TOKENS);
  const remote = useTreeShownView((s) => (s.view ? spotsKey(dragSpots(s.view.tokens, Object.values(s.ephemeral.drags))) : ""));
  const local = useTreeShownStore(useScoped(localDragSlot), (s) => spotsKey(dragSpots(tokens, Object.entries(s.spots).map(([tokenId, at]) => ({ tokenId, ...at })))));
  const key = remote && local ? `${remote}|${local}` : remote || local;
  const live = useMemo(() => {
    if (!remote && !local) return tokens;
    // This device's own drag wins over a preview of the same token from elsewhere.
    const spots = new Map([...parseSpotsKey(remote), ...parseSpotsKey(local)]);
    return withSpots(tokens, spots) as Record<string, Token>;
  }, [tokens, remote, local]);

  const [rested, setRested] = useState("");
  useEffect(() => {
    if (!key) return;
    const timer = setTimeout(() => setRested(key), REST_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return { tokens: live, moving: key !== "" && key !== rested };
}
