import { useEffect } from "react";

/**
 * Keeps the screen on while the room is open (design section 14.5), and
 * while a table display shows it (features/display). The browser drops the
 * lock whenever the page is hidden, so it is taken again each time the page
 * becomes visible.
 */
export function useWakeLock(): void {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || lock) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (stopped) void next.release();
        else {
          lock = next;
          next.addEventListener("release", () => {
            if (lock === next) lock = null;
          });
        }
      } catch {
        // Refused (low battery, no user gesture yet). The screen may dim.
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, []);
}
