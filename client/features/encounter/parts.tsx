import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { Effect, InitEntry } from "#shared/model.ts";
import { Spinner as SharedSpinner } from "../../components/Loading.tsx";
import { Tag as SharedTag, type TagTone } from "../../components/Tag.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { DISPOSITION_RING, effectChip, effectCount, initials } from "../../lib/tokenView.ts";
import { useAssets, useRoomView } from "../../state/view.ts";
import { entryName, onAnotherScene, portraitDisposition, type HpView } from "./logic.ts";
import { clockText, type TimerState } from "./timer.ts";
import { isAssetImage } from "#shared/imageRef.ts";
import { IconDisk } from "../images/IconDisk.tsx";

/** Small pieces the tracker panel and the top strip share. */

/**
 * A row's picture: the token image, else the character's, else initials on
 * the disposition color. The crop follows the token's crop center and zoom
 * closely enough for a 20 to 40 px circle.
 */
export function Portrait(props: { entry: Pick<InitEntry, "tokenId" | "characterId" | "label">; size: number; ring?: string; dim?: boolean }) {
  const { entry, size } = props;
  const assets = useAssets();
  const token = useRoomView((s) => (entry.tokenId !== undefined ? s.view?.tokens[entry.tokenId] : undefined));
  const characterId = entry.characterId ?? (token && "ref" in token.actor ? token.actor.ref : undefined);
  const character = useRoomView((s) => (characterId !== undefined ? s.view?.characters[characterId] : undefined));
  const name = useRoomView((s) => (s.view ? entryName(s.view, entry) : ""));
  const elsewhere = useRoomView((s) => (s.view ? onAnotherScene(s.view, entry) : false));
  const shown = token?.image ?? character?.defaultImage;
  const image = shown && isAssetImage(shown) ? shown : undefined;
  const color = DISPOSITION_RING[portraitDisposition(token, elsewhere)];
  // The disposition ring sits just outside the disk, as an outline, which follows the round corners and takes no room in the row.
  const frame: CSSProperties = { outline: `${theme.line.strong}px solid ${props.ring ?? color}`, outlineOffset: 0, opacity: props.dim ? 0.45 : 1 };
  const box: CSSProperties = {
    width: size,
    height: size,
    flex: "none",
    borderRadius: theme.radius.round,
    overflow: "hidden",
    display: "grid",
    placeItems: "center",
    background: theme.color.surfaceRaised,
    ...frame,
  };
  // Two letters fit the strip's 22 to 26 px disks at the smallest size, and the rows' 32 and 36 px disks at the next.
  const letterSize = size >= 30 ? theme.font.small : theme.font.tiny;
  if (shown && !isAssetImage(shown)) {
    // A shipped icon on its disk (docs/design-v1-dm-tools.md 3.12), initials until its file arrives.
    const letters = <span style={{ fontSize: letterSize, fontWeight: theme.weight.bold }}>{initials(name)}</span>;
    return <IconDisk icon={shown.icon} color={shown.color} width={size} shape="circle" style={frame} fallback={letters} />;
  }
  if (!image) {
    return (
      <span aria-hidden style={{ ...box, color: elsewhere ? theme.color.textMuted : theme.color.text, fontSize: letterSize, fontWeight: theme.weight.bold }}>
        {elsewhere ? "?" : initials(name)}
      </span>
    );
  }
  const { cx, cy, zoom } = image.crop;
  return (
    <span aria-hidden style={box}>
      <img
        src={assets.url(image.assetId, "thumb")}
        alt=""
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: `${cx * 100}% ${cy * 100}%`,
          transform: zoom > 1 ? `scale(${Math.min(zoom, 4)})` : undefined,
          transformOrigin: `${cx * 100}% ${cy * 100}%`,
        }}
      />
    </span>
  );
}

/**
 * Condition chips: a glyph on the condition's color, never color alone, with
 * the full name for screen readers. One hidden from players, which only the
 * DM's view holds, is dimmed with a dashed edge.
 */
