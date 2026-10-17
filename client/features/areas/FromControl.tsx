import { useEffect, useId, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Icon } from "../../components/Icon.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Popover, usePopover } from "../../components/Popover.tsx";
import { theme } from "../../lib/theme.ts";
import { POPOVER_MIN } from "../../pages/optionsLayout.ts";
import { Portrait } from "../encounter/parts.tsx";
import { ChoiceRows, Labelled, OptButton, StableWords, useOpenInSlot, usePopoverFrame, useSlotPlace, type RowOption, type SlotForm } from "../measure/controls.tsx";
import type { AreaCreature, FromControl as FromState } from "./caster.ts";

/**
 * The area tool's From control (docs/design-v1-area-from-character.md
 * 3.2): who the area comes from, first in its row.
 *
 * - One creature: a pressed toggle, "From Thorn", with a fixed name.
 * - Two or more: a choice chip whose words are the value, "From Pip" or
 *   "No caster", drawn at the widest of them, whose "Cast from" popover
 *   lists them with their pictures, and No caster last.
 * - None of the player's creatures here: the toggle, disabled, still a Tab
 *   stop described by the reason, so the row never changes shape when a
 *   creature comes or goes.
 *
 * All three are one button, so focus stays on it when a companion arrives
 * and the toggle becomes the chip. Its compact form is a 44 px square
 * holding the creature's picture. A long name ends in an ellipsis past
 * about ten characters, so it never sets the row's width, and the whole
 * name stays in the control's name and tooltip.
 */

export type ShownFrom = Exclude<FromState, { form: "none" }>;

export const NO_CREATURE = "None of your creatures is on this scene.";

/** The radio value of No caster: no token id is empty. */
const NONE = "";

export function FromControl(props: { control: ShownFrom; onPick(offer: AreaCreature | null): void }) {
  const place = useSlotPlace();
  if (place?.at === "measure") return <span style={look(props.control, place.form, false)}>{face(props.control, place.form)}</span>;
  if (place?.at === "more" || place?.at === "popover") return <FromInMore {...props} />;
  return <LiveFrom {...props} form={place?.form ?? "full"} />;
}

function LiveFrom(props: { control: ShownFrom; onPick(offer: AreaCreature | null): void; form: SlotForm }) {
  const { control, onPick } = props;
  const handle = usePopover({ kind: "dialog" });
  const frame = usePopoverFrame();
  const reasonId = useId();
  const chip = control.form === "chip";
  const disabled = control.form === "disabled";
  useOpenInSlot(handle.open);
  // A companion leaving turns the chip back into the toggle, and its popover goes with it.
  const { open, close } = handle;
  useEffect(() => {
    if (!chip && open) close("state");
  }, [chip, open, close]);
  const words = wordsOf(control);
  return (
    <>
      <button
        type="button"
        ref={handle.anchorProps.ref}
        aria-label={words}
        aria-pressed={chip ? undefined : control.form === "toggle" && control.on}
        aria-haspopup={chip ? "dialog" : undefined}
        aria-expanded={chip ? open : undefined}
        aria-controls={chip ? handle.anchorProps["aria-controls"] : undefined}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        title={disabled ? NO_CREATURE : control.form === "toggle" ? `Cast areas from ${control.offer.name}` : words}
        onClick={(e) => {
          if (control.form === "chip") handle.anchorProps.onClick(e);
          else if (control.form === "toggle") onPick(control.on ? null : control.offer);
        }}
        style={look(control, props.form, open)}
      >
        {face(control, props.form)}
      </button>
      {disabled ? (
        <span id={reasonId} hidden>
          {NO_CREATURE}
        </span>
      ) : null}
      {control.form === "chip" ? (
        <Popover handle={handle} side="above" bound={frame.bound} rise={frame.rise} gap={frame.gap} minHeight={POPOVER_MIN} title="Cast from">
          <PickRows control={control} onPick={onPick} close={() => close("pick")} />
        </Popover>
      ) : null}
    </>
  );
}

/**
 * The chip's rows. A pick closes the popover: a pointer's click on a row,
 * or Enter or Space on one. The arrows move the choice and leave it open,
 * as every choice popover does (docs/design-v1-tool-options.md 7.5).
 */
function PickRows(props: { control: Extract<ShownFrom, { form: "chip" }>; onPick(offer: AreaCreature | null): void; close?: () => void }) {
  const { control, close } = props;
  const isRadio = (t: EventTarget): t is HTMLInputElement => t instanceof HTMLInputElement && t.type === "radio";
  const onClick = (e: ReactMouseEvent) => {
    if (close && e.detail > 0 && isRadio(e.target)) close();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!close || (e.key !== "Enter" && e.key !== " ") || !isRadio(e.target)) return;
    e.preventDefault();
    if (!e.target.checked) e.target.click();
    close();
  };
  const options: RowOption<string>[] = [
    ...control.offers.map(
      (o): RowOption<string> => ({ value: o.tokenId, label: o.name, picture: <Picture creature={o} />, ...(o.kind === "companion" ? { detail: "companion" } : {}) }),
    ),
    { value: NONE, label: "No caster", picture: <Icon name="noCaster" size={theme.layout.options.disk} /> },
  ];
  return (
    <div onClick={onClick} onKeyDown={onKeyDown} style={{ display: "contents" }}>
      <ChoiceRows label="Cast from" value={control.on ?? NONE} options={options} onChange={(v) => props.onPick(control.offers.find((o) => o.tokenId === v) ?? null)} />
    </div>
  );
}

