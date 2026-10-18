import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Help } from "../../components/Panel.tsx";
import { idle } from "../../lib/idle.ts";
import { theme } from "../../lib/theme.ts";
import { D20Icon } from "../dice/throw/D20Icon.tsx";
import { DICE_SETS } from "../dice/throw/sets.ts";
import { diceLoader } from "../dice/throw/hooks.ts";
import { useThrows } from "../dice/throw/useThrows.ts";
import { setDiceSetId, useDiceSetId, useLowPower, useRollAnimation } from "./settings.ts";

/**
 * "Dice" in This device's Rolls (docs/design-v1-roll-animation.md 9.2): a
 * radio group of tiles, each the set's d20 showing 20 above its name. The
 * choice is kept on this device, never in the room.
 *
 * Where the dice can be drawn, the dice chunk renders each set's d20 once,
 * in a quiet moment, and copies it into the tile. Until then, and with the
 * switch off, Low power, no WebGL or a failed load, each tile shows the
 * flat d20 in the set's colors. Nothing animates.
 */

/** The d20 in each tile, and the tile's narrowest: four to a row at 390 px, three at 320. */
const DIE_PX = 48;
const TILE_MIN_PX = 72;

export function DiceSetPicker() {
  const on = useRollAnimation();
  const lowPower = useLowPower();
  const chosen = useDiceSetId();
  const store = useThrows();
  const loaded = useSyncExternalStore(diceLoader.subscribe, diceLoader.state, diceLoader.state);
  const name = useId();
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const [drawn, setDrawn] = useState(false);
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);

  useEffect(() => {
    if (!on || lowPower || loaded !== "ready" || drawn) return;
    const module = diceLoader.loaded();
    if (!module?.drawPreviews) return;
    let live = true;
    const cancel = idle(() => {
      const targets = DICE_SETS.flatMap((set) => {
        const canvas = canvases.current.get(set.id);
        return canvas ? [{ set: set.id, canvas }] : [];
      });
      module.drawPreviews!(targets, DIE_PX, store.stage).then(
        (ok) => live && ok && setDrawn(true),
        () => undefined,
      );
    }, 1000);
    return () => {
      live = false;
      cancel();
    };
  }, [on, lowPower, loaded, drawn, store]);

  const previews = drawn && on && !lowPower;
  return (
    <fieldset disabled={!on} style={{ margin: 0, padding: 0, border: "none", minWidth: 0, display: "grid", gap: theme.space(1) }}>
      <legend style={{ padding: 0, fontSize: theme.font.input, fontWeight: theme.weight.strong, color: on ? theme.color.text : theme.color.textDisabled }}>Dice</legend>
      {on ? null : <Help>Turn on Roll animation to throw dice.</Help>}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_PX}px, 1fr))`, gap: theme.space(1) }}>
        {DICE_SETS.map((set) => {
          const picked = set.id === chosen;
          return (
            <label
              key={set.id}
              className="rvtt-choice"
              data-dice-set={set.id}
              style={{
                position: "relative",
                display: "grid",
                justifyItems: "center",
                gap: theme.space(1),
                minHeight: theme.touch,
                padding: `${theme.space(2)}px ${theme.space(1)}px`,
                borderRadius: theme.radius.md,
                border: `${picked ? theme.line.strong : theme.line.border}px solid ${picked && on ? theme.color.accent : theme.color.border}`,
                background: picked && on ? theme.color.accentTint : "transparent",
                color: on ? theme.color.text : theme.color.textDisabled,
                cursor: on ? "pointer" : "default",
              }}
            >
              <input
                type="radio"
                name={name}
                value={set.id}
                checked={picked}
                onChange={() => setDiceSetId(set.id)}
                // Unseen over its whole tile, as Segmented's: a tap anywhere hits it, the arrow keys move along the group, and a screen reader reads "Dice: Ruby, selected".
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" }}
              />
              {/* Drawn over the radio, so taps pass through it to the radio under it. */}
              <span style={{ position: "relative", width: DIE_PX, height: DIE_PX, pointerEvents: "none" }}>
                {previews ? null : <D20Icon size={DIE_PX} text="20" body={set.body} edge={set.edge} ink={set.ink} />}
                <canvas
                  aria-hidden="true"
                  ref={(el) => {
                    if (el) canvases.current.set(set.id, el);
                    else canvases.current.delete(set.id);
                  }}
                  width={DIE_PX * ratio}
                  height={DIE_PX * ratio}
                  style={{ position: "absolute", inset: 0, width: DIE_PX, height: DIE_PX, display: previews ? "block" : "none" }}
                />
              </span>
              <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, textAlign: "center", overflowWrap: "anywhere" }}>{set.name}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
