import type { VideoJobStatus } from "../types.js";

const API = "https://openrouter.ai/api/v1";
export const VIDEO_MODELS_URL = `${API}/videos/models`;

/**
* One entry of OpenRouter's video catalogue, trimmed to what Sonde reads. The
* catalogue, not Sonde, is the authority on what a model accepts: it is what
* lets one client serve every model without a branch per provider.
*/
export interface VideoModel {
  id: string;
  supported_resolutions: string[] | null;
  supported_aspect_ratios: string[] | null;
  supported_sizes: string[] | null;
  supported_durations: number[] | null;
  supported_frame_images: Array<"first_frame" | "last_frame"> | null;
  /** True when the model can add sound; false or null when it cannot. */
  generate_audio: boolean | null;
  seed: boolean | null;
  pricing_skus: Record<string, string>;
  allowed_passthrough_parameters: string[];
}

export interface VideoJob {
  id: string;
  polling_url: string;
  status: VideoJobStatus;
  generation_id?: string;
  unsigned_urls?: string[];
  usage?: { cost?: number | null };
  error?: string | { message?: string };
}

export interface VideoClientOptions {
  apiKey: string;
  appUrl: string;
  appTitle: string;
  /** Test seam: every request this client makes goes through it. */
  fetch?: typeof fetch;
}

/**
* The four calls a video run makes. Generation is asynchronous on
* OpenRouter's side — submit returns at once with a job id and the clip is
* collected later — so none of these wait for a video to exist.
*/
export class VideoClient {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: VideoClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async models(signal?: AbortSignal): Promise<VideoModel[]> {
    const res = await this.fetch(VIDEO_MODELS_URL, { signal });
    if (!res.ok) throw new Error(`could not fetch ${VIDEO_MODELS_URL}: HTTP ${res.status}`);
    return ((await res.json()) as { data?: VideoModel[] }).data ?? [];
  }

  async submit(body: Record<string, unknown>, signal?: AbortSignal): Promise<VideoJob> {
    const res = await this.fetch(`${API}/videos`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`OpenRouter refused the job: ${await errorText(res)}`);
    return (await res.json()) as VideoJob;
  }

  async poll(pollingUrl: string, signal?: AbortSignal): Promise<VideoJob> {
    const res = await this.fetch(new URL(pollingUrl, "https://openrouter.ai").href, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(`could not poll the job: ${await errorText(res)}`);
    return (await res.json()) as VideoJob;
  }

  /** The finished clip's bytes and media type. */
  async download(job: VideoJob, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = job.unsigned_urls?.[0] ?? `${API}/videos/${job.id}/content?index=0`;
    // The key goes to OpenRouter and nowhere else, whatever host a job names.
    const ownHost = new URL(url).hostname === "openrouter.ai";
    const res = await this.fetch(url, { headers: ownHost ? this.headers() : {}, signal });
    if (!res.ok) throw new Error(`could not download the clip: ${await errorText(res)}`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "video/mp4",
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      "HTTP-Referer": this.options.appUrl,
      "X-Title": this.options.appTitle,
    };
  }
}

/** A job's error as one line, whichever shape the provider gave it. */
export function jobError(job: VideoJob): string {
  if (typeof job.error === "string") return job.error;
  return job.error?.message ?? `job ended ${job.status}`;
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return `HTTP ${res.status} — ${body.error?.message ?? "no message"}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
