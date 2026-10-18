import { useMemo, useState, type CSSProperties } from "react";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Pill, PILL_FOCUS, PILL_HOST, PillButton } from "../../components/HeaderRow.tsx";
import { Icon } from "../../components/Icon.tsx";
import { ScrollStrip } from "../../components/ScrollStrip.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
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

/**
 * The fold this device stored. With none, a short layout's side panel
 * starts folded (docs/design-v1-layout-hierarchy.md 4.1), where the whole
 * bar left the open panel almost no body.
 */
function readFolded(short: boolean): boolean {
  try {
    const stored = localStorage.getItem(FOLD_KEY);
    return stored === null ? short : stored === "1";
  } catch {
    return short;
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
 * shield, Passive Perception as "PP 13", up to three condition chips, and
 * Dying, Stable or Dead in place of the bar. A tap frames the character's
 * token on the scene in view and opens its action bar. "Ask the party"
 * opens Request a roll for the same party.
 *
 * `dock` is its place at the top of the side panel from 900 px up, where
 * it folds to one line (docs/design-v1-side-headers.md): Party, the names
 * and HP in a strip that scrolls sideways, and Ask, so the folded bar
 * takes one header row. On a phone it is the Party panel, and `onLeave`
 * closes that sheet before the map moves.
 */
export function PartyBar(props: { dock?: boolean; short?: boolean; onLeave?(): void }) {
  const ui = useRoomUi();
  const scope = useRoomScope();
  const members = useRoomView((s) => s.view?.members);
  const characters = useRoomView((s) => s.view?.characters);
  const tokens = useRoomView((s) => s.view?.tokens);
  const sceneId = useRoomView((s) => s.sceneId);
  const [folded, setFolded] = useState(() => (props.dock ? readFolded(props.short ?? false) : false));
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

  const heading = props.dock ? (
    <button type="button" onClick={toggle} aria-expanded={!folded} style={{ ...headingButton, flex: folded ? "none" : 1 }}>
      Party
      <Icon name={folded ? "chevronRight" : "chevronDown"} size="sm" />
    </button>
  ) : null;

  // Folded, one line: the names scroll sideways between Party and Ask, which is "Ask" there for the room, its name still whole.
  if (props.dock && folded) {
    return (
      <section aria-label="Party" style={{ display: "flex", alignItems: "center", gap: theme.space(1), minHeight: theme.touch }}>
        {heading}
        <ScrollStrip edge={4} style={{ flex: 1 }}>
          <FoldedParty entries={entries} onFrame={frame} />
        </ScrollStrip>
        <PillButton aria-label="Ask the party" title="Ask the party" onClick={ask}>
          Ask
        </PillButton>
      </section>
    );
  }

  return (
    <section aria-label="Party" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1), minHeight: theme.touch }}>
        {heading ?? <span style={{ flex: 1 }} />}
        {props.dock ? (
          <PillButton onClick={ask}>Ask the party</PillButton>
        ) : (
          <Button size="sm" onClick={ask}>
            Ask the party
          </Button>
        )}
      </div>
      {/* One column no wider than the bar, so a long name ends in an ellipsis rather than pushing every row's HP past the edge. */}
      <ul style={{ listStyle: "none", margin: 0, padding: props.dock ? `0 0 ${theme.space(2)}px` : 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(0.5), maxHeight: props.dock ? screenHeight(40) : undefined, overflowY: props.dock ? "auto" : undefined }}>
        {entries.map((e) => (
          <li key={e.character.id}>
            <Entry entry={e} onFrame={() => frame(e)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The folded bar: one line of names and HP, which the party line scrolls
 * sideways (components/ScrollStrip.tsx). Each pill is a button in a
 * `listitem` of its own. With `role="listitem"` on the button itself, a
 * screen reader heard a list item and never a button to press.
 *
 * A character with no token on this scene keeps a button that does
 * nothing (`aria-disabled`), not a disabled one, so Tab still reaches it
 * and the strip scrolls it into view: every name in the line can be read
 * by keyboard. A long name ends in an ellipsis, whole in its name.
 */
export function FoldedParty(props: { entries: readonly PartyEntry[]; onFrame(entry: PartyEntry): void }) {
  return (
    <div role="list" style={{ flex: "none", display: "flex", gap: theme.space(1), whiteSpace: "nowrap" }}>
      {props.entries.map((e) => (
        <div key={e.character.id} role="listitem" style={{ flex: "none", display: "flex" }}>
          <button
            type="button"
            aria-disabled={e.tokenId ? undefined : true}
            onClick={() => {
              if (e.tokenId) props.onFrame(e);
            }}
            aria-label={`${e.character.name}, HP ${hpLine(e.hp)}${e.tokenId ? ". Show it on the map" : ", not on this scene"}`}
            title={e.character.name}
            {...PILL_FOCUS}
            style={{ ...pill, cursor: e.tokenId ? "pointer" : "default" }}
          >
            <strong style={{ maxWidth: CHIP_NAME_MAX, overflow: "hidden", textOverflow: "ellipsis", color: e.tokenId ? theme.color.text : theme.color.textMuted }}>{e.character.name}</strong>
            <span style={{ color: LABEL_COLOR[e.label] }}>{lifeWord(e.life) ?? hpLine(e.hp)}</span>
            <Pill look={{ background: theme.color.surfaceRaised, border: `${theme.line.border}px solid ${theme.color.border}` }} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** A chip's name past this many px ends in an ellipsis: "Seraphina Nig…", room for two or three chips in the line. */
const CHIP_NAME_MAX = 96;

export function Entry(props: { entry: PartyEntry; onFrame(): void }) {
  const { entry } = props;
  const life = lifeWord(entry.life);
  const color = LABEL_COLOR[entry.label];
  const here = entry.tokenId !== null;
  const ac = entry.shield;
  return (
    <button
      type="button"
      onClick={props.onFrame}
      disabled={!here}
      aria-label={`${entry.character.name}: HP ${hpLine(entry.hp)}${life ? `, ${life}` : ""}${ac !== null ? `, AC ${ac}` : ""}, Passive Perception ${entry.passivePerception}${here ? ". Show it on the map" : ", not on this scene"}`}
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
      {/* One column no wider than the row, so a long name ends in an ellipsis and its HP stays in view. */}
      <span style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(0.5) }}>
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
          {/* Both say what they are on screen, not in a tooltip a touch screen never shows (docs/design-v1-layout-hierarchy.md M9). */}
          {ac !== null ? <AcBadge ac={ac} size="sm" /> : null}
          <span style={{ position: "relative", whiteSpace: "nowrap" }}>
            <span aria-hidden>
              PP <span style={{ color: theme.color.text, fontVariantNumeric: "tabular-nums" }}>{entry.passivePerception}</span>
            </span>
            <span style={VISUALLY_HIDDEN}>Passive Perception {entry.passivePerception}</span>
          </span>
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

/** A party chip: a 44 px target with its shape on a pill (components/HeaderRow.tsx). */
const pill: CSSProperties = {
  ...PILL_HOST,
  flex: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: theme.space(1),
  minHeight: theme.touch,
  padding: `0 ${theme.space(2)}px`,
  border: "none",
  background: "transparent",
  color: theme.color.text,
  fontSize: theme.font.small,
  fontFamily: theme.font.body,
};
