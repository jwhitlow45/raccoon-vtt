import { Pill } from "../measure/Pill.tsx";

/**
 * The text the movement and door features draw on the board, in one place.
 * A drag's "Wall in the way" is a reading of the drag in progress, as a
 * ruler's distance is, so it keeps one size on screen at any zoom and is
 * never cut: a label centered over a world point, with a small pointer down
 * to it.
 */
export function BoardLabel(props: { x: number; y: number; scale: number; text: string; color: string }) {
  return <Pill x={props.x} y={props.y} scale={props.scale} value={props.text} size="screen" color={props.color} small above />;
}
