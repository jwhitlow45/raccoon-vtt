import { useId, useState } from "react";
import type { RoomState } from "#shared/model.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { buttonLook } from "../../components/looks.ts";
import { theme } from "../../lib/theme.ts";
import type { OnAnswer } from "../../state/types.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { offerGone } from "../dice/cast/cast.ts";
import { useOption, useOptionStore, type SlotOffer as Offer } from "../dice/optionState.ts";
import { sameSpell } from "../dice/options.ts";
import { useAnyPending } from "../encounter/hooks.ts";
import { reasonText } from "../resources/logic.ts";
import { offerLine, offerPools } from "./logic.ts";

/** The character a creature plays: its own, or its token's. */
export function characterIdOfCreature(view: Pick<RoomState, "tokens">, creature: ActorTarget): string | undefined {
  if ("characterId" in creature) return creature.characterId;
  const token = view.tokens[creature.tokenId];
  return token && "ref" in token.actor ? token.actor.ref : undefined;
}

/**
 * The slot offers of a creature's sent asks for saves (docs/design/design-v1-slots.md
 * 3.2), under the spell's row (`spell`), or with `others`, every offer whose
 * spell no row of the creature names (`rows`), as the fallback line under
 * its options. A cast ask never spends a slot itself.
 */
export function SlotOffers(props: { creatureKey: string; spell?: string; others?: readonly string[] }) {
  const offers = useOption((s) => s.offers);
  const mine = Object.values(offers).filter((o) => o.key === props.creatureKey && (props.spell !== undefined ? sameSpell(o.spell, props.spell) : !(props.others ?? []).some((name) => sameSpell(o.spell, name))));
  if (mine.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {mine.map((o) => (
        <OfferLine key={`${o.key}|${o.spell}`} offer={o} />
      ))}
    </div>
  );
}

/**
 * One offer: "Cast at level 3." and a button per pool that can cast it
 * there (D-261127-363, 400, 408), each off with its "left" reason, beside
 * Dismiss. Use waits for the answer, busy and deaf to a second tap, and
 * once taken the offer goes.
 */
function OfferLine(props: { offer: Offer }) {
  const { offer } = props;
  const store = useOptionStore();
  const actions = useRoomActions();
  const id = useId();
  const character = useRoomView((s) => s.view?.characters[offer.characterId]);
  const [sent, setSent] = useState<{ n: number; kind: string } | null>(null);
  const busy = useAnyPending(sent === null ? [] : [sent.n]);
  const [status, setStatus] = useState<string | null>(null);
  const pools = offerPools(character, offer.level);
  const dismiss = () => store.setState((s) => ({ offers: offerGone(s.offers, offer.key, offer.spell) }));
  const use = (kind: string, op: ClientOp) => {
    if (busy) return;
    const onAnswer: OnAnswer = (answer, refusal) => {
      if (answer === "refused") setStatus(reasonText(refusal));
      else if (answer === "taken") dismiss();
    };
    const n = actions.dispatch(op, { quiet: true, onAnswer });
    if (n === null) setStatus("That could not be sent.");
    else {
      setStatus(null);
      setSent({ n, kind });
    }
  };
  if (pools.length === 0) return null;
  return (
    <div role="group" aria-label={`${offer.spell}: ${offerLine(offer.level)}`} data-slot-offer="" style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ fontSize: theme.font.body14, lineHeight: theme.leading.body }}>{offerLine(offer.level)}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        {pools.map((pool) => (
          <span key={pool.kind} style={{ display: "contents" }}>
            <Button
              size="sm"
              aria-disabled={pool.off !== null || undefined}
              aria-describedby={pool.off !== null ? `${id}-${pool.kind}` : undefined}
              busy={busy && sent?.kind === pool.kind}
              onClick={() => (pool.off !== null ? setStatus(pool.off) : use(pool.kind, pool.op))}
              style={{ flex: "1 1 auto", ...(pool.off !== null ? { ...buttonLook("secondary", { disabled: true }), cursor: "default" } : null) }}
            >
              {pool.text}
            </Button>
            {pool.off !== null ? (
              <span id={`${id}-${pool.kind}`} hidden>
                {pool.off}
              </span>
            ) : null}
          </span>
        ))}
        <Button size="sm" aria-label={`Dismiss the slot offer for ${offer.spell}`} onClick={dismiss} style={{ flex: "0 1 auto" }}>
          Dismiss
        </Button>
      </div>
      {status ? (
        <p role="status" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
          {status}
        </p>
      ) : null}
    </div>
  );
}
