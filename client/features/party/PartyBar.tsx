import { useMemo, useState, type CSSProperties } from "react";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Icon } from "../../components/Icon.tsx";
import { theme } from "../../lib/theme.ts";
import { footprint } from "../../lib/scene.ts";
import { effectChip } from "../../lib/tokenView.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { layoutSize, screenHeight } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { Portrait } from "../encounter/parts.tsx";
import { panAnchor, requestPan } from "../encounter/pan.ts";
import { openAsk } from "../rolls/open.ts";
import { hpLine, lifeWord, partyEntries, type PartyEntry } from "./party.ts";

const LABEL_COLOR: Record<PartyEntry["label"], string> = {
  Healthy: theme.color.success,
  Bloodied: theme.color.warning,
  Dying: theme.color.danger,
  Dead: theme.color.textMuted,
};

const FOLD_KEY = "rvtt.partyFolded";

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}

function storeFolded(folded: boolean): void {
  try {
    localStorage.setItem(FOLD_KEY, folded ? "1" : "0");
  } catch {
    // Private mode or storage full: the fold lasts until the page closes.
  }
}

/**
 * The party bar (docs/design-v1-dm-tools.md 3.4): each party member's
 * portrait, name, HP with temporary HP and a thin bar by its label, AC on a
 * shield, Passive Perception on an eye, up to three condition chips, and
 * Dying, Stable or Dead in place of the bar. A tap frames the character's
 * token on the scene in view and opens its action bar. "Ask the party"
 * opens Request a roll for the same party.
 *
 * `dock` is its place at the top of the side panel from 900 px up, where
 * it folds to one line of names and HP. On a phone it is the Party panel,
 * and `onLeave` closes that sheet before the map moves.
 */
