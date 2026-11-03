import { useEffect, useRef } from "react";
import { weatherParts, type SceneWeather } from "#shared/weather.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { sayJoined } from "../view/choice.ts";

/*
 * What the polite status says about the weather
 * (docs/design/design-v1-weather.md 4.2): the weather of the scene the viewer
 * is on when they arrive on it and when it changes, and that it is clear now
 * when it clears. No log line and no toast (D-261102-134). The status holds
 * one line, so a weather line that comes close to a view line joins it
 * (choice.ts sayJoined).
 */

/** What the voice remembers of the scene on screen: the scene and the names of its weather, none for clear. */
export type WeatherSeen = { sceneId: string; parts: readonly string[] };

export const seenOf = (sceneId: string, weather: SceneWeather | undefined): WeatherSeen => ({ sceneId, parts: weatherParts(weather) });

/**
 * The line for a change, or null. Arriving on a scene with weather says it,
 * and arriving on a clear scene from one with weather says it is clear. A
 * change of the wind's direction or of the roll rules changes no name, so it
 * says nothing.
 */
export function weatherSaid(before: WeatherSeen | null, after: WeatherSeen): string | null {
  const was = before?.parts.join(", ") ?? "";
  const now = after.parts.join(", ");
  const arrived = before === null || before.sceneId !== after.sceneId;
  if (!arrived && was === now) return null;
  if (now === "") return was === "" ? null : "The weather here is clear now.";
  return `Weather here: ${now}.`;
}

/** Says the weather of the scene on screen, from the Room page's view button, beside the view's own voice. */
export function useWeatherVoice(): void {
  const scope = useRoomScope();
  const sceneId = useRoomView((s) => s.sceneId);
  // A string, so a snapshot that changes nothing the voice names does not run the effect.
  const names = useRoomView((s) => {
    const scene = s.sceneId ? s.view?.scenes[s.sceneId] : undefined;
    return scene ? weatherParts(scene.weather).join("\n") : null;
  });
  const before = useRef<WeatherSeen | null>(null);
  useEffect(() => {
    // No scene yet, or none the viewer holds: nothing to say, and the next one is an arrival.
    if (sceneId === null || names === null) return;
    const now: WeatherSeen = { sceneId, parts: names === "" ? [] : names.split("\n") };
    const said = weatherSaid(before.current, now);
    before.current = now;
    if (said) sayJoined(scope, "weather", said);
  }, [scope, sceneId, names]);
}
