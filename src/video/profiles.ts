import type { VideoModel } from "./openrouter.js";

/**
* What Sonde has to know about a video model that OpenRouter's catalogue does
* not say: how its price list turns into dollars, and what to pass through to
* switch its watermark off. Everything else — durations, resolutions, frames,
* audio — is read from the catalogue at run time, so supporting another model
* is one entry here and no new code path.
*/
export interface VideoProfile {
  pricing:
    /** Billed per video token, where a token is 1024 pixels of one frame. */
    | { scheme: "tokens"; fps: number }
    /** Billed per second of output, in dollars. */
    | { scheme: "seconds" };
  /**
  * Passthrough options keyed by provider slug, each under `parameters` as
  * OpenRouter's video docs give it — a key outside that shape is silently
  * dropped. OpenRouter forwards only the entry for whichever provider it
  * routes to, so every slug that may serve the model is listed.
  */
  watermarkOff: Record<string, Record<string, unknown>>;
}

export const VIDEO_PROFILES: Record<string, VideoProfile> = {
  "bytedance/seedance-2.0-mini": {
    pricing: { scheme: "tokens", fps: 24 },
    watermarkOff: {
      seed: { parameters: { watermark: false } },
      byteplus: { parameters: { watermark: false } },
    },
  },
  "minimax/hailuo-3-max": {
    pricing: { scheme: "seconds" },
    watermarkOff: { minimax: { parameters: { aigc_watermark: false } } },
  },
};

/** A profile, or an error that says why a model without one is refused. */
export function requireProfile(
  modelId: string,
  profiles: Record<string, VideoProfile> = VIDEO_PROFILES,
): VideoProfile {
  const profile = profiles[modelId];
  if (!profile) {
    throw new Error(
      `${modelId} has no video profile, so Sonde cannot estimate what it costs and will not ` +
        `submit to it. Profiled models: ${Object.keys(profiles).join(", ")}.`,
    );
  }
  return profile;
}

export interface VideoSpecInput {
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  /** False for `--no-audio`; left undefined, audio is on wherever the model offers it. */
  audio?: boolean;
  seed?: number;
  lastFrame: boolean;
}

/** The parameters a run will send, settled against what the model offers. */
export interface VideoSpec {
  duration: number;
  resolution: string;
  aspectRatio?: string;
  /** Absent for a model with no audio to switch on or off. */
  generateAudio?: boolean;
  seed?: number;
}

/**
* Checks the request against the catalogue before anything is recorded or
* spent. A provider would refuse the same request, but only after a round
* trip, and some refuse by failing the job rather than the submission.
*/
export function planVideo(model: VideoModel, input: VideoSpecInput): VideoSpec {
  const offers = (flag: string, value: string | number, allowed: Array<string | number> | null) => {
    if (allowed && !allowed.includes(value)) {
      throw new Error(`${flag} ${value} is not offered by ${model.id}; it takes ${allowed.join(", ")}.`);
    }
  };
  const frames = model.supported_frame_images ?? [];
  if (!frames.includes("first_frame")) {
    throw new Error(`${model.id} cannot start a clip from an image.`);
  }
  if (input.lastFrame && !frames.includes("last_frame")) {
    throw new Error(`--last is not offered by ${model.id}; it takes a first frame only.`);
  }
  const duration = input.duration ?? 5;
  const resolution = input.resolution ?? "480p";
  offers("--duration", duration, model.supported_durations);
  offers("--resolution", resolution, model.supported_resolutions);
  if (input.aspectRatio !== undefined) {
    offers("--aspect", input.aspectRatio, model.supported_aspect_ratios);
  }
  if (input.seed !== undefined && model.seed !== true) {
    throw new Error(`--seed is not offered by ${model.id}.`);
  }
  return {
    duration,
    resolution,
    ...(input.aspectRatio !== undefined ? { aspectRatio: input.aspectRatio } : {}),
    ...(model.generate_audio === true ? { generateAudio: input.audio !== false } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

/**
* What the run should cost, worked out from the catalogue's price list.
*
* It errs high, never low, since it is the only gate the run has. With no
* aspect ratio named the model picks one from the first frame, and Sonde
* cannot know which, so a token-billed model is priced at the largest frame
* it offers at that resolution — 21:9 at 720p is a third more pixels than
* 16:9. An estimate Sonde cannot make is an error, not a zero.
*/
export function estimateUsd(model: VideoModel, profile: VideoProfile, spec: VideoSpec): number {
  const skus = model.pricing_skus;
  const price = (keys: string[]) => {
    for (const key of keys) {
      // A missing key reads as NaN, so one test covers absent and unparseable.
      const value = Number(skus[key]);
      if (Number.isFinite(value)) return value;
    }
    throw new Error(
      `${model.id} lists no price Sonde can read for ${spec.resolution} (looked for ${keys.join(", ")}).`,
    );
  };
  if (profile.pricing.scheme === "seconds") {
    const audio = spec.generateAudio
      ? [`duration_seconds_with_audio_${spec.resolution}`, "duration_seconds_with_audio"]
      : [];
    return price([...audio, `duration_seconds_${spec.resolution}`, "duration_seconds"]) * spec.duration;
  }
  const [width, height] = frameSize(model, spec);
  const tokens = (width * height * profile.pricing.fps * spec.duration) / 1024;
  const perToken = spec.generateAudio === false
    ? price(["video_tokens_without_audio", "video_tokens"])
    : price(["video_tokens"]);
  return tokens * perToken;
}

/** The pixel size a token-billed clip will be rendered at, or the largest it could be. */
function frameSize(model: VideoModel, spec: VideoSpec): [number, number] {
  const short = Number(/^(\d+)p$/.exec(spec.resolution)?.[1]);
  const sizes = (model.supported_sizes ?? [])
    .map((size) => size.split("x").map(Number) as [number, number])
    .filter(([w, h]) => Math.min(w, h) === short);
  const ratio = spec.aspectRatio?.split(":").map(Number);
  const candidates = ratio
    ? sizes.filter(([w, h]) => Math.abs(w / h - ratio[0]! / ratio[1]!) < 0.02)
    : sizes;
  const largest = candidates.sort((a, b) => b[0] * b[1] - a[0] * a[1])[0];
  if (!largest) {
    throw new Error(
      `${model.id} lists no frame size for ${spec.resolution}` +
        `${spec.aspectRatio ? ` at ${spec.aspectRatio}` : ""}, so its cost cannot be estimated.`,
    );
  }
  return largest;
}
