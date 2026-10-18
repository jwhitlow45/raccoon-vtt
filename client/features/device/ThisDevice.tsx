import { Button } from "../../components/Button.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Switch } from "../../components/Switch.tsx";
import { enterFullscreen, exitFullscreen, fullscreenSupported, useFullscreen } from "../../lib/fullscreen.ts";
import { useRoomScope } from "../../state/scope.ts";
import { keyText, setShortcutSheet, useShortcutKeys } from "../../state/shortcuts.ts";
import { RadioGroup } from "../dm/controls.tsx";
import { setSoundOn, useSoundOn } from "../encounter/alerts.ts";
import { setSoundEnabled, usePingSound } from "../pings/feedback.ts";
import { setLowPower, setMapDetail, setRollToasts, setUiScale, UI_SCALES, uiScaleLabel, useLowPower, useMapVariant, useRollToastsOn, useUiScale, type UiScale } from "./settings.ts";

/**
 * Menu, This device (docs/design-v1-dm-tools.md 2.7): what belongs to this
 * device alone and is kept on it, never in the room. Each setting takes
 * effect at once, here and on the map behind the menu.
 */
export default function ThisDevice() {
  const scope = useRoomScope();
  const scale = useUiScale();
  const lowPower = useLowPower();
  const variant = useMapVariant();
  const turnSound = useSoundOn();
  const pingSound = usePingSound();
  const rollToasts = useRollToastsOn();
  const fullscreen = useFullscreen();
  // The keys the help below names, as this device has them.
  const keys = useShortcutKeys();
  return (
    <div style={{ display: "grid" }}>
      <Section label="Interface size" divider={false}>
        <Help>The bars, panels and the names and marks on tokens. The map keeps its own zoom: pinch or use the wheel.</Help>
        <Segmented<UiScale> label="Interface size" grow value={scale} options={UI_SCALES.map((s) => ({ value: s, label: uiScaleLabel(s) }))} onChange={setUiScale} />
      </Section>
      {/* Where the browser can, so not on iPhone Safari (lib/fullscreen.ts). Here too, since a phone's top bar has no room for the button and a touch screen may have no keyboard. */}
      {fullscreenSupported() ? (
        <Section label="Screen">
          <Switch
            label="Full screen"
            help={`The room fills the whole screen, without the browser's bars. With a keyboard, ${keyText("fullscreen", keys)} turns it on and off.`}
            checked={fullscreen}
            onChange={(on) => void (on ? enterFullscreen() : exitFullscreen())}
          />
        </Section>
      ) : null}
      <Section label="Battery">
        <Switch
          label="Low power"
          help="Draws the map at a lower resolution and skips small animations, to save battery on long sessions. Text on the map looks softer."
          checked={lowPower}
          onChange={setLowPower}
        />
      </Section>
      <Section label="Map detail">
        <RadioGroup
          legend="Map images"
          help={lowPower ? "Low power loads the phone size on every device." : undefined}
          value={lowPower ? "mobile" : variant}
          disabled={lowPower}
          options={[
            { value: "mobile", label: "Phone size", help: "Up to 4096 pixels across. Loads faster and needs less memory." },
            { value: "full", label: "Full size", help: "Sharper on a large screen. A big map can be too much for a phone." },
          ]}
          onChange={setMapDetail}
        />
      </Section>
      <Section label="Sounds">
        <Switch label="Turn sound" help="A short chime on your turn. Android phones also vibrate." checked={turnSound} onChange={setSoundOn} />
        <Switch
          label="Ping sound"
          help="A short tone when someone pings the map."
          checked={pingSound}
          onChange={setSoundEnabled}
        />
      </Section>
      <Section label="Rolls">
        <Switch label="Show others' rolls as they happen" help="A short note for each roll someone else makes, while the Dice panel is not on screen." checked={rollToasts} onChange={setRollToasts} />
      </Section>
      <Section label="Shortcuts">
        <Help>
          With a keyboard, letters pick tools, arrow keys move the selected tokens, and {keyText("turn", keys)} moves the turn on. The list also says what Shift, Ctrl or Space do with the mouse, and with a keyboard its Change moves a key, on this device only.
        </Help>
        <Button size="sm" onClick={() => setShortcutSheet(scope, true)} style={{ justifySelf: "start" }}>
          Show the shortcuts
        </Button>
      </Section>
    </div>
  );
}
