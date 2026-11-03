import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { useHeld } from "../../../components/Held.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { theme } from "../../../lib/theme.ts";
import { usePanelShown } from "../../panels.ts";
import { useDebounced } from "../../scenes/controls.tsx";

/**
 * A volume for everyone (docs/design/design-v1-music.md 4.1), 0 to 100%:
 * its name over the slider, which a long name wraps, and the percent
 * beside it. A drag shows at once and sends 250 ms after the last change,
 * so it never floods the room (D-261102-470).
 */
export function VolumeSlider(props: { label: string; value: number; onChange(value: number): void; trailing?: ReactNode }) {
  const [local, set] = useDebounced(props.value, props.onChange);
  const id = useId();
  const disabled = useHeld();
  const color = disabled ? theme.color.textDisabled : theme.color.text;
  return (
    <div data-sound-volume="" style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      {/* A loop's Stop sits beside its name, so every slider in the panel keeps one width. */}
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
        <label htmlFor={id} style={{ flex: 1, minWidth: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, color, overflowWrap: "anywhere" }}>
          {props.label}
        </label>
        {props.trailing}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
        <Icon name="volume" size="md" style={{ color: theme.color.textMuted }} />
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={local}
          disabled={disabled}
          aria-valuetext={`${local}%`}
          onChange={(e) => set(Number(e.target.value))}
          style={{ flex: 1, minWidth: 0, height: theme.touch, margin: 0, accentColor: disabled ? theme.color.textDisabled : theme.color.accent }}
        />
        <span aria-hidden style={{ flex: "none", minWidth: 48, textAlign: "right", fontSize: theme.font.small, fontVariantNumeric: "tabular-nums", color: theme.color.textMuted }}>
          {local}%
        </span>
      </div>
    </div>
  );
}

/** A row of buttons that wraps on a narrow panel, as every action row in the panel does. */
export function Actions(props: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minWidth: 0, ...props.style }}>{props.children}</div>;
}

/** A subheading inside a section: Playlists, Tracks. */
export function Subhead(props: { children: ReactNode; id?: string }) {
  return (
    <h4 id={props.id} style={{ margin: 0, fontSize: theme.font.body14, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>
      {props.children}
    </h4>
  );
}

/**
 * The server's time, read again every `everyMs` while `active` and the
 * panel shows: Now playing's clock steps once a second while music plays
 * (8), and nothing renders on a timer otherwise.
 */
export function useTicking(read: () => number, active: boolean, everyMs = 1000): number {
  const shown = usePanelShown();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || !shown) return;
    const timer = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(timer);
  }, [active, shown, everyMs]);
  return read();
}

/** Renders again at `at`, a server time, once: the board's pressed effect ends then. */
export function useWakeAt(at: number | null, now: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const wait = Math.max(0, at - now) + 20;
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [at, now]);
}

/**
 * A row that opens a page, with one action beside it (a playlist's or a
 * track's Play). Side by side, never nested: a button inside the row's
 * button would be neither.
 */
export function RowWithAction(props: { row: ReactNode; action: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
      <div style={{ flex: 1, minWidth: 0 }}>{props.row}</div>
      {props.action}
    </div>
  );
}
