import { useId, useSyncExternalStore } from "react";
import { Button } from "../../components/Button.tsx";
import { Select } from "../../components/Field.tsx";
import { GRABBER_DESIGNS, GRABBER_TOP, grabberDesign, parseGrabber, type GrabberId } from "../../components/grabberDesigns.ts";
import { Help, Section } from "../../components/Panel.tsx";
import { RadioCards } from "../../components/RadioCards.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { GrabberDrawing } from "../../components/SheetGrabber.tsx";
import { Switch } from "../../components/Switch.tsx";
import { enterFullscreen, exitFullscreen, fullscreenSupported, useFullscreen } from "../../lib/fullscreen.ts";
import { theme } from "../../lib/theme.ts";
import { UNBOUND, type KeyMap } from "../../state/keyBindings.ts";
import { useRoomScope } from "../../state/scope.ts";
import { keySuffix, keyText, setShortcutSheet, useKeyHint, useShortcutKeys } from "../../state/shortcuts.ts";
import { setSoundOn, useSoundOn } from "../encounter/alerts.ts";
import { setSoundEnabled, usePingSound } from "../pings/feedback.ts";
import { diceLoader } from "../dice/throw/hooks.ts";
import { useWeatherStillReason, WEATHER_CARDS } from "../weather/store.ts";
import { useDeviceStillReason } from "../animmap/AnimMapController.tsx";
import { useServerAnimatedMaps } from "../animmap/status.ts";
import { ANIMATED_MAPS_CHOICES, ANIMATED_MAPS_HELP, ANIMATED_MAPS_LABEL, ANIMATED_MAPS_WORDS, deviceStillHelp, LOW_POWER_HELP, type AnimatedMapsChoice } from "../animmap/words.ts";
import { DiceSetPicker } from "./DiceSetPicker.tsx";
import {
  setAnimatedMaps,
  setLowPower,
  setMapDetail,
  setRollAnimation,
  setRollToasts,
  setSheetHandle,
  setUiScale,
  setThemeChoice,
  setWeatherMode,
  THEME_CHOICE_WORDS,
  THEME_CHOICES,
  UI_SCALES,
  uiScaleLabel,
  useAnimatedMaps,
  useLowPower,
  useMapVariant,
  useRollAnimation,
  useRollToastsOn,
  useSheetHandle,
  useThemeChoice,
  useUiScale,
  useWeatherMode,
  type ThemeChoice,
  type UiScale,
} from "./settings.ts";

/*
 * The help below names a key as this device has it. A shortcut can have no
 * key, where a change took its default (state/keyBindings.ts keysInEffect),
 * and then the help says so, as the sheet's "No key" does, rather than
 * leave a gap where the key would be (ISO5P2-OPUS-1).
 */

/** Full screen's help, with its key as this device has it. */
export function fullscreenHelp(keys: KeyMap): string {
  const key = keys.fullscreen === UNBOUND ? null : keyText("fullscreen", keys);
  return `The room fills the whole screen, without the browser's bars. ${key ? `With a keyboard, ${key} turns it on and off.` : "Its shortcut has no key on this device."}`;
}

/** The Shortcuts section's help, with Next turn's key as this device has it. */
export function shortcutsHelp(keys: KeyMap): string {
  const key = keys.turn === UNBOUND ? null : keyText("turn", keys);
  const keyboard = key
    ? `With a keyboard, letters pick tools, arrow keys move the selected tokens, and ${key} moves the turn on.`
    : "With a keyboard, letters pick tools and arrow keys move the selected tokens. Next turn has no key on this device.";
  return `${keyboard} The list also says what Shift, Ctrl or Space do with the mouse, and with a keyboard its Change moves a key, on this device only.`;
}