/** In ⋯, where the fit sends it only when even the priority-1 controls do not fit: a row, or the chip's rows under its title. */
function FromInMore(props: { control: ShownFrom; onPick(offer: AreaCreature | null): void }) {
  const { control, onPick } = props;
  if (control.form === "chip") {
    return (
      <Labelled label="Cast from">
        <PickRows control={control} onPick={onPick} />
      </Labelled>
    );
  }
  if (control.form === "disabled") return <OptButton disabled onClick={() => undefined}>{wordsOf(control)}</OptButton>;
  return (
    <OptButton pressed={control.on} onClick={() => onPick(control.on ? null : control.offer)}>
      {wordsOf(control)}
    </OptButton>
  );
}

/** Its whole words, which are its name: "From Thorn", "No caster" or "From you". */
function wordsOf(control: ShownFrom): string {
  if (control.form === "toggle") return `From ${control.offer.name}`;
  if (control.form === "disabled") return control.name === null ? "From you" : `From ${control.name}`;
  const on = control.offers.find((o) => o.tokenId === control.on);
  return on ? `From ${on.name}` : "No caster";
}

/** "From Thorn", with a long name cut at theme.layout.options.name. */
function FromWords(props: { name: string | null }) {
  if (props.name === null) return <span style={{ whiteSpace: "nowrap" }}>From you</span>;
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      From{" "}
      <span style={{ display: "inline-block", maxWidth: theme.layout.options.name, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "top" }}>
        {props.name}
      </span>
    </span>
  );
}

function face(control: ShownFrom, form: SlotForm): ReactNode {
  const chip = control.form === "chip";
  if (form === "compact") {
    return (
      <>
        <CompactPicture control={control} />
        {chip ? (
          // As the toolbar's menu buttons carry it (docs/design-v1-tool-options.md 5.1).
          <span aria-hidden style={{ position: "absolute", top: theme.space(0.5), right: theme.space(0.5), display: "grid" }}>
            <Icon name="caret" size={theme.icon.sm - 4} />
          </span>
        ) : null}
      </>
    );
  }
  if (control.form === "toggle") return <FromWords name={control.offer.name} />;
  if (control.form === "disabled") return <FromWords name={control.name} />;
  const current = control.offers.find((o) => o.tokenId === control.on);
  return (
    <>
      <StableWords current={current ? <FromWords name={current.name} /> : "No caster"} all={[...control.offers.map((o) => <FromWords key={o.tokenId} name={o.name} />), "No caster"]} />
      <Icon name="caret" size="sm" />
    </>
  );
}

function CompactPicture(props: { control: ShownFrom }) {
  const { control } = props;
  if (control.form === "toggle") return <Picture creature={control.offer} />;
  if (control.form === "disabled") {
    return control.characterId !== undefined ? (
      <Portrait entry={{ characterId: control.characterId, label: control.name ?? "" }} size={theme.layout.options.disk} />
    ) : (
      <Icon name="noCaster" size={theme.layout.options.disk} />
    );
  }
  const on = control.offers.find((o) => o.tokenId === control.on);
  return on ? <Picture creature={on} /> : <Icon name="noCaster" size={theme.layout.options.disk} />;
}

/** The creature's portrait as the tracker draws it: the token's image, else its character's, else initials. */
function Picture(props: { creature: AreaCreature }) {
  const { creature } = props;
  return <Portrait entry={{ tokenId: creature.tokenId, ...(creature.characterId !== undefined ? { characterId: creature.characterId } : {}), label: creature.name }} size={theme.layout.options.disk} />;
}

/**
 * The button's look in each form: a small button's for the toggle, a value
 * chip's for the chip (components/Button.tsx `sm`, controls.tsx chipLook),
 * and a 44 px square for the compact form.
 */
function look(control: ShownFrom, form: SlotForm, open: boolean): CSSProperties {
  const disabled = control.form === "disabled";
  const chip = control.form === "chip";
  const state = { pressed: chip ? open : control.form === "toggle" && control.on, disabled };
  const base: CSSProperties = {
    flex: "none",
    boxSizing: "border-box",
    minHeight: theme.touch,
    minWidth: theme.touch,
    borderRadius: theme.radius.md,
    fontFamily: theme.font.body,
    fontSize: theme.font.body14,
    fontWeight: theme.weight.strong,
    whiteSpace: "nowrap",
    cursor: disabled ? "default" : "pointer",
    ...buttonLook("secondary", state),
  };
  if (form === "compact") return { ...base, position: "relative", display: "grid", placeItems: "center", width: theme.touch, height: theme.touch, padding: 0 };
  if (chip) return { ...base, display: "inline-flex", alignItems: "center", gap: theme.space(1), padding: `0 ${theme.space(1.5)}px 0 ${theme.space(3)}px` };
  return { ...base, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: theme.space(2), padding: `0 ${theme.space(3)}px` };
}
