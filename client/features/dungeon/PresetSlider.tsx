import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useHeld } from "../../components/Held.tsx";
import { choiceLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";

const GAP = theme.space(1);

/** A slider's named mark, which a tap or Page Up and Page Down jump to. */
export type Preset = { value: number; label: string };

/**
 * A choice along a scale with named marks (D-261102-833): the app's range
 * input, which steps with the arrows and goes to its ends with Home and
 * End, with its value said in words beside its name and to a screen reader
 * (aria-valuetext), and a row of the marks' names under it. A tap on a name
 * jumps there, and Page Up and Page Down jump to the next mark either way,
 * so the guiding values stay one move away however fine the steps.
 */
export function PresetSlider(props: {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  presets: readonly Preset[];
  /** The value in words, such as "About 3 rooms of 12 off flat ground". */
  words: string;
  help?: ReactNode;
  onChange(value: number): void;
}) {
  const id = useId();
  const helpId = useId();
  const ticksId = useId();
  const disabled = useHeld();
  const row = useRef<HTMLDivElement>(null);
  const perRow = usePerRow(row, props.presets.length);
  const color = disabled ? theme.color.textDisabled : theme.color.text;
  const jump = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault();
    const up = e.key === "PageUp";
    const marks = props.presets.map((p) => p.value).sort((a, b) => a - b);
    const next = up ? marks.find((v) => v > props.value) : marks.reverse().find((v) => v < props.value);
    if (next !== undefined) props.onChange(next);
  };
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", columnGap: theme.space(3), minWidth: 0 }}>
        <label htmlFor={id} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong, color }}>
          {props.name}
        </label>
        {/* The input says the same words as its value, so a screen reader hears them once. */}
        <span aria-hidden style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: disabled ? theme.color.textDisabled : theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>
          {props.words}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        list={ticksId}
        disabled={disabled}
        aria-valuetext={props.words}
        aria-describedby={props.help ? helpId : undefined}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onKeyDown={jump}
        style={{ width: "100%", minWidth: 0, height: theme.touch, margin: 0, accentColor: disabled ? theme.color.textDisabled : theme.color.accent }}
      />
      <datalist id={ticksId}>
        {props.presets.map((p) => (
          <option key={p.value} value={p.value} />
        ))}
      </datalist>
      <div ref={row} role="group" aria-label={`${props.name} marks`} style={{ display: "flex", flexWrap: "wrap", gap: GAP, minWidth: 0 }}>
        {props.presets.map((p) => {
          const chosen = p.value === props.value;
          return (
            <button
              key={p.value}
              type="button"
              className="rvtt-choice"
              aria-pressed={chosen}
              disabled={disabled}
              onClick={() => props.onChange(p.value)}
              style={{
                flex: `1 1 calc((100% - ${(perRow - 1) * GAP}px) / ${perRow})`,
                minWidth: theme.touch,
                minHeight: theme.touch,
                padding: `0 ${theme.space(1)}px`,
                borderRadius: theme.radius.md,
                fontSize: theme.font.body14,
                fontWeight: theme.weight.strong,
                fontFamily: theme.font.body,
                whiteSpace: "nowrap",
                cursor: disabled ? "default" : "pointer",
                ...choiceLook(chosen, disabled),
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {props.help ? <Help id={helpId}>{props.help}</Help> : null}
    </div>
  );
}

/**
 * How many marks stand on a row: all of them where each keeps its 44 px,
 * else as few rows as fit, shared out evenly (five as three and two), so
 * no row holds one mark alone. A smallest phone at a large interface size
 * has room for four.
 */
function usePerRow(row: RefObject<HTMLDivElement | null>, count: number): number {
  const [perRow, setPerRow] = useState(count);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const fit = Math.max(1, Math.floor((el.clientWidth + GAP) / (theme.touch + GAP)));
      const rows = Math.ceil(count / Math.min(fit, count));
      setPerRow(Math.ceil(count / rows));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [row, count]);
  return perRow;
}