export function Chips(props: { effects: readonly Effect[]; max?: number }) {
  // An exhaustion glyph ("E2") already carries its level.
  const all = props.effects.map((effect) => ({
    ...effectChip(effect),
    hidden: effect.hiddenFromPlayers === true,
    count: effect.key === "exhaustion" ? null : effectCount(effect),
  }));
  const shown = props.max !== undefined && all.length > props.max ? all.slice(0, props.max - 1) : all;
  const overflow = all.length - shown.length;
  if (all.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: theme.space(1), fontVariantNumeric: "tabular-nums" }}>
      {shown.map((chip, i) => (
        <span
          key={i}
          role="img"
          aria-label={chip.hidden ? `${chip.label}, hidden from players` : chip.label}
          title={chip.hidden ? `${chip.label} (hidden from players)` : chip.label}
          style={{
            ...(chip.hidden ? { opacity: 0.6, outline: `${theme.line.border}px dashed ${theme.color.text}`, outlineOffset: 1 } : {}),
            minWidth: 20,
            height: 18,
            padding: `0 ${theme.space(0.5)}px`,
            borderRadius: theme.radius.xs,
            background: chip.color,
            color: theme.color.white,
            fontSize: theme.font.tiny,
            fontWeight: theme.weight.bold,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {chip.glyph}
          {chip.count !== null ? <span style={{ fontSize: theme.font.tiny, marginLeft: theme.space(0.5) }}>{chip.count}</span> : null}
        </span>
      ))}
      {overflow > 0 ? (
        <span title={all.slice(shown.length).map((c) => c.label).join(", ")} style={{ fontSize: theme.font.tiny, color: theme.color.textMuted, alignSelf: "center" }}>
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

/** The health states in the Tag tones of docs/design-v1-visual.md 2.3, the same look as the Token panel's. */
const LABEL_TONES: Record<string, TagTone> = {
  Healthy: "success",
  Bloodied: "warning",
  Dying: "danger",
  Dead: "danger",
};

export function HpReadout(props: { hp: HpView }) {
  const { hp } = props;
  if (hp.kind === "none") return null;
  if (hp.kind === "label") {
    return (
      <SharedTag tone={LABEL_TONES[hp.label] ?? "muted"} dense>
        {hp.label}
      </SharedTag>
    );
  }
  if (hp.kind === "exact") {
    const low = hp.cur <= Math.floor(hp.max / 2);
    return (
      <span style={{ color: hp.cur === 0 ? theme.color.dangerText : low ? theme.color.warning : theme.color.text, fontVariantNumeric: "tabular-nums" }}>
        {hp.cur}/{hp.max}
        {hp.temp > 0 ? <span style={{ color: theme.color.ally }}> +{hp.temp}</span> : null}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={`About ${Math.round(hp.fraction * 100)} percent health`}
      style={{ display: "inline-block", width: 44, height: 6, borderRadius: theme.radius.xs, background: theme.color.border, overflow: "hidden", verticalAlign: "middle" }}
    >
      <span
        style={{
          display: "block",
          width: `${hp.fraction * 100}%`,
          height: "100%",
          background: hp.fraction <= 0.5 ? theme.color.warning : theme.color.success,
        }}
      />
    </span>
  );
}

/** "Adv" or "Dis" next to a row, for whoever rolls that creature's initiative. */
export function RollBadge(props: { kind: "adv" | "dis" }) {
  const adv = props.kind === "adv";
  return (
    <SharedTag tone={adv ? "success" : "danger"} dense title={adv ? "Rolls Initiative with Advantage" : "Rolls Initiative with Disadvantage"}>
      {adv ? "Adv" : "Dis"}
    </SharedTag>
  );
}

/**
 * A row's second line as the row's description (docs/design-v1-combat-flow.md
 * 3.3): its items in order, with an unseen ", " between them, so a screen
 * reader hears "Armor Class 15, HP 7/7, Reaction used" after the row's name.
 * Absent items are left out, so no separator stands alone. The separators
 * are absolutely placed, so the line's flex gap is unchanged.
 */
export function DescribedItems(props: { items: readonly (ReactNode | null | false | undefined)[] }) {
  const present = props.items.filter((item) => item !== null && item !== false && item !== undefined);
  return (
    <>
      {present.map((item, i) => (
        <Fragment key={i}>
          {i > 0 ? <span style={VISUALLY_HIDDEN}>, </span> : null}
          {item}
        </Fragment>
      ))}
    </>
  );
}

/** The HP readout for a row's description: "HP 7/7" to a screen reader, "7/7" on screen. */
export function DescribedHp(props: { hp: HpView }) {
  if (props.hp.kind === "none") return null;
  return (
    <span>
      {props.hp.kind === "exact" ? <span style={VISUALLY_HIDDEN}>HP </span> : null}
      <HpReadout hp={props.hp} />
    </span>
  );
}

/**
 * A small spinner for ops that wait on the server: the shared one
 * (components/Loading.tsx), which follows reduced motion. It replaces the
 * thing it waits on in place, so it shows at once rather than after a delay.
 */
export function Spinner(props: { size?: number; label?: string }) {
  return <SharedSpinner size={props.size ?? theme.icon.sm} label={props.label ?? "Waiting for the server"} />;
}

/** How tall the turn strip's chip and End Turn's pill look. Their targets stay 44 px. */
export const TURN_PILL_PX = 36;

/**
 * A player's End Turn, in the turn strip and in the tracker: a solid accent
 * pill the height of the strip's chip, so it reads as part of the turn UI
 * rather than a card over the map. The pill sits inside a transparent 44 px
 * target. While the op waits for the server it spins and takes no second
 * tap, at full strength so the spinner reads. `stack` puts its two words
 * on two lines, for the phone's turn band when its row is short of room
 * (band.ts bandFit), as the timer stacks "Time’s up" over the time past.
 * On one line or two, the spinner stands in the words' place while it
 * waits: beside them it took the pill past the width the band gave it, off
 * the screen at 320 px at 130% and at 360 px at 115%. The words stay,
 * unseen, so the pill keeps its width and the button its name.
 */
export function EndTurnPill(props: { waiting: boolean; stack?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.waiting}
      aria-busy={props.waiting ? true : undefined}
      style={{
        // Positioned, so it stays above the phone band's own full-size tap target, which opens the tracker.
        position: "relative",
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: theme.touch,
        minHeight: theme.touch,
        padding: 0,
        border: "none",
        borderRadius: theme.radius.pill,
        background: "transparent",
        fontFamily: theme.font.body,
        cursor: props.waiting ? "default" : "pointer",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: theme.space(2),
          height: TURN_PILL_PX,
          padding: `0 ${props.stack ? theme.space(2.5) : theme.space(4)}px`,
          borderRadius: theme.radius.pill,
          background: theme.color.accent,
          color: theme.color.onAccent,
          fontSize: theme.font.body14,
          fontWeight: theme.weight.bold,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ position: "relative", display: "grid", placeItems: "center" }}>
          {/* Before the words, so the button's name reads "Ending your turn End turn" while it waits. */}
          {props.waiting ? (
            <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              <Spinner label="Ending your turn" />
            </span>
          ) : null}
          {/* One text node either way, so the button's name stays "End turn". */}
          <span style={{ opacity: props.waiting ? 0 : 1, ...(props.stack ? { width: "min-content", whiteSpace: "normal", textAlign: "center", lineHeight: 1.05 } : null) }}>
            End turn
          </span>
        </span>
      </span>
    </button>
  );
}

/**
 * The turn timer's clock: quiet while time is left, amber in the last
 * seconds, red once it runs out, then counting the time past it. Words go
 * with the color, so the state never rests on color alone.
 *
 * `stack` puts the time past it under "Time’s up", for the phone's turn
 * band: on one line it is the widest thing in a row that also holds the
 * picture, the name, "Your turn" and End Turn, and at a large interface
 * size on a narrow phone it pushed End Turn off the screen.
 */
export function TimerClock(props: { state: TimerState; size?: number; stack?: boolean }) {
  const { state } = props;
  const color = state.over ? theme.color.dangerText : state.warning ? theme.color.warning : theme.color.textMuted;
  const text = clockText(state);
  const past = state.over && state.left < 0;
  const style: CSSProperties = { flex: "none", color, fontSize: props.size ?? theme.font.small, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const label = state.over ? `Turn time is up, ${text} over` : `${text} left this turn`;
  if (props.stack && past) {
    return (
      <span role="timer" aria-label={label} style={{ ...style, display: "grid", justifyItems: "end", lineHeight: theme.leading.tight }}>
        <span>Time's up</span>
        <span>{text}</span>
      </span>
    );
  }
  return (
    <span role="timer" aria-label={label} style={style}>
      {state.over ? `Time's up${past ? ` ${text}` : ""}` : text}
    </span>
  );
}
