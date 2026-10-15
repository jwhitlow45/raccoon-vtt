import type { ReactNode } from "react";
import { useStore } from "zustand";
import type { AreaShape, AreaTemplate, AreaTrigger } from "#shared/model.ts";
import { AREA_MAX_FT, AREA_MIN_FT, canPitch, emanationFootprint, MAX_PITCH, pitchOf, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { boxDistanceFt, pointCellBox, tokenCellBox } from "#shared/rules/distance.ts";
import { displayName } from "../../lib/scene.ts";
import { Icon } from "../../components/Icon.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Swatches } from "../../components/Swatches.tsx";
import { MEMBER_COLORS, theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { InfoLine, OptButton, OptInput, OptionsColumn, OptionsRow, OptSelect, Stepper, StepValue } from "../measure/controls.tsx";
import { caughtTokens, contextFrom, inAreaEntries, inAreaText } from "./coverage.ts";
import { areaTitle, shapeName, SHAPES } from "./labels.ts";
import {
  aimText,
  AREA_TRIGGERS,
  clampPitch,
  draftFromTemplate,
  freePointOf,
  liveOrigin,
  normalizeTriggers,
  usesFrom,
  withShape,
  type AreaDraft,
  type SnapMode,
} from "./placement.ts";
import { placementHint, presetDraft, searchAreaSpells } from "./presets.ts";
import {
  canEdit,
  cancelDraft,
  currentTemplate,
  deleteTemplate,
  liveContext,
  openDamage,
  placeDraft,
  samplesNow,
  select,
  setDraft,
  setShared,
  startDraft,
  updateTemplate,
  useAreaScope,
  type AreaEnv,
  type AreaToolState,
} from "./store.ts";
import { useLiveTokens } from "./useLiveTokens.ts";

/**
 * The area tool's options bar: what the area catches, then the controls.
 * The first line is the "In area" list (features section 9), names as this
 * viewer sees them with allies marked, recomputed as tokens move.
 */

const SNAPS: readonly { value: SnapMode; label: string }[] = [
  { value: "15", label: "15°" },
  { value: "45", label: "45°" },
  { value: "free", label: "Free" },
];

export function AreaOptions(props: { role: "dm" | "player" }) {
  const area = useAreaScope();
  const st = useStore(area.store);
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const youId = useRoomView((s) => s.you?.memberId);
  const actions = useRoomActions();
  const scene = sceneId ? view?.scenes[sceneId] : undefined;
  if (!view || !scene || !youId) return null;
  const env: AreaEnv = { actions, view, scene, role: props.role, youId, area };
  if (st.draft) return <DraftOptions env={env} st={st} draft={st.draft} />;
  const selected = st.selectedId ? view.templates[st.selectedId] : undefined;
  if (selected && selected.sceneId === scene.id) return <SelectedOptions env={env} st={st} template={selected} />;
  return <IdleOptions env={env} st={st} />;
}

function InArea(props: { env: AreaEnv; t: AreaTemplateInput; moving: boolean; title: string; extra?: ReactNode }) {
  const { env, t } = props;
  // Tokens other members are dragging count where they would drop.
  const live = useLiveTokens();
  const ctx = contextFrom({ tokens: live.tokens, buildChunks: env.view.buildChunks, settings: env.view.meta.settings }, env.scene, samplesNow(props.moving || live.moving));
  const ids = caughtTokens(t, ctx, env.scene.id);
  const entries = inAreaEntries(ids, live.tokens, env.view.characters);
  return (
    <InfoLine>
      <strong>{props.title}</strong>
      <span style={{ color: theme.color.textMuted }}> · In area{entries.length ? ` (${entries.length})` : ""}: </span>
      {inAreaText(entries)}
      {props.extra}
    </InfoLine>
  );
}

function SpellSearch(props: { env: AreaEnv; st: AreaToolState; base: () => AreaDraft }) {
  const { st } = props;
  return (
    <OptInput
      label="Spell"
      placeholder="Spell, e.g. fireball"
      value={st.query}
      width={170}
      onChange={(query) => props.env.area.store.setState({ query })}
      onEnter={() => {
        const first = searchAreaSpells(st.query, 1)[0];
        if (first) applySpell(props.env, props.base(), first.name);
      }}
    />
  );
}

function applySpell(env: AreaEnv, base: AreaDraft, name: string): void {
  const spell = searchAreaSpells(name, 1)[0];
  if (!spell) return;
  const caster = base.casterId ?? (base.targetsOther ? undefined : base.fromId) ?? env.area.defaultCaster ?? undefined;
  setDraft(env, presetDraft(spell, base, caster));
  env.area.store.setState({ query: "" });
}

function SearchResults(props: { env: AreaEnv; st: AreaToolState; base: () => AreaDraft }) {
  const results = searchAreaSpells(props.st.query, 8);
  if (!props.st.query.trim()) return null;
  return (
    <OptionsRow label="Spells">
      {results.length === 0 ? <span style={{ color: theme.color.textMuted, fontSize: theme.font.body14 }}>No area spell by that name.</span> : null}
      {results.map((s) => (
        <OptButton key={s.srdId} onClick={() => applySpell(props.env, props.base(), s.name)}>
          {s.name}
          <span style={{ fontWeight: theme.weight.regular, color: theme.color.textMuted }}>
            {" "}
            {s.size} ft {shapeName(s.shape).toLowerCase()}
          </span>
        </OptButton>
      ))}
    </OptionsRow>
  );
}

function ShapePicker(props: { value: AreaShape; onChange(shape: AreaShape): void }) {
  return <OptSelect<AreaShape> label="Shape" value={props.value} options={SHAPES} onChange={props.onChange} />;
}

/** Degrees per tap when aiming a cone or line up or down. */
const AIM_STEP = 5;

/**
 * Aims a cone or line up or down (features section 9), so a cone can reach
 * a flier. The readout says "30° up" rather than a signed number, which
 * reads as a typo on a phone.
 */
function AimControl(props: { pitch: number; onChange(pitch: number): void }) {
  const { pitch } = props;
  const set = (p: number) => props.onChange(clampPitch(p));
  return (
    <div role="group" aria-label="Aim up or down" style={{ display: "flex", flex: "none", alignItems: "center", gap: theme.space(1) }}>
      <OptButton icon="chevronDown" label="Aim lower" disabled={pitch <= -MAX_PITCH} onClick={() => set(pitch - AIM_STEP)} />
      <StepValue minWidth={84}>{aimText(pitch)}</StepValue>
      <OptButton label="Aim higher" disabled={pitch >= MAX_PITCH} onClick={() => set(pitch + AIM_STEP)}>
        {/* The icon set has one chevron for up and down, turned here. */}
        <Icon name="chevronDown" size="sm" style={{ transform: "rotate(180deg)" }} />
      </OptButton>
    </div>
  );
}

const TRIGGER_BUTTONS: Record<AreaTrigger, { label: string; hint: string }> = {
  enter: { label: "Enters", hint: "Remind when a creature enters it during a turn" },
  turnStart: { label: "Starts turn", hint: "Remind when a creature starts its turn in it" },
  turnEnd: { label: "Ends turn", hint: "Remind when a creature ends its turn in it" },
};

/**
 * When the log reminds the table that the area hits a creature again
 * (features section 9). A spell preset sets them where the spell says so,
 * Spirit Guardians on entering and at the end of a turn, and once a turn
 * where the spell says "only once per turn". Once a turn means nothing
 * without a trigger, so it shows only with one.
 */
function TriggerToggles(props: {
  value: readonly AreaTrigger[] | undefined;
  once: boolean;
  onChange(next: AreaTrigger[]): void;
  onOnce(next: boolean): void;
}) {
  const on = normalizeTriggers(props.value);
  return (
    <div role="group" aria-label="Reminders" style={{ display: "flex", flex: "none", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
      <span style={{ paddingRight: theme.space(1), fontSize: theme.font.body14, color: theme.color.textMuted }}>Remind:</span>
      {AREA_TRIGGERS.map((t) => (
        <OptButton
          key={t}
          pressed={on.includes(t)}
          label={TRIGGER_BUTTONS[t].hint}
          onClick={() => props.onChange(on.includes(t) ? on.filter((x) => x !== t) : normalizeTriggers([...on, t]))}
        >
          {TRIGGER_BUTTONS[t].label}
        </OptButton>
      ))}
      {on.length > 0 ? (
        <OptButton pressed={props.once} label="Remind about a creature once a turn, whichever comes first" onClick={() => props.onOnce(!props.once)}>
          Once a turn
        </OptButton>
      ) : null}
    </div>
  );
}

/** ", aimed 30° up" after an area's name, or nothing when it is level. */
function aimSuffix(pitch: number): string {
  return pitch === 0 ? "" : `, aimed ${aimText(pitch)}`;
}

function IdleOptions(props: { env: AreaEnv; st: AreaToolState }) {
  const { env, st } = props;
  const base = () => startDraft(env, env.area.defaultCaster);
  const caster = env.area.defaultCaster;
  const casterToken = caster ? env.view.tokens[caster] : undefined;
  return (
    <OptionsColumn>
      <InfoLine tone="muted">
        {casterToken ? `Casting from ${displayName(casterToken)}. ` : ""}Tap a token to cast from it, or tap the map. Tap an area on the map to pick it.
      </InfoLine>
      <OptionsRow label="New area">
        {casterToken ? (
          <OptButton
            onClick={() => {
              env.area.defaultCaster = null;
              // The caster lives outside the store, so this only asks the bar to draw again.
              env.area.store.setState({});
            }}
          >
            Not from {displayName(casterToken)}
          </OptButton>
        ) : null}
        <ShapePicker value={st.shape} onChange={(shape) => env.area.store.setState({ shape })} />
        <SpellSearch env={env} st={st} base={base} />
      </OptionsRow>
      <SearchResults env={env} st={st} base={base} />
    </OptionsColumn>
  );
}

function DraftOptions(props: { env: AreaEnv; st: AreaToolState; draft: AreaDraft }) {
  const { env, st, draft: d } = props;
  const t = currentTemplate(env, d);
  const fpc = env.view.meta.settings.feetPerCell;
  const set = (patch: Partial<AreaDraft>) => setDraft(env, { ...d, ...patch });
  const casterId = d.casterId ?? d.fromId;
  const caster = casterId ? env.view.tokens[casterId] : undefined;

  let range: ReactNode = null;
  if (t && caster && !usesFrom(d.shape)) {
    const ft = boxDistanceFt(tokenCellBox(caster, fpc), pointCellBox(t.origin, fpc), env.view.meta.settings);
    const over = d.rangeFt !== undefined && ft > d.rangeFt;
    range = (
      <span style={{ color: over ? theme.color.warning : theme.color.textMuted }}>
        {" "}
        · {ft} ft from {displayName(caster)}
        {d.rangeFt !== undefined ? (over ? `, past its ${d.rangeFt} ft range` : ` of ${d.rangeFt} ft`) : ""}
      </span>
    );
  }
  const note = d.note ? <span style={{ color: theme.color.textMuted }}> · {d.note}</span> : null;
  const title = (d.spell ?? `${d.size} ft ${shapeName(d.shape).toLowerCase()}`) + (canPitch(d.shape) ? aimSuffix(clampPitch(d.pitch)) : "");

  return (
    <OptionsColumn>
      {t ? (
        <InArea env={env} t={t} moving={st.moving} title={title} extra={<>{range}{note}</>} />
      ) : (
        <InfoLine tone="muted">
          {st.pickCaster ? "Tap the caster." : `${caster ? `Cast by ${displayName(caster)}. ` : ""}${placementHint(d)}`}
          {note}
        </InfoLine>
      )}
      <OptionsRow label="Area">
        <ShapePicker value={d.shape} onChange={(shape) => setDraft(env, withShape(d, shape))} />
        <Stepper label="Size" unit="ft" value={d.size} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(size) => set({ size })} />
        <OptButton tone="primary" disabled={!t} onClick={() => placeDraft(env)}>
          Place
        </OptButton>
        {/* A fixed name that says what pressed means (docs/design-v1-visual.md 3.7). */}
        <OptButton pressed={st.shared} disabled={!t} label="Everyone sees this preview" onClick={() => setShared(env, !st.shared)}>
          Shared
        </OptButton>
        <OptButton onClick={() => cancelDraft(env)}>Cancel</OptButton>
        <OptButton pressed={st.more} onClick={() => env.area.store.setState({ more: !st.more })}>
          More
        </OptButton>
        <SpellSearch env={env} st={st} base={() => d} />
      </OptionsRow>
      <SearchResults env={env} st={st} base={() => d} />
      {st.more && !st.query.trim() ? (
        <OptionsRow label="More area options">
          <Segmented label="Rotation snap" value={st.snap} options={SNAPS} onChange={(snap) => env.area.store.setState({ snap })} />
          {canPitch(d.shape) ? <AimControl pitch={clampPitch(d.pitch)} onChange={(pitch) => set({ pitch })} /> : null}
          {d.shape === "line" ? <Stepper label="Width" unit="ft" value={d.width} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(width) => set({ width })} /> : null}
          {d.shape === "cylinder" ? (
            <>
              <Stepper label="Height" unit="ft" value={d.height} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(height) => set({ height })} />
              <Segmented
                label="Point on"
                value={d.anchor}
                options={[
                  { value: "bottom", label: "Bottom" },
                  { value: "top", label: "Top" },
                ]}
                onChange={(anchor) => set({ anchor })}
              />
            </>
          ) : null}
          {d.shape === "cube" && d.fromId ? (
            <Segmented
              label="Cube reaches"
              value={d.faceU > 0 ? "left" : d.faceU < 0 ? "right" : "center"}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Center" },
                { value: "right", label: "Right" },
              ]}
              onChange={(v) => set({ faceU: v === "left" ? 0.5 : v === "right" ? -0.5 : 0 })}
            />
          ) : null}
          {d.point && !d.fromId ? (
            <Stepper label="Elevation" unit="ft" value={d.point.z} step={5} min={-1000} max={1000} onChange={(z) => set({ point: { ...d.point!, z } })} />
          ) : null}
          {d.shape !== "sphere" && d.shape !== "cylinder" ? (
            <OptButton pressed={d.includeOrigin} onClick={() => set({ includeOrigin: !d.includeOrigin })}>
              {d.targetsOther ? `Includes ${d.targetName ?? "target"}` : "Includes caster"}
            </OptButton>
          ) : null}
          {d.shape === "emanation" && d.fromId && !d.targetsOther ? (
            <OptButton pressed={d.attached} onClick={() => set({ attached: !d.attached })}>
              Moves with token
            </OptButton>
          ) : null}
          <OptButton pressed={st.pickCaster} onClick={() => env.area.store.setState({ pickCaster: !st.pickCaster })}>
            {caster ? `Caster: ${displayName(caster)}` : "Set caster"}
          </OptButton>
          {caster ? (
            <OptButton label="Clear the caster" onClick={() => set({ casterId: undefined, fromId: d.targetsOther ? d.fromId : undefined, point: d.point ?? (t ? freePointOf(t, fpc) : null) })}>
              No caster
            </OptButton>
          ) : null}
          <TriggerToggles value={d.triggers} once={d.oncePerTurn} onChange={(triggers) => set({ triggers })} onOnce={(oncePerTurn) => set({ oncePerTurn })} />
          <Swatches label="Color" value={d.color} options={MEMBER_COLORS} onChange={(color) => set({ color })} />
          {env.role === "dm" ? (
            <OptButton pressed={d.visibility === "dm"} onClick={() => set({ visibility: d.visibility === "dm" ? "all" : "dm" })}>
              DM only
            </OptButton>
          ) : null}
        </OptionsRow>
      ) : null}
    </OptionsColumn>
  );
}

