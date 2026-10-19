import { useEffect, useMemo, useState } from "react";
import type { CastAsk } from "#shared/model.ts";
import { Button } from "../../../components/Button.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Loading } from "../../../components/Loading.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { areaContext, caughtTokens } from "../../areas/coverage.ts";
import { cardStyle } from "../../rolls/parts.tsx";
import { Note } from "../../tokens/ui.tsx";
import { ReplaceConfirm } from "../groupSave/ReplaceConfirm.tsx";
import { useStartGroupSave, type StartInput } from "../groupSave/start.ts";
import { useDiceView } from "../useDiceView.ts";
import { castCardText, castStart, castWho } from "./castStart.ts";

/**
 * A player's ask for saves on the DM's desk (docs/design-v1-player-save-spell.md
 * 3.3 and 6): the ask in a line, the caster's roll, the area's count (hidden
 * creatures included) or the targets, then Open, which starts the group save
 * filled from the DM's own view, and Dismiss, which is final. It sits above
 * the live cards in their look, and folds to its first line as they do.
 */
export function CastCard(props: { ask: CastAsk; open: boolean; onToggle(): void; toggleRef(el: HTMLButtonElement | null): void }) {
  const { ask } = props;
  const view = useRoomView((s) => s.view);
  const viewing = useRoomView((s) => s.sceneId);
  const actions = useRoomActions();
  const [opening, setOpening] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokens = view?.tokens;
  const template = ask.area !== undefined ? view?.templates[ask.area] : undefined;
  const scene = view?.scenes[ask.sceneId];
  // The DM's page catches every creature in the area, hidden ones included, so the card counts as it will.
  const caught = useMemo(() => {
    if (!view || !template || !scene || viewing !== ask.sceneId) return null;
    return caughtTokens(template, areaContext(view, scene), template.sceneId).length;
  }, [tokens, template, scene, viewing, ask.sceneId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!view) return null;
  const text = castCardText(view, ask, { viewing, caught });

  const open = () => {
    setError(null);
    // The page needs its scene's tokens (doc 3 5.10), so an ask on another scene goes there first.
    if (viewing !== ask.sceneId) actions.switchScene(ask.sceneId);
    setOpening(true);
  };
  const dismiss = () => {
    setError(null);
    setDismissing(true);
    const n = actions.dispatch(
      { t: "cast.close", castId: ask.id, end: "dismissed" },
      {
        quiet: true,
        onAnswer: (answer, refusal) => {
          setDismissing(false);
          if (answer === "refused") setError(refusal?.text || refusal?.message || "It was not set aside.");
          else if (answer === "unknown") setError("This may have happened. Check the log.");
        },
      },
    );
    if (n === null) {
      setDismissing(false);
      setError("Setting it aside needs a connection.");
    }
  };

  return (
    <section role="group" aria-label={text.short} style={{ ...cardStyle, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <button
        ref={props.toggleRef}
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        style={{
          minWidth: 0,
          minHeight: theme.touch,
          display: "flex",
          alignItems: "center",
          gap: theme.space(1),
          padding: 0,
          background: "transparent",
          border: "none",
          color: theme.color.text,
          fontFamily: theme.font.body,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <Icon name={props.open ? "chevronDown" : "chevronRight"} size="sm" />
        <span style={{ flex: 1, minWidth: 0, fontWeight: theme.weight.bold, fontSize: theme.font.body14 }}>{props.open ? text.title : text.short}</span>
      </button>
      {props.open ? (
        <>
          <span style={{ fontSize: theme.font.small, fontVariantNumeric: "tabular-nums" }}>{text.rolled}</span>
          {text.where ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>{text.where}</span> : null}
          {text.gone ? <Note tone="error">{text.gone}</Note> : null}
          {opening && !text.gone ? (
            <CastOpen ask={ask} onDone={() => setOpening(false)} />
          ) : (
            <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
              {text.gone ? null : (
                <Button size="sm" variant="primary" aria-label={text.openName} onClick={open}>
                  {text.open}
                </Button>
              )}
              <Button size="sm" aria-label={text.dismissName} busy={dismissing} onClick={dismiss}>
                Dismiss
              </Button>
            </div>
          )}
          {error ? (
            <div role="alert">
              <Note tone="error">{error}</Note>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Open (3.3): once the ask's scene is on screen, reads the caster's stat
 * block, then starts the group save, asking first when one holds rolls
 * (ReplaceConfirm), as an area's Save and damage does.
 */
function CastOpen(props: { ask: CastAsk; onDone(): void }) {
  const { ask, onDone } = props;
  const start = useStartGroupSave();
  const here = useRoomView((s) => s.sceneId === ask.sceneId && s.view?.tokens[ask.caster] !== undefined);
  const who = useRoomView((s) => (s.view ? castWho(s.view, ask) : "the caster"));
  const creatures = useMemo(() => (here ? [{ tokenId: ask.caster }] : []), [here, ask.caster]);
  const { dice, loading } = useDiceView(creatures);
  const [pending, setPending] = useState<StartInput | null>(null);
  const input = useMemo<StartInput | null>(() => (here && dice && !loading ? castStart(dice, ask) : null), [here, dice, loading, ask]);
  useEffect(() => {
    if (!input || pending) return;
    if (start(input)) onDone();
    else setPending(input);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pending) return <Loading text={`Reading ${who}'s stat block…`} />;
  return (
    <ReplaceConfirm
      onDiscard={() => {
        if (start(pending, { replace: true })) onDone();
      }}
      onKeep={onDone}
    />
  );
}