/**
 * Menu, This device (docs/design/design-v1-dm-tools.md 2.7): what belongs to this
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
  const rollAnimation = useRollAnimation();
  const dice = useSyncExternalStore(diceLoader.subscribe, diceLoader.state, diceLoader.state);
  const fullscreen = useFullscreen();
  // The keys the help below names, as this device has them.
  const keys = useShortcutKeys();
  const sheetKey = useKeyHint("sheet");
  const handle = useSheetHandle();
  const handleHelp = useId();
  const weather = useWeatherMode();
  const weatherStill = useWeatherStillReason();
  const themeChoice = useThemeChoice();
  const themeHelp = useId();
  const animatedMapsOn = useServerAnimatedMaps();
  const animatedMaps = useAnimatedMaps();
  const animatedStill = useDeviceStillReason();
  return (
    <div style={{ display: "grid" }}>
      <Section label="Interface size" divider={false}>
        <Help>The bars, panels and the names and marks on tokens. The map keeps its own zoom: pinch or use the wheel.</Help>
        <Segmented<UiScale> label="Interface size" grow value={scale} options={UI_SCALES.map((s) => ({ value: s, label: uiScaleLabel(s) }))} onChange={setUiScale} />
      </Section>
      <ThemeSection value={themeChoice} helpId={themeHelp} />
      {/* Where the browser can, so not on iPhone Safari (lib/fullscreen.ts). Here too, since a phone's top bar has no room for the button and a touch screen may have no keyboard. */}
      {fullscreenSupported() ? (
        <Section label="Screen">
          <Switch
            label="Full screen"
            help={fullscreenHelp(keys)}
            checked={fullscreen}
            onChange={(on) => void (on ? enterFullscreen() : exitFullscreen())}
          />
        </Section>
      ) : null}
      <Section label="Battery">
        <Switch
          label="Low power"
          help={
            animatedMapsOn
              ? LOW_POWER_HELP
              : "Draws the map at a lower resolution, skips small animations, keeps weather still and shows rolls without dice, to save battery on long sessions. Text on the map looks softer."
          }
          checked={lowPower}
          onChange={setLowPower}
        />
      </Section>
      <Section label="Map detail">
        {/* In a settings row's padding, as Room settings stands the same cards, so its label stands where Battery's and Sounds' do (docs/design/design-v1-spacing-pass.md S3). */}
        <div style={{ padding: `${theme.space(2)}px 0` }}>
          <RadioCards
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
        </div>
        {/* Hidden while the server's switch is off, since no map can move then (docs/design/design-v1-animated-maps.md 4.4). */}
        {animatedMapsOn ? (
          <div style={{ padding: `${theme.space(2)}px 0` }}>
            <RadioCards<AnimatedMapsChoice>
              legend={ANIMATED_MAPS_LABEL}
              // Only while Moving is chosen: Still already shows the still.
              help={animatedMaps === "moving" && animatedStill ? deviceStillHelp(animatedStill) : undefined}
              value={animatedMaps}
              options={ANIMATED_MAPS_CHOICES.map((c) => ({ value: c, label: ANIMATED_MAPS_WORDS[c], help: ANIMATED_MAPS_HELP[c] }))}
              onChange={setAnimatedMaps}
            />
          </div>
        ) : null}
      </Section>
      <Section label="Weather">
        {/* In a settings row's padding, as Map detail's cards stand. */}
        <div style={{ padding: `${theme.space(2)}px 0` }}>
          <RadioCards
            legend="Weather on the map"
            // Only while Moving is chosen: Still and Off already keep it still.
            help={weather === "moving" && weatherStill ? weatherStill : undefined}
            value={weather}
            options={WEATHER_CARDS}
            onChange={setWeatherMode}
          />
        </div>
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
        <Switch
          label="Roll animation"
          help={
            dice === "no-webgl"
              ? "This device cannot draw the dice, so the result shows at once."
              : lowPower
                ? "Low power shows each result at once, without dice."
                : "Your own rolls in the Dice panel and from stat blocks throw dice that land on the result in about a second. A tap or a key shows it at once."
          }
          checked={rollAnimation}
          onChange={setRollAnimation}
        />
        <DiceSetPicker />
      </Section>
      <Section label="Shortcuts">
        <Help>{shortcutsHelp(keys)}</Help>
        <Button size="sm" aria-keyshortcuts={sheetKey?.aria} onClick={() => setShortcutSheet(scope, true)} style={{ justifySelf: "start" }}>
          <span>
            Show the shortcuts
            <span aria-hidden>{keySuffix(sheetKey)}</span>
          </span>
        </Button>
      </Section>
      <Section label="Sheet handle">
        <Help id={handleHelp}>The mark at the top of a phone's sheets that shows you can swipe them. It fills with your color as you pull one, fully when letting go would move it.</Help>
        <Select aria-label="Sheet handle" aria-describedby={handleHelp} value={handle} onChange={(e) => setSheetHandle(parseGrabber(e.target.value))} style={{ width: "100%" }}>
          {GRABBER_DESIGNS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <SheetHandlePreview id={handle} />
      </Section>
    </div>
  );
}

