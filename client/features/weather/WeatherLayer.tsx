import type Konva from "konva";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Layer, Shape } from "react-konva";
import { useStore } from "zustand";
import { useTreeShown } from "../../canvas/relief/context.ts";
import { cameraOfStage } from "../../lib/camera.ts";
import { drawWeather, sceneClip, type DrawProbe } from "./draw.ts";
import { createField, resizeField, setFieldLook, setFieldView, setHalf, stepField, tileFits, type Field } from "./sim.ts";
import { WeatherTextures } from "./textures.ts";
import type { WeatherLayerProps } from "./WeatherController.tsx";

/**
 * The test hooks on the weather's canvas (docs/design/design-v1-weather.md
 * 12, e2e and the bench): ticks, camera draws, the step-down's level and
 * what a tick adds to its frame, as plain properties, so nothing writes an
 * attribute 30 times a second.
 * `data-weather` is set only on a change.
 */
export type WeatherCanvas = HTMLCanvasElement & {
  weatherTicks?: number;
  weatherCameraDraws?: number;
  weatherLevel?: string;
  weatherFrameCost?: number;
  /** Under WEATHER_TEST_FLAG only: the last draw's camera, the scene's outline on screen it clipped to, and up to 64 of its marks seen, each the center before sway and the drawn center (draw.ts DrawProbe). */
  weatherSpots?: { camera: [number, number, number]; clip: number[]; spots: Record<string, [number, number, number, number]> };
  /** Under WEATHER_TEST_FLAG only: the last draw's marks seen, each by the alpha it draws at. */
  weatherMarks?: number;
};

/**
 * The weather's own e2e flag, apart from Isometric's (ISO_TEST_FLAG), which
 * the bench sets: the probe costs a key string a mark, so the bench must
 * never pay for it.
 */
export const WEATHER_TEST_FLAG = "__rvttWeatherTest";

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * One weather layer (5.2): a non-listening Konva layer at 1 device pixel a
 * CSS pixel, holding one shape whose sceneFunc draws the room's field as it
 * stands. Only the room's clock steps the field, through this layer's tick,
 * which draws at once in the same frame. Any other run of the sceneFunc is
 * a camera draw (a pan, a zoom, a mount), which reads the stage's camera
 * and moves nothing.
 *
 * It registers with the clock only while its tree shows, so a hidden
 * tree's layer never ticks.
 */
export default function WeatherLayer(props: WeatherLayerProps) {
  const { room } = props;
  const key = useStore(room.state, (s) => s.key);
  const toward = useStore(room.state, (s) => s.toward);
  const level = useStore(room.state, (s) => s.level);
  const shown = useTreeShown();
  const layerRef = useRef<Konva.Layer>(null);
  // The sceneFunc and the tick read the newest props without being made anew, so the shape's props never change and react-konva never draws it for a render.
  const live = useRef(props);
  live.current = props;

  /** The room's field for this layer's look, view and size, made or brought up to date. */
  const fieldNow = useCallback(
    (stage: Konva.Stage | null): Field | null => {
      const look = room.look;
      if (!look) return null;
      const { view, width, height } = live.current;
      let field = room.field;
      // A screen whose wrap box outgrows the tile, or shrinks under half of it, gets a field with a tile of its own: the weather reshuffles once.
      if (!field || field.look.key !== look.key || !tileFits(field.tile, width, height)) {
        field = createField(look, { width, height, view, half: room.mode.half });
        room.field = field;
      } else if (field.look !== look) setFieldLook(field, look);
      if (field.view !== view) setFieldView(field, view);
      if (field.width !== width || field.height !== height) resizeField(field, width, height);
      if (field.half !== room.mode.half) setHalf(field, room.mode.half);
      return field;
    },
    [room],
  );

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    // The stage's other layers stay at their ratio. A 3x phone draws one ninth of its pixels here (5.2).
    layer.getCanvas().setPixelRatio(1);
    const canvas = layer.getCanvas()._canvas;
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.pointerEvents = "none";
    room.textures ??= new WeatherTextures(makeCanvas);
  }, [room]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const canvas = layer.getCanvas()._canvas;
    if (key) canvas.dataset.weather = key;
    else delete canvas.dataset.weather;
    // A new look, a turned wind, a view or a size draws once, as a camera draw: the field holds still until a tick, and a layer held still draws no tick at all.
    layer.batchDraw();
  }, [key, toward, props.view, props.width, props.height]);

  useLayoutEffect(() => {
    // From the room, since a layer held still draws no more ticks to say so.
    const canvas = layerRef.current?.getCanvas()._canvas as WeatherCanvas | undefined;
    if (canvas) canvas.weatherLevel = level;
  }, [level]);

  useEffect(() => {
    if (!shown) return;
    return room.register({
      tick(ms) {
        const layer = layerRef.current;
        const stage = layer?.getStage() ?? null;
        const field = fieldNow(stage);
        if (!layer || !stage || !field) return;
        // The tick reads the camera its stage holds now, so marks keep their screen speed at any zoom. It subscribes to none.
        stepField(field, ms, cameraOfStage(stage));
        // At once, in this frame: batchDraw would wait a frame and gate a 60 Hz clock down to 20 (5.2).
        layer.draw();
      },
    });
  }, [room, shown, fieldNow]);

  const sceneFunc = useCallback(
    (ctx: Konva.Context, shape: Konva.Shape) => {
      const stage = shape.getStage();
      const layer = layerRef.current;
      if (!stage || !layer) return;
      const field = fieldNow(stage);
      if (!field) return;
      const start = performance.now();
      const camera = cameraOfStage(stage);
      const g = ctx._context;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      const probe: DrawProbe | undefined = (globalThis as Record<string, unknown>)[WEATHER_TEST_FLAG] === true ? { spots: {}, limit: 64, marks: 0 } : undefined;
      const held = room.mode.effective !== "moving";
      const clip = sceneClip(live.current.view, live.current.bounds, camera);
      drawWeather(g, field, { camera, clip, held, probe }, room.textures);
      g.restore();
      const ms = performance.now() - start;
      room.mode.drew(ms);
      const canvas = layer.getCanvas()._canvas as WeatherCanvas;
      canvas.weatherTicks = room.mode.ticks;
      canvas.weatherCameraDraws = room.mode.cameraDraws;
      canvas.weatherFrameCost = room.frameCost;
      if (probe) {
        canvas.weatherSpots = { camera: [camera.x, camera.y, camera.scale], clip: [...clip], spots: probe.spots };
        canvas.weatherMarks = probe.marks;
      }
    },
    [room, fieldNow],
  );

  return (
    <Layer ref={layerRef} listening={false}>
      <Shape sceneFunc={sceneFunc} listening={false} perfectDrawEnabled={false} />
    </Layer>
  );
}
