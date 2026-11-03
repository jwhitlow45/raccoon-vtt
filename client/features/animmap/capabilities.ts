import type { MapVideo } from "#shared/model.ts";
import type { Decodable } from "./playback.ts";

/**
 * Whether this browser can play a video map's file (docs/design/
 * design-v1-animated-maps.md 5.3 rule 2), asked of Media Capabilities, else
 * of `canPlayType`. The answer depends on the browser and the file alone,
 * so it is asked once per file and kind of question for the page.
 */

type Facts = Pick<MapVideo, "container" | "video" | "audio" | "widthPx" | "heightPx" | "fps" | "kbps" | "audioChannels" | "audioHz">;

/** The two ways a browser answers, so a test can stand in for either. */
export type CapabilityEnv = {
  decodingInfo?: (config: DecodingConfig) => Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }>;
  canPlayType?: (type: string) => string;
};

/** Media Capabilities' "file" configuration, the fields this asks with. */
export type DecodingConfig = {
  type: "file";
  video: { contentType: string; width: number; height: number; bitrate: number; framerate: number };
  audio?: { contentType: string; channels?: string; bitrate?: number; samplerate?: number };
};

/** A sound track's bitrate is not in the facts: a typical stereo rate, which no browser's answer turns on. */
const AUDIO_BITRATE = 128_000;

/**
 * The configuration for one file. Media Capabilities takes one codec per
 * track, so the video's type names the video codec alone and a file with
 * sound adds its own audio configuration (D-261102-451). `framerate` is the
 * peak rate the server measured.
 */
export function decodingConfig(video: Facts): DecodingConfig {
  const config: DecodingConfig = {
    type: "file",
    video: {
      contentType: `video/${video.container}; codecs="${video.video}"`,
      width: video.widthPx,
      height: video.heightPx,
      bitrate: Math.max(1, Math.round(video.kbps * 1000)),
      framerate: video.fps,
    },
  };
  if (video.audio) {
    config.audio = {
      contentType: `audio/${video.container}; codecs="${video.audio}"`,
      ...(video.audioChannels ? { channels: String(video.audioChannels) } : {}),
      bitrate: AUDIO_BITRATE,
      ...(video.audioHz ? { samplerate: video.audioHz } : {}),
    };
  }
  return config;
}

/** The multiplexed type `canPlayType` takes, both codecs in one string. */
export function playType(video: Pick<MapVideo, "container" | "video" | "audio">): string {
  return `video/${video.container}; codecs="${video.audio ? `${video.video},${video.audio}` : video.video}"`;
}

/** What the browser says, mapped to rule 2: unsupported is the format, and not smooth, or on Phone size not power-efficient, is the device. */
export async function askBrowser(video: Facts, powerEfficient: boolean, env: CapabilityEnv): Promise<Decodable> {
  if (env.decodingInfo) {
    try {
      const info = await env.decodingInfo(decodingConfig(video));
      if (!info.supported) return "codec";
      if (!info.smooth || (powerEfficient && !info.powerEfficient)) return "notSmooth";
      return "smooth";
    } catch {
      // A configuration this browser's API refuses as malformed: canPlayType still answers.
    }
  }
  if (env.canPlayType) {
    const answer = env.canPlayType(playType(video));
    return answer === "probably" || answer === "maybe" ? "smooth" : "codec";
  }
  return "codec";
}

function browserEnv(): CapabilityEnv {
  const env: CapabilityEnv = {};
  const caps = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { mediaCapabilities?: MediaCapabilities }).mediaCapabilities;
  if (caps && typeof caps.decodingInfo === "function") env.decodingInfo = (config) => caps.decodingInfo(config as MediaDecodingConfiguration);
  if (typeof document !== "undefined") {
    const probe = document.createElement("video");
    env.canPlayType = (type) => probe.canPlayType(type);
  }
  return env;
}

const asked = new Map<string, Promise<Decodable>>();

/** The browser's answer for a file, asked once a page for each file and each question. */
export function decodable(video: Facts, powerEfficient: boolean, env?: CapabilityEnv): Promise<Decodable> {
  const key = `${playType(video)}|${video.widthPx}x${video.heightPx}|${video.fps}|${video.kbps}|${video.audioChannels ?? ""}|${video.audioHz ?? ""}|${powerEfficient ? "efficient" : "any"}`;
  let answer = asked.get(key);
  if (!answer) {
    answer = askBrowser(video, powerEfficient, env ?? browserEnv());
    asked.set(key, answer);
  }
  return answer;
}

/** Forgets every answer, so a test can ask again. */
export function forgetCapabilitiesForTests(): void {
  asked.clear();
}
