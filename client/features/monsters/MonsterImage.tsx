import { useMemo, useState } from "react";
import type { ImageRef } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { initials } from "../../lib/tokenView.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { DEFAULT_CROP, type Crop } from "../images/crop.ts";
import { CropEditor } from "../images/CropEditor.tsx";
import { ImagePreview } from "../images/IconDisk.tsx";
import { ImagePicker } from "../images/ImagePicker.tsx";
import { iconCredit } from "../images/icons.ts";
import { applyOps, optInCount, optInLabel, planApply, sameImage, type MonsterRef } from "./images.ts";
import { isAssetImage } from "#shared/imageRef.ts";

/**
 * A monster's default image (features section 15): the image every token
 * placed from it starts with. The monster browser's stat block view sets it
 * at once and offers to put it on the monster's tokens already on this
 * scene. The custom monster editor keeps it in its draft, saved with the
 * rest of the block.
 */

type Step = { kind: "pick" } | { kind: "crop"; assetId: string; initial: Crop };

/**
 * The image's preview with Set, Crop and Remove. Picking runs the image
 * picker (upload, paste, link, web search, the room's library), then the
 * crop editor, both as dialogs. `onOpen` reports while one is open, so a
 * dialog underneath can leave Escape to it. With no image the disk shows
 * the monster's initials as its tokens do on the map.
 *
 * `fallback` is what shows while `value` is unset: an SRD monster's
 * shipped icon (docs/design-v1-starter-art.md section 6). It is never
 * stored, so it cannot be removed, and removing the DM's own image goes
 * back to it.
 */
export function MonsterImageField(props: {
  value: ImageRef | undefined;
  fallback?: ImageRef | undefined;
  onChange(next: ImageRef | null): void;
  name: string;
  onOpen?(open: boolean): void;
}) {
  const [step, setStepState] = useState<Step | null>(null);
  const shown = props.value ?? props.fallback;
  // A shipped icon has no crop (docs/design-v1-dm-tools.md 3.12).
  const value = shown && isAssetImage(shown) ? shown : undefined;
  const set = props.value !== undefined;
  const setStep = (next: Step | null) => {
    setStepState(next);
    props.onOpen?.(next !== null);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(3) }}>
      <ImagePreview image={shown} shape="circle" aspect={1} width={64} ring={theme.color.hostile} initials={initials(props.name)} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        <Button size="sm" onClick={() => setStep({ kind: "pick" })}>
          {shown ? "Change image" : "Set image"}
        </Button>
        {value ? (
          <Button size="sm" onClick={() => setStep({ kind: "crop", assetId: value.assetId, initial: value.crop })}>
            Crop
          </Button>
        ) : null}
        {set && props.fallback ? (
          <Button size="sm" onClick={() => props.onChange(null)}>
            Use the default icon
          </Button>
        ) : set ? (
          <Button variant="danger" size="sm" onClick={() => props.onChange(null)}>
            Remove image
          </Button>
        ) : null}
      </div>
      {step?.kind === "pick" ? (
        <ImagePicker
          current={shown}
          onClose={() => setStep(null)}
          onPick={(image) => setStep({ kind: "crop", assetId: image.id, initial: DEFAULT_CROP })}
          onPickIcon={(icon) => {
            props.onChange(icon);
            setStep(null);
          }}
        />
      ) : null}
      {step?.kind === "crop" ? (
        <CropEditor
          assetId={step.assetId}
          initial={step.initial}
          shape="circle"
          aspect={1}
          onCancel={() => setStep(null)}
          onSave={(crop) => {
            props.onChange({ assetId: step.assetId, crop });
            setStep(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The stat block view's image section: the field, and once the monster has
 * an image, an offer to put it on the monster's tokens on the scene this DM
 * views. Only that scene: a DM's view holds the tokens of the scene it
 * shows and no other (design 7.3), so the DM applies it on another scene by
 * opening the monster there.
 *
 * An SRD monster always has an image, its shipped icon until the DM picks
 * one (`fallback`), so the offer also puts that icon on tokens placed
 * before the defaults existed. It is the DM's tap that stores it on them.
 */
export function MonsterImageSection(props: {
  target: MonsterRef;
  name: string;
  /** The room's own image for the monster. */
  image: ImageRef | undefined;
  fallback?: ImageRef | undefined;
  onChange(next: ImageRef | null): void;
}) {
  const actions = useRoomActions();
  const tokens = useRoomView((s) => s.view?.tokens);
  const monsters = useRoomView((s) => s.view?.monsters);
  const sceneId = useRoomView((s) => s.sceneId);
  const { target } = props;
  const image = props.image ?? props.fallback;
  const credit = !props.image && image && "icon" in image ? iconCredit(image.icon) : null;

  // Every image the monster had while this was open, so tokens still wearing one count as the monster's, not as set by hand.
  const [shown, setShown] = useState(image);
  const [previous, setPrevious] = useState<readonly ImageRef[]>([]);
  const [includeOwn, setIncludeOwn] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  if (!sameImage(shown, image)) {
    if (shown) setPrevious([...previous, shown]);
    setShown(image);
    setApplied(null);
  }

  const plan = useMemo(
    () => (image && sceneId ? planApply({ tokens: Object.values(tokens ?? {}), sceneId, ref: target, monsters, image, previous }) : null),
    [image, sceneId, tokens, target, monsters, previous],
  );
  const optIn = plan ? optInCount(plan) : 0;
  const count = plan ? plan.plain.length + (includeOwn ? optIn : 0) : 0;
  const waiting = plan ? plan.plain.length + optIn : 0;

  const apply = () => {
    if (!plan || !image) return;
    const ops = applyOps(plan, image, includeOwn);
    dispatchGesture(actions, ops);
    setApplied(ops.length);
  };

  return (
    <section
      style={{
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        background: theme.color.surfaceRaised,
        border: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    >
      <SectionLabel>Token image</SectionLabel>
      <MonsterImageField value={props.image} fallback={props.fallback} onChange={props.onChange} name={props.name} />
      <Help>
        {props.image
          ? `Every ${props.name} placed from now on starts with this image. Players see it only on those tokens.`
          : image
            ? `Every ${props.name} placed from now on starts with this icon${credit ? ` (${credit.text})` : ""}. Change it to pick another for this room.`
            : `Set an image, and every ${props.name} placed from now on starts with it.`}
      </Help>
      {plan && waiting > 0 ? (
        <div style={{ display: "grid", gap: theme.space(2), paddingTop: theme.space(2), borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
          <span>{`${waiting} ${props.name} ${waiting === 1 ? "token" : "tokens"} on this scene ${waiting === 1 ? "shows" : "show"} another image or none.`}</span>
          {optIn > 0 ? (
            <Checkbox
              checked={includeOwn}
              onChange={setIncludeOwn}
              label={optInLabel(plan)}
              help="Off keeps an image chosen for one token, such as a disguise, and the look of a token a player plays. A token wearing an image this monster had before you opened it here counts as set by hand, unless it is an SRD monster's default icon."
            />
          ) : null}
          <Button variant="primary" size="sm" onClick={apply} disabled={count === 0}>
            {`Apply to ${count} ${count === 1 ? "token" : "tokens"} on this scene`}
          </Button>
          <Help>Tokens on other scenes keep theirs. Open this monster while viewing that scene to apply it there.</Help>
        </div>
      ) : null}
      {applied !== null ? <Notice role="status">{`Applied to ${applied} ${applied === 1 ? "token" : "tokens"}. One undo takes them all back.`}</Notice> : null}
    </section>
  );
}
