import type Konva from "konva";
import { useEffect, useRef } from "react";
import { Group } from "react-konva";
import type { LayerProps } from "../layers.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { currentFocus, focusEvent, focusFromStage, publishFocus } from "./camera.ts";
import { sendsView, useShowView, viewEvent } from "./tableDisplay.ts";

/** At most this often while the DM pans with "Follow me" on: smooth enough to follow, light on the players' phones. */
const FOLLOW_MS = 120;

/**
 * Draws nothing. It sits in the canvas only because that is where the
 * camera is: the stage re-renders its layers on every camera change, and
 * this reads the stage's position then. On a DM's device it publishes the
 * camera for "Bring everyone here", and while "Follow me" is on it sends
 * the camera to the players, throttled, plus once more whenever someone
 * comes online, so a player who joins mid-scene catches up.
 *
 * With "Show my view on the table display" on, it also sends the area it
 * shows to table displays (docs/design-v1-dm-tools.md 3.1), as often as
 * Follow me does, once more when another display connects, and never at
 * rest. Only while this device views the players' scene, so a TV never
 * moves to a scene they cannot see.
 */
export function CameraLayer(props: LayerProps) {
  const groupRef = useRef<Konva.Group>(null);
  const actions = useRoomActions();
  const scope = useRoomScope();
  const follow = useRoomView((s) => s.view?.meta.view.follow === true);
  const online = useRoomView((s) => s.online);
  const dm = props.role === "dm";
  const sceneId = props.scene.id;
  const lastSentRef = useRef(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomId = useRoomView((s) => s.roomId);
  const showView = useShowView(roomId);
  const playerSceneId = useRoomView((s) => s.view?.meta.playerSceneId ?? null);
  const displays = useRoomView((s) => s.displays ?? 0);
  const blackout = useRoomView((s) => s.view?.meta.view.blackout === true);
  // With no display connected there is no one to send to.
  const toDisplays = sendsView({ dm, on: showView, sceneId, playerSceneId, blackout }) && displays > 0;
  const viewSentRef = useRef(Number.NEGATIVE_INFINITY);
  const viewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The area sent last, so a render that moved nothing sends nothing. */
  const lastViewRef = useRef("");

  const sendView = (again = false) => {
    const stage = groupRef.current?.getStage();
    if (!stage) return;
    const e = viewEvent({ x: stage.x(), y: stage.y(), scale: stage.scaleX(), width: stage.width(), height: stage.height() });
    const sent = `${e.x},${e.y},${e.w},${e.h}`;
    if (!again && sent === lastViewRef.current) return;
    lastViewRef.current = sent;
    viewSentRef.current = performance.now();
    actions.sendEph(e);
  };

  const send = () => {
    const f = currentFocus(scope);
    if (f && f.sceneId === sceneId) actions.sendEph(focusEvent(f));
    lastSentRef.current = performance.now();
  };

  // Every render follows a camera or size change, so read the stage each time.
  useEffect(() => {
    if (!dm) return;
    const stage = groupRef.current?.getStage();
    if (!stage) return;
    publishFocus(scope, { sceneId, ...focusFromStage({ x: stage.x(), y: stage.y(), scale: stage.scaleX(), width: stage.width(), height: stage.height() }) });
    if (toDisplays) {
      const viewWait = FOLLOW_MS - (performance.now() - viewSentRef.current);
      if (viewWait <= 0) sendView();
      else viewTimerRef.current ??= setTimeout(() => {
        viewTimerRef.current = null;
        sendView();
      }, viewWait);
    }
    if (!follow) return;
    const wait = FOLLOW_MS - (performance.now() - lastSentRef.current);
    if (wait <= 0) send();
    else timerRef.current ??= setTimeout(() => {
      timerRef.current = null;
      send();
    }, wait);
  });

  // `send` reads the latest focus when it runs, so it is not a dependency.
  useEffect(() => {
    if (dm && follow) send();
    else if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [dm, follow, online, sceneId]);

  // Once when the switch goes on, this device comes to the players' scene or a pause ends, and once more when another display connects.
  useEffect(() => {
    if (toDisplays) sendView(true);
    else if (viewTimerRef.current) {
      clearTimeout(viewTimerRef.current);
      viewTimerRef.current = null;
    }
    // `sendView` reads the stage when it runs, so it is not a dependency.
  }, [toDisplays, displays]);

  useEffect(
    () => () => {
      if (viewTimerRef.current) clearTimeout(viewTimerRef.current);
      viewTimerRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (currentFocus(scope)?.sceneId === sceneId) publishFocus(scope, null);
    },
    [scope, sceneId],
  );

  return <Group ref={groupRef} listening={false} />;
}