function SelectedOptions(props: { env: AreaEnv; st: AreaToolState; template: AreaTemplate }) {
  const { env, st, template } = props;
  const ui = useRoomUi();
  const t = st.live ? ({ ...template, ...st.live } as AreaTemplate) : template;
  const editable = canEdit(env, template);
  const update = (patch: Parameters<typeof updateTemplate>[2]) => updateTemplate(env, template.id, patch);
  const caster = t.casterId ? env.view.tokens[t.casterId] : undefined;
  const fpc = env.view.meta.settings.feetPerCell;
  const copy = () => {
    select(env.area, null);
    setDraft(env, draftFromTemplate(template, env.actions.newId(), env.view.tokens, fpc));
  };
  const by = caster ? <span style={{ color: theme.color.textMuted }}> · cast by {displayName(caster)}</span> : null;
  return (
    <OptionsColumn>
      <InArea env={env} t={t} moving={st.moving} title={areaTitle(t) + aimSuffix(pitchOf(t))} extra={by} />
      <OptionsRow label="Placed area">
        {editable ? (
          <>
            <Stepper label="Size" unit="ft" value={t.size} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(size) => update({ size })} />
            {env.role === "dm" ? (
              // A fixed name that says what pressed means (docs/design-v1-visual.md 3.7).
              <OptButton pressed={t.visibility === "dm"} label="Hide it from players" onClick={() => update({ visibility: t.visibility === "dm" ? "all" : "dm" })}>
                Hidden
              </OptButton>
            ) : null}
          </>
        ) : null}
        {env.role === "dm" ? <OptButton onClick={() => openDamage(env.area, ui, template.id)}>Damage</OptButton> : null}
        <OptButton onClick={copy}>Copy</OptButton>
        {editable ? (
          <OptButton tone="danger" onClick={() => deleteTemplate(env, template.id)}>
            Delete
          </OptButton>
        ) : null}
        <OptButton onClick={() => select(env.area, null)}>Done</OptButton>
        {editable ? (
          <OptButton pressed={st.more} onClick={() => env.area.store.setState({ more: !st.more })}>
            More
          </OptButton>
        ) : null}
      </OptionsRow>
      {editable && st.more ? (
        <OptionsRow label="More area options">
          <Segmented label="Rotation snap" value={st.snap} options={SNAPS} onChange={(snap) => env.area.store.setState({ snap })} />
          {canPitch(t.shape) ? <AimControl pitch={pitchOf(t)} onChange={(pitch) => update({ pitch: pitch === 0 ? null : pitch })} /> : null}
          {t.shape === "line" ? <Stepper label="Width" unit="ft" value={t.width ?? 5} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(width) => update({ width })} /> : null}
          {t.shape === "cylinder" ? <Stepper label="Height" unit="ft" value={t.height ?? 40} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(height) => update({ height })} /> : null}
          {t.shape !== "sphere" && t.shape !== "cylinder" ? (
            <OptButton pressed={t.includeOrigin} onClick={() => update({ includeOrigin: !t.includeOrigin })}>
              Includes caster
            </OptButton>
          ) : null}
          {t.shape === "emanation" && (t.attachedTo || caster) ? (
            <OptButton
              pressed={!!t.attachedTo}
              onClick={() => {
                if (t.attachedTo) {
                  // Let go where it stands now, so it does not jump back to
                  // where it was first cast, and keep the token's footprint there.
                  const o = liveOrigin(t, liveContext(env.view, env.scene, false));
                  const token = env.view.tokens[t.attachedTo];
                  update({ attachedTo: null, origin: { x: o.x, y: o.y, z: Math.round(o.z) }, ...(token ? { footprint: emanationFootprint(token, fpc) } : {}) });
                } else if (caster) {
                  update({ attachedTo: caster.id });
                }
              }}
            >
              Moves with token
            </OptButton>
          ) : null}
          <TriggerToggles
            value={t.triggers}
            once={t.oncePerTurn === true}
            onChange={(triggers) => update({ triggers: triggers.length > 0 ? triggers : null })}
            onOnce={(once) => update({ oncePerTurn: once ? true : null })}
          />
          <Swatches label="Color" value={t.color} options={MEMBER_COLORS} onChange={(color) => update({ color })} />
        </OptionsRow>
      ) : null}
    </OptionsColumn>
  );
}
