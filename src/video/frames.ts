import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { VideoFrameSource } from "../types.js";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

/** A frame as it will be sent, and as it will be recorded. */
export interface ResolvedFrame {
  /** What goes in the request: the URL itself, or the file as a data URI. */
  url: string;
  source: VideoFrameSource;
}

/**
* Turns `--first` or `--last` into something OpenRouter can take.
*
* A URL is passed through; a local file is sent inline as a base64 data URI,
* which OpenRouter's openrouter-video skill documents for local frames. There
* is no upload endpoint, and no documented size limit beyond a 413 at
* submission — which refuses the request before any job exists.
*/
export function resolveFrame(value: string, frameType: "first_frame" | "last_frame"): ResolvedFrame {
  if (/^https?:\/\//i.test(value)) {
    return { url: value, source: { frameType, kind: "url", url: value } };
  }
  const flag = frameType === "first_frame" ? "--first" : "--last";
  const type = MEDIA_TYPES[extname(value).toLowerCase()];
  if (!type) {
    throw new Error(`${flag} ${value} is not a PNG, JPEG or WebP image, nor an http(s) URL.`);
  }
  if (!existsSync(value)) {
    throw new Error(`${flag} ${value} does not exist.`);
  }
  const bytes = readFileSync(value);
  return {
    url: `data:${type};base64,${bytes.toString("base64")}`,
    source: {
      frameType,
      kind: "file",
      path: value,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
