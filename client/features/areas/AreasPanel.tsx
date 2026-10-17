import { useCallback, useMemo } from "react";
import type { AreaTemplate, RoomState } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { usePanelHere, type PanelProps } from "../panels.ts";
import { AreaDamage } from "./AreaDamage.tsx";
import { pickTemplate } from "./AreaTool.tsx";
import { caughtTokens, contextFrom, inAreaEntries, inAreaText } from "./coverage.ts";
import { areaTitle } from "./labels.ts";
import { triggerSummary } from "./placement.ts";
import { canEdit, deleteTemplate, openDamage, samplesNow, useAreaScope, useAreaTool } from "./store.ts";
import { useLiveTokens } from "./useLiveTokens.ts";

/**
 * Every area on the scene and who is in it, kept live as tokens move. This
 * is where an aura such as Spirit Guardians or Conjure Minor Elementals is
 * watched while the party walks with the select tool, which is when the
 * area tool's own bar is closed. The DM also deals an area's damage here,
 * in a form that takes the panel's place (AreaDamage.tsx).
 */

const EMPTY: RoomState["templates"] = {};

export default function AreasPanel(props: PanelProps) {
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const you = useRoomView((s) => s.you);
  const templates = useRoomView((s) => s.view?.templates ?? EMPTY);
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const area = useAreaScope();
  const here = usePanelHere();
  // Kept live while tokens are dragged, here or on another device.
  const live = useLiveTokens();
  const damageId = useAreaTool((s) => s.damageId);
  const scene = sceneId ? view?.scenes[sceneId] : undefined;
  const list = useMemo(() => Object.values(templates).filter((t): t is AreaTemplate => !!t && t.sceneId === sceneId), [templates, sceneId]);
  const closeDamage = useCallback(() => area.store.setState({ damageId: null }), [area]);
  if (!view || !scene || !you) return null;

  const damaged = damageId ? templates[damageId] : undefined;
  if (you.role === "dm" && damaged && damaged.sceneId === scene.id) return <AreaDamage template={damaged} onDone={closeDamage} />;
  const ctx = contextFrom({ tokens: live.tokens, buildChunks: view.buildChunks, settings: view.meta.settings }, scene, samplesNow(live.moving));
  const env = { actions, view, scene, role: you.role, youId: you.memberId, area };

  if (list.length === 0) {
    return <Empty>No areas on this map. Pick the Area tool, then tap a token to cast from it or search a spell.</Empty>;
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(2) }}>
      {list.map((t) => {
        const entries = inAreaEntries(caughtTokens(t, ctx, scene.id), live.tokens, view.characters);
        const caster = t.casterId ? view.tokens[t.casterId] : undefined;
        const attached = t.attachedTo ? view.tokens[t.attachedTo] : undefined;
        const editable = canEdit(env, t);
        return (
          <li
            key={t.id}
            style={{
              display: "grid",
              gap: theme.space(1),
              padding: theme.space(3),
              borderRadius: theme.radius.md,
              background: theme.color.surfaceRaised,
              // Longhands, so the stripe in the area's own color takes the left edge of the outline.
              borderTop: `${theme.line.border}px solid ${theme.color.border}`,
              borderRight: `${theme.line.border}px solid ${theme.color.border}`,
              borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
              borderLeft: `${theme.line.stripe}px solid ${t.color}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: theme.space(2), flexWrap: "wrap" }}>
              <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, overflowWrap: "anywhere" }}>{areaTitle(t)}</span>
              <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
                {attached ? `on ${displayName(attached)}` : caster ? `cast by ${displayName(caster)}` : ""}
                {t.visibility === "dm" ? " · hidden from players" : ""}
              </span>
            </div>
            <div style={{ fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
              <span style={{ color: theme.color.textMuted }}>In area{entries.length ? ` (${entries.length})` : ""}: </span>
              {inAreaText(entries)}
            </div>
            {triggerSummary(t.triggers) ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{triggerSummary(t.triggers)}</div> : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), marginTop: theme.space(1) }}>
              <Button
                size="sm"
                onClick={() => {
                  pickTemplate(scope, t.id, actions);
                  ui.setTool("area");
                  // The tool's bar shows only with no sheet open on a phone.
                  props.close();
                }}
              >
                {editable ? "Edit" : "Show"}
              </Button>
              {/* Every area's button is named Damage, so Back from the damage form finds this one by its area's id (features/panels.ts useSubpageFocus). */}
              {you.role === "dm" ? (
                <Button size="sm" onClick={() => openDamage(area, ui, t.id, here)} data-opener={`area-${t.id}`}>
                  Damage
                </Button>
              ) : null}
              {editable ? (
                <Button size="sm" variant="danger" onClick={() => deleteTemplate(env, t.id)}>
                  Delete
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
