import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MAX_LIGHT_FT, type Token, type TokenLight } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { CARRIED_LIGHTS, clampFeet, isCustom, lightText, presetOf } from "./presets.ts";
import { radiusCapFt } from "./reach.ts";
import { visionOn } from "./sightMode.ts";

/**
 * Light on a token's action bar (docs/design-v1-maps-vision.md section
 * 4.3.1): None, the SRD's carried lights, or Custom radii up to 120 ft
 * each, for the DM and the token's owners. A player lights their own torch
 * here. Its light reaches other players only as what the party sees.
 *
 * It shows on a scene with party vision, where light does something, and
 * on any scene while the token carries a light, so it can be put out.
 */
export function LightChip(props: { token: Pick<Token, "id" | "sceneId" | "light"> }) {
  const { token } = props;
  const actions = useRoomActions();
  const vision = useRoomView((s) => {
    const scene = s.view?.scenes[token.sceneId];
    return scene !== undefined && visionOn(scene);
  });
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const [open, setOpen] = useState(false);
  const lit = token.light !== undefined && (token.light.bright > 0 || token.light.dim > 0);
  if (!vision && !lit) return null;
  const set = (light: TokenLight | null) => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { light } });
  return (
    <>
      {/* It stands only in the bar's play row, whose buttons grow to share their line (canvas/TokenActionBar.tsx ButtonRow). */}
      <Button size="sm" pressed={open || lit} aria-label={lit ? `Light: ${lightText(token.light, feetPerCell)}` : undefined} title={lit ? `Light: ${lightText(token.light, feetPerCell)}` : "Light"} onClick={() => setOpen(!open)} style={{ flex: "1 1 auto" }}>
        Light
      </Button>
      {open ? <LightChoices light={token.light} onChoose={set} reveal style={{ order: -1 }} /> : null}
    </>
  );
}

/**
 * The choices, a row of their own. On the action bar `order` puts them
 * above the bar's buttons, where its Conditions open too, so the buttons
 * keep their places, and `reveal` scrolls a bar that has run out of room.
 */
export function LightChoices(props: { light: TokenLight | undefined; onChoose(light: TokenLight | null): void; reveal?: boolean; style?: CSSProperties }) {
  const { light } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [props.reveal]);
  const lit = light !== undefined && (light.bright > 0 || light.dim > 0);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const cap = radiusCapFt(feetPerCell);
  const [custom, setCustom] = useState(isCustom(light, CARRIED_LIGHTS));
  const [bright, setBright] = useState(String(light?.bright ?? 20));
  const [dim, setDim] = useState(String(light?.dim ?? 20));
  // A token's light stores only its radii, so which of two presets with the same radii was tapped lives here.
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = custom ? null : presetOf(light, CARRIED_LIGHTS, picked);
  // When the light changes, here or on another device, the choices follow it. This keys on the
  // radii alone, since `light` is a new object on every edit of the token.
  const radii = light ? `${light.bright}/${light.dim}` : "";
  useEffect(() => {
    setCustom(isCustom(light, CARRIED_LIGHTS));
    setBright(String(light?.bright ?? 20));
    setDim(String(light?.dim ?? 20));
  }, [radii]);
  const apply = () => props.onChoose({ bright: clampFeet(Number(bright)), dim: clampFeet(Number(dim)) });
  return (
    <div ref={ref} role="group" aria-label="Light" style={{ flexBasis: "100%", display: "grid", gap: theme.space(1), ...props.style }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        <ChipButton pressed={!lit && !custom} onClick={() => {
            setCustom(false);
            setPicked(null);
            props.onChoose(null);
          }}>
          None
        </ChipButton>
        {CARRIED_LIGHTS.map((p) => (
          <ChipButton key={p.name} pressed={chosen?.name === p.name} label={`${p.name}: ${lightText(p)}`} onClick={() => {
              setCustom(false);
              setPicked(p.name);
              props.onChoose({ bright: p.bright, dim: p.dim });
            }}>
            {p.name}
          </ChipButton>
        ))}
        <ChipButton pressed={custom} onClick={() => setCustom(!custom)}>
          Custom
        </ChipButton>
      </div>
      {custom ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: theme.space(2) }}>
          <FeetField label="Bright, ft" value={bright} onChange={setBright} onEnter={apply} />
          <FeetField label="Dim beyond, ft" value={dim} onChange={setDim} onEnter={apply} />
          <Button size="sm" onClick={apply}>
            Set
          </Button>
        </div>
      ) : null}
      <Help>
        {lit ? lightText(light, feetPerCell) : "No light"}. Each radius stops at {cap} ft{cap < MAX_LIGHT_FT ? " on this grid" : ""}.
      </Help>
    </div>
  );
}

function FeetField(props: { label: string; value: string; onChange(v: string): void; onEnter(): void }) {
  const id = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(0.5) }}>
      <label htmlFor={id} style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
        {props.label}
      </label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={120}
        step={5}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.onEnter();
        }}
      />
    </div>
  );
}

/**
 * A quick pick among the lights, in the Chip's look (components/Chip.tsx):
 * a pill, the chosen one pressed. A small Button rather than a Chip, since
 * a preset's name says its radii ("Torch: 20 ft bright, 20 ft dim"), which
 * its visible word alone does not.
 */
function ChipButton(props: { onClick(): void; children: ReactNode; label?: string; pressed?: boolean }) {
  return (
    <Button size="sm" pressed={props.pressed} aria-label={props.label} title={props.label} onClick={props.onClick} style={{ borderRadius: theme.radius.pill }}>
      {props.children}
    </Button>
  );
}
