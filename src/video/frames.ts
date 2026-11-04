import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
* Turns `--first` or `--last` into something OpenRouter can fetch.
*
* OpenRouter documents frames as URLs and says nothing either way about data
* URIs, so a local file is sent only when the caller opts in. A data URI the
* API takes at submission but the provider rejects later may fail as a job,
* and whether a failed job is billed is not documented either.
*/
export function resolveFrame(
  value: string,
  frameType: "first_frame" | "last_frame",
  allowDataUri: boolean,
): ResolvedFrame {
  if (/^https?:\/\//i.test(value)) {
    return { url: value, source: { frameType, kind: "url", url: value } };
  }
  const flag = frameType === "first_frame" ? "--first" : "--last";
  if (!allowDataUri) {
    throw new Error(
      `${flag} ${value} is a local file, and OpenRouter is only documented to take frames as URLs. ` +
        "Host the image and pass its https URL, or add --allow-data-uri to send the file inline.",
    );
  }
  const type = MEDIA_TYPES[extname(value).toLowerCase()];
  if (!type) {
    throw new Error(`${flag} ${value} is not a PNG, JPEG or WebP image.`);
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
