import { useCallback, useId, useMemo, useState, useSyncExternalStore } from "react";
import type { Member } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Select } from "../../components/Field.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Switch } from "../../components/Switch.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { currentFocus, focusEvent, subscribeFocus } from "./camera.ts";
import { PlayerPreview } from "./PlayerPreview.tsx";
import { PartySightToggle } from "../vision/PartySightToggle.tsx";

/**
 * The DM's view tools (features section 13), in two groups by what they do
 * (docs/design-v1-layout-hierarchy.md M4). "Players' screens" acts on the
 * table: follow me, bring everyone here, black out. "Check their view"
 * only looks: view as a player and party sight. Undo and redo follow.
 */
export function ViewControls() {
  const actions = useRoomActions();
  const view = useRoomView((s) => s.view?.meta.view);
  const members = useRoomView((s) => s.view?.members);
  const sceneId = useRoomView((s) => s.sceneId);
  const playerSceneId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const playerSceneName = useRoomView((s) => (playerSceneId ? s.view?.scenes[playerSceneId]?.name : undefined));
  const onPlayerScene = sceneId !== null && sceneId === playerSceneId;
  const scope = useRoomScope();
  const subscribe = useCallback((listener: () => void) => subscribeFocus(scope, listener), [scope]);
  const focusScene = useSyncExternalStore(subscribe, () => currentFocus(scope)?.sceneId ?? null);
  const [sent, setSent] = useState(false);

  if (!view) return null;
  return (
    <>
      <Section label="Players' screens">
        {!onPlayerScene ? (
          <Notice role="status">
            You are looking at a different scene than the players{playerSceneName ? `, who are on ${playerSceneName}` : ""}. Follow
            me and Bring everyone here move players only while you look at their scene.
          </Notice>
        ) : null}
        <Switch
          label="Follow me"
          help="Players' maps follow yours as you pan and zoom, until you turn this off."
          checked={view.follow}
          onChange={(follow) => actions.dispatch({ t: "view.follow", follow })}
        />
        <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(2)}px 0` }}>
          <Button
            size="sm"
            disabled={!onPlayerScene || focusScene !== sceneId}
            onClick={() => {
              const f = currentFocus(scope);
              if (!f || f.sceneId !== sceneId) return;
              actions.sendEph(focusEvent(f));
              setSent(true);
            }}
            style={{ justifySelf: "start" }}
          >
            Bring everyone here
          </Button>
          <Help>{sent ? "Done. Players' maps moved to what you see now." : "Moves every player's map to what you see now, once."}</Help>
        </div>
        <Switch
          label="Black out players' screens"
          help={'Players see only black and "The DM has paused the game." Use it for a break or before a reveal.'}
          checked={view.blackout}
          onChange={(blackout) => actions.dispatch({ t: "view.blackout", blackout })}
        />
      </Section>
      <Section label="Check their view">
        <ViewAsPlayer members={members} onPlayerScene={onPlayerScene} playerSceneId={playerSceneId} />
        <PartySightToggle />
      </Section>
      <Section label="Undo">
        <Help>Undo or redo your own last changes, one at a time.</Help>
        <div style={{ display: "flex", gap: theme.space(2) }}>
          <Button size="sm" onClick={() => actions.undo()}>
            Undo
          </Button>
          <Button size="sm" onClick={() => actions.redo()}>
            Redo
          </Button>
        </div>
      </Section>
    </>
  );
}

function ViewAsPlayer(props: { members: Record<string, Member | undefined> | undefined; onPlayerScene: boolean; playerSceneId: string | null }) {
  const actions = useRoomActions();
  const selectId = useId();
  const players = useMemo(
    () =>
      Object.values(props.members ?? {})
        .filter((m): m is Member => m !== undefined && m.kind === "player")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [props.members],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<Member | null>(null);
  const exit = useCallback(() => setPreviewing(null), []);
  const chosen = players.find((p) => p.id === picked) ?? players[0];

  if (players.length === 0) return <Help>View as a player: no players have joined yet.</Help>;
  return (
    <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0 ${theme.space(2)}px` }}>
      <label htmlFor={selectId} style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>
        View as a player
      </label>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Select id={selectId} value={chosen?.id ?? ""} onChange={(e) => setPicked(e.target.value)} style={{ flex: 1 }}>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={!chosen}
          onClick={() => {
            if (!chosen) return;
            // The DM's view holds only the scene the DM is looking at, so go where the players are.
            if (!props.onPlayerScene && props.playerSceneId) actions.switchScene(props.playerSceneId);
            setPreviewing(chosen);
          }}
        >
          View
        </Button>
      </div>
      <Help>
        Shows exactly what that player sees, with fog and without hidden things. Nothing you do there is saved.
        {!props.onPlayerScene ? " This also takes you to the players' scene." : ""}
      </Help>
      {previewing ? <PlayerPreview memberId={previewing.id} name={previewing.name} onExit={exit} /> : null}
    </div>
  );
}
