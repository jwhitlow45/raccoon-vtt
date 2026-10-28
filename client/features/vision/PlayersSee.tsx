import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Scene, ScenePreset } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { RadioCards, type RadioCardOption } from "../../components/RadioCards.tsx";
import { theme } from "../../lib/theme.ts";
import { newScenePreset, stepsDown, type NewSceneKind } from "../scenes/create.ts";
import { IMAGE_STEPS_DOWN, likeSummary, PLAYERS_SEE, PLAYERS_SEE_NAME, playersSeeOf, WALLLESS_TEXT } from "./playersSeeRules.ts";

export type PlayersSeeValue = ScenePreset | "like";

/**
 * Players see (docs/design-v1-map-discovery.md 8.1 and 9): the radio cards
 * of Room settings, one option a row with its help inside, as a radio
 * group named Players see and described by the chosen option's help, or
 * by `none` while nothing is chosen (Custom).
 *
 * `like` adds the new scene form's fourth option, named for the scene on
 * the DM's screen and described by what it copies. While `busy`, a change
 * on its way, a tap does nothing and `working` (the caller's, after the
 * shared delay) says what the server is doing.
 */
export function PlayersSeeChoice(props: {
  value: PlayersSeeValue | null;
  like?: { name: string; summary: string } | null;
  /** The words that describe the group while no option is chosen, kept mounted as a polite status. */
  none?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  working?: string | null;
  onChange(value: PlayersSeeValue): void;
}) {
  const options: RadioCardOption<PlayersSeeValue>[] = [...PLAYERS_SEE, ...(props.like ? [{ value: "like" as const, label: `Like ${props.like.name}`, help: props.like.summary }] : [])];
  return (
    <RadioCards<PlayersSeeValue>
      radiogroup
      legend={PLAYERS_SEE_NAME}
      value={props.value}
      options={options}
      none={props.none}
      disabled={props.disabled}
      busy={props.busy}
      // The status line is already the live region, so the wait inside it says nothing of its own, and the caller has waited the delay.
      status={props.working ? <Loading small live={false} delay={0} text={props.working} /> : null}
      onChange={props.onChange}
    />
  );
}

/**
 * Players see where a scene is made (8.1, 8.2): the new scene form under
 * Kind of scene, and the Universal VTT dialog in place of its fog choice.
 * It starts on the room's default for the kind, says so when a map image
 * steps down from Explore, offers Like the scene on the DM's screen, and
 * warns under Explore on a map with no walls, as the scene's settings do.
 */
export function NewScenePlayersSee(props: {
  kind: NewSceneKind;
  setting: ScenePreset | undefined;
  value: PlayersSeeValue;
  /** The scene on the DM's screen, which Like copies. */
  like: Scene | undefined;
  /** The new scene's map would have nothing that blocks sight. */
  wallless: boolean;
  disabled?: boolean;
  onChange(value: PlayersSeeValue): void;
}) {
  const { kind, setting, value, like } = props;
  const lands = value === "like" ? (like ? playersSeeOf(like) : newScenePreset(setting, kind)) : value;
  const steppedDown = stepsDown(setting, kind) && value === newScenePreset(setting, kind);
  return (
    <div style={{ display: "grid", minWidth: 0 }}>
      <PlayersSeeChoice value={value} like={like ? { name: like.name, summary: likeSummary(like) } : null} disabled={props.disabled} onChange={props.onChange} />
      {steppedDown ? <Help style={{ marginTop: theme.space(1) }}>{IMAGE_STEPS_DOWN}</Help> : null}
      <WarningStatus text={props.wallless && lands === "explore" ? WALLLESS_TEXT : null} />
    </div>
  );
}

/** A warning in a polite status kept mounted, so it is heard as it comes. Empty, it takes no room. */
export function WarningStatus(props: { text: string | null }) {
  return (
    <div role="status" style={props.text ? { marginTop: theme.space(1) } : undefined}>
      {props.text ? <Note>{props.text}</Note> : null}
    </div>
  );
}

/**
 * The question a change that forgets something asks first, under the
 * control that asked (8.1): its words in a polite status kept mounted,
 * then Cancel and Change. Focus stays on the control through the question,
 * as an untick's does, and Escape anywhere around it answers no (`useAsk`).
 */
export function AskFirst(props: { question: string | null; label: string; busy?: boolean; onCancel(): void; onConfirm(): void }) {
  const open = props.question !== null;
  // Closed, only the empty status is left, which takes no room in its control's box.
  return (
    <div
      role={open ? "group" : undefined}
      aria-label={open ? props.label : undefined}
      data-ask-first={open ? true : undefined}
      style={
        open
          ? {
              display: "grid",
              gap: theme.space(2),
              marginTop: theme.space(2),
              padding: theme.space(3),
              borderRadius: theme.radius.md,
              border: `${theme.line.border}px solid ${theme.color.border}`,
              background: theme.color.bg,
              minWidth: 0,
            }
          : undefined
      }
    >
      <p role="status" style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
        {props.question}
      </p>
      {open ? (
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" busy={props.busy} onClick={props.onConfirm}>
            Change
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A question's state for one place: what it asks, the change it holds, and
 * the element that had focus when it last asked, which gets it back once
 * answered, as long as it is still on the page. A second question takes
 * the control that asked it, so focus goes back to the choice the DM made
 * last, and `dismiss` closes a question without moving focus, for a
 * change that goes at once or a fold that closes over it.
 */
export function useAsk<T>(): {
  asking: { text: string; change: T } | null;
  ask(text: string, change: T): void;
  answer(): T | null;
  cancel(): void;
  dismiss(): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
} {
  const [asking, setAsking] = useState<{ text: string; change: T } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const back = () => {
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected) el.focus();
  };
  const cancel = () => {
    setAsking(null);
    back();
  };
  return {
    asking,
    ask: (text, change) => {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Focus on a question's own buttons is no control to go back to.
      if (!active?.closest("[data-ask-first]")) opener.current = active;
      setAsking({ text, change });
    },
    answer: () => {
      const change = asking?.change ?? null;
      setAsking(null);
      back();
      return change;
    },
    cancel,
    dismiss: () => {
      setAsking(null);
      opener.current = null;
    },
    onKeyDown: (e) => {
      if (!asking || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    },
  };
}