/**
 * The Menu's This device row's detail (panels/MenuPanel.tsx), without
 * full screen where the browser has none. "theme" comes early, so the no-break space that holds "sheet
 * handle" together still ends the line: at 390 px and 130% "handle."
 * never wraps onto a line alone.
 */
export function deviceDetail(fullscreen: boolean): string {
  return `Interface size, theme, ${fullscreen ? "full screen, " : ""}low power, map detail, weather, sounds, roll animation, shortcuts and sheet\u00a0handle.`;
}

/** The Theme section's help, which is also the row's description. */
export const THEME_HELP = "Auto follows this device's own light or dark setting. The map, the fog, the dice tray and the table display stay dark in both.";

/**
 * Theme (docs/design/design-v1-light-theme.md 4.1): Dark, Light or Auto,
 * in the Interface size row's component, so the three share one row as
 * its four do. A pick recolors the page at once (lib/scheme.ts), and
 * every other open window of the app follows it.
 */
export function ThemeSection(props: { value: ThemeChoice; helpId: string }) {
  return (
    <Section label="Theme">
      <Help id={props.helpId}>{THEME_HELP}</Help>
      <Segmented<ThemeChoice>
        label="Theme"
        grow
        describedBy={props.helpId}
        value={props.value}
        options={THEME_CHOICES.map((c) => ({ value: c, label: THEME_CHOICE_WORDS[c] }))}
        onChange={setThemeChoice}
      />
    </Section>
  );
}

/** The preview's band, and how far below its top the sheet's top edge rises in it: room for the tallest design under its 5 px. */
const PREVIEW_HEIGHT = 32;
const PREVIEW_SHEET_TOP = theme.space(2);

/**
 * The chosen handle at its real size, so the choice shows without opening
 * a sheet (docs/design/design-v1-sheet-swipe.md 4.8): drawn as a sheet's top edge
 * rising over the map's ground, with the handle where a sheet puts it, 5 px
 * under that edge inside its border, in its color at rest. One picture to
 * a screen reader, which already hears the choice from the select.
 */
function SheetHandlePreview(props: { id: GrabberId }) {
  const design = grabberDesign(props.id);
  return (
    <div
      role="img"
      aria-label={`${design.name} on a sheet`}
      style={{ position: "relative", height: PREVIEW_HEIGHT, overflow: "hidden", borderRadius: theme.radius.md, background: theme.color.bg }}
    >
      <div
        style={{
          position: "absolute",
          inset: `${PREVIEW_SHEET_TOP}px ${theme.space(3)}px 0`,
          background: theme.color.surface,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          borderBottom: "none",
          borderRadius: `${theme.radius.lg}px ${theme.radius.lg}px 0 0`,
        }}
      >
        <GrabberDrawing design={design} attrs={{ "data-grabber-preview": "" }} style={{ position: "absolute", top: GRABBER_TOP, left: "50%", marginLeft: -design.width / 2, color: theme.color.controlBorder }} />
      </div>
    </div>
  );
}