export function PartyBar(props: { dock?: boolean; onLeave?(): void }) {
  const ui = useRoomUi();
  const scope = useRoomScope();
  const members = useRoomView((s) => s.view?.members);
  const characters = useRoomView((s) => s.view?.characters);
  const tokens = useRoomView((s) => s.view?.tokens);
  const sceneId = useRoomView((s) => s.sceneId);
  const [folded, setFolded] = useState(() => (props.dock ? readFolded() : false));
  const entries = useMemo(
    () => (members && characters && tokens ? partyEntries({ members, characters, tokens }, sceneId) : []),
    [members, characters, tokens, sceneId],
  );

  const frame = (entry: PartyEntry) => {
    const token = entry.tokenId ? tokens?.[entry.tokenId] : undefined;
    if (!token) return;
    props.onLeave?.();
    ui.tap(token.id);
    const fp = footprint(token);
    requestPan(scope, {
      sceneId: token.sceneId,
      x: token.x + fp.w / 2,
      y: token.y + fp.h / 2,
      anchor: panAnchor(layoutSize(window, uiScale()), theme.layout.wideMinWidth, false),
    });
  };
  const ask = () => {
    props.onLeave?.();
    openAsk(scope, { kind: "party" });
  };
  const toggle = () => {
    setFolded((f) => {
      storeFolded(!f);
      return !f;
    });
  };

  if (entries.length === 0) {
    return props.dock ? null : <Empty>No player plays a character yet. Characters that players own show here.</Empty>;
  }

  return (
    <section aria-label="Party" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
        {props.dock ? (
          <button type="button" onClick={toggle} aria-expanded={!folded} style={headingButton}>
            Party
            <Icon name={folded ? "chevronRight" : "chevronDown"} size="sm" />
          </button>
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <Button size="sm" onClick={ask}>
          Ask the party
        </Button>
      </div>
      {folded ? (
        <div role="list" style={{ display: "flex", gap: theme.space(1), overflowX: "auto", scrollbarWidth: "thin", whiteSpace: "nowrap" }}>
          {entries.map((e) => (
            <button
              key={e.character.id}
              type="button"
              role="listitem"
              disabled={!e.tokenId}
              onClick={() => frame(e)}
              aria-label={`${e.character.name}, HP ${hpLine(e.hp)}${e.tokenId ? ". Show it on the map" : ""}`}
              style={{ ...pill, cursor: e.tokenId ? "pointer" : "default" }}
            >
              <strong>{e.character.name}</strong> <span style={{ color: LABEL_COLOR[e.label] }}>{lifeWord(e.life) ?? hpLine(e.hp)}</span>
            </button>
          ))}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(0.5), maxHeight: props.dock ? screenHeight(40) : undefined, overflowY: props.dock ? "auto" : undefined }}>
          {entries.map((e) => (
            <li key={e.character.id}>
              <Entry entry={e} onFrame={() => frame(e)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Entry(props: { entry: PartyEntry; onFrame(): void }) {
  const { entry } = props;
  const life = lifeWord(entry.life);
  const color = LABEL_COLOR[entry.label];
  const here = entry.tokenId !== null;
  return (
    <button
      type="button"
      onClick={props.onFrame}
      disabled={!here}
      aria-label={`${entry.character.name}: HP ${hpLine(entry.hp)}${life ? `, ${life}` : ""}, AC ${entry.ac}, Passive Perception ${entry.passivePerception}${here ? ". Show it on the map" : ", not on this scene"}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(2),
        width: "100%",
        minHeight: theme.touch,
        padding: `${theme.space(1)}px ${theme.space(2)}px`,
        borderRadius: theme.radius.sm,
        border: "none",
        background: theme.color.surfaceRaised,
        color: theme.color.text,
        fontFamily: theme.font.body,
        textAlign: "left",
        cursor: here ? "pointer" : "default",
      }}
    >
      <Portrait entry={{ characterId: entry.character.id }} size={36} dim={entry.life === "dead"} />
      <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: theme.space(2) }}>
          <strong style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: theme.font.body14 }}>{entry.character.name}</strong>
          <span style={{ fontSize: theme.font.small, fontVariantNumeric: "tabular-nums" }}>
            {entry.hp.cur}/{entry.hp.max}
            {entry.hp.temp > 0 ? <span style={{ color: theme.color.ally }}> +{entry.hp.temp}</span> : null}
          </span>
        </span>
        {life ? (
          <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.bold, color: entry.life === "stable" ? theme.color.warning : entry.life === "dead" ? theme.color.textMuted : theme.color.danger }}>{life}</span>
        ) : (
          <span aria-hidden style={{ height: 4, borderRadius: theme.radius.xs, background: theme.color.border, overflow: "hidden" }}>
            <span style={{ display: "block", width: `${Math.round(entry.fraction * 100)}%`, height: "100%", background: color }} />
          </span>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: theme.space(2), fontSize: theme.font.small, color: theme.color.textMuted }}>
          <Stat icon={SHIELD} label="AC" value={entry.ac} />
          <Stat icon={EYE} label="Passive Perception" value={entry.passivePerception} />
          <span style={{ flex: 1 }} />
          {entry.chips.map((effect) => {
            const chip = effectChip(effect);
            return (
              <span
                key={effect.id}
                title={chip.label}
                aria-hidden
                style={{
                  minWidth: 20,
                  height: 18,
                  padding: "0 3px",
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
              </span>
            );
          })}
          {entry.more > 0 ? <span>+{entry.more}</span> : null}
        </span>
        {!here ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>Not on this scene</span> : null}
      </span>
    </button>
  );
}

const SHIELD = "M12 2 4 5v6c0 5.2 3.4 9.8 8 11 4.6-1.2 8-5.8 8-11V5z";
const EYE = "M12 5C6.6 5 2.7 9.2 1.5 12c1.2 2.8 5.1 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.4 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z";

function Stat(props: { icon: string; label: string; value: number }) {
  return (
    <span title={props.label} style={{ display: "inline-flex", alignItems: "center", gap: theme.space(0.75), color: theme.color.text }}>
      <svg aria-hidden width={14} height={14} viewBox="0 0 24 24" style={{ fill: theme.color.textMuted }}>
        <path d={props.icon} />
      </svg>
      {props.value}
    </span>
  );
}

/** The "Party" heading as a disclosure, in the look of a section label (components/Panel.tsx SectionLabel), with a chevron that says which way it folds. */
const headingButton: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  minHeight: theme.touch,
  padding: 0,
  background: "transparent",
  border: "none",
  color: theme.color.textMuted,
  fontSize: theme.font.small,
  fontWeight: theme.weight.bold,
  letterSpacing: theme.caps,
  textTransform: "uppercase",
  fontFamily: theme.font.body,
  textAlign: "left",
  cursor: "pointer",
};

const pill: CSSProperties = {
  flex: "none",
  minHeight: theme.touch,
  padding: `0 ${theme.space(2)}px`,
  borderRadius: theme.radius.sm,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  background: theme.color.surfaceRaised,
  color: theme.color.text,
  fontSize: theme.font.small,
  fontFamily: theme.font.body,
};
