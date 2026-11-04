import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, type Config } from "../config.js";
import { openDb } from "../store/db.js";
import { RunStore } from "../store/runs.js";
import type {
  StopReason,
  VideoEvent,
  VideoEventSink,
  VideoRecord,
  VideoResult,
} from "../types.js";
import { usd } from "../util/log.js";
import { resolveFrame } from "./frames.js";
import { jobError, VideoClient, type VideoJob } from "./openrouter.js";
import { estimateUsd, planVideo, requireProfile } from "./profiles.js";

interface VideoSeams {
  config?: Config;
  onEvent?: VideoEventSink;
  signal?: AbortSignal;
  /** Test seam for every request to OpenRouter. */
  fetch?: typeof fetch;
  /** Test seam: how long to wait between polls. */
  pollIntervalMs?: number;
}

export interface RunVideoOptions extends VideoSeams {
  direction: string;
  /** An https URL, or a local PNG, JPEG or WebP path sent inline. */
  first: string;
  last?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  /** False for `--no-audio`. */
  audio?: boolean;
  seed?: number;
  runId?: string;
}

export interface FetchVideoOptions extends VideoSeams {
  runId: string;
}

const POLL_INTERVAL_MS = 10_000;

/**
* One video run: settle the request against the catalogue, price it, submit
* it, and wait for the clip.
*
* Everything that can refuse the run happens before the run is recorded, since
* the spend cap is the only gate a video run has — once the job is submitted it
* runs to its end and is billed whether or not anyone is still waiting.
*/
export async function runVideo(options: RunVideoOptions): Promise<VideoResult> {
  const config = options.config ?? loadConfig();
  const direction = options.direction.trim();
  if (!direction) throw new Error("A direction is required.");
  const profile = requireProfile(config.videoModel);
  const frames = [
    resolveFrame(options.first, "first_frame"),
    ...(options.last ? [resolveFrame(options.last, "last_frame")] : []),
  ];
  const client = clientFor(config, options);
  const model = (await client.models(options.signal)).find((m) => m.id === config.videoModel);
  if (!model) {
    throw new Error(
      `${config.videoModel} is not in OpenRouter's video catalogue — check SONDE_VIDEO_MODEL with sonde doctor.`,
    );
  }
  const spec = planVideo(model, {
    duration: options.duration,
    resolution: options.resolution,
    aspectRatio: options.aspectRatio,
    audio: options.audio,
    seed: options.seed,
    lastFrame: frames.length > 1,
  });
  const estimate = estimateUsd(model, profile, spec);
  if (estimate > config.videoMaxUsd) {
    throw new Error(
      `this clip is estimated at ${usd(estimate)}, over the video spend cap of ${usd(config.videoMaxUsd)} ` +
        "(SONDE_VIDEO_MAX_USD). Shorten it, lower the resolution, or raise the cap.",
    );
  }

  const runId = options.runId ?? `run_${randomUUID().slice(0, 8)}`;
  const db = openDb(config.dbPath);
  const store = new RunStore(db);
  store.start(runId, direction, "video");
  const record: VideoRecord = {
    model: model.id,
    jobId: null,
    pollingUrl: null,
    request: spec,
    frames: frames.map((frame) => frame.source),
    estimateUsd: estimate,
    costUsd: null,
    status: null,
    clipPath: null,
  };
  store.saveVideo(runId, record);
  const run = new Collection(runId, direction, record, store, client, config, options);
  run.emit({ type: "video_start", runId, direction, model: model.id, estimateUsd: estimate });

  try {
    const job = await client.submit({
      model: model.id,
      prompt: direction,
      duration: spec.duration,
      resolution: spec.resolution,
      ...(spec.aspectRatio !== undefined ? { aspect_ratio: spec.aspectRatio } : {}),
      ...(spec.generateAudio !== undefined ? { generate_audio: spec.generateAudio } : {}),
      ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
      frame_images: frames.map((frame) => ({
        type: "image_url",
        image_url: { url: frame.url },
        frame_type: frame.source.frameType,
      })),
      provider: { options: profile.watermarkOff },
    }, options.signal);
    record.jobId = job.id;
    record.pollingUrl = job.polling_url;
    record.status = job.status;
    store.saveVideo(runId, record);
    run.emit({ type: "video_submitted", jobId: job.id });
  } catch (error) {
    // Nothing reached the provider, so nothing is owed and nothing is collectable.
    record.error = message(error);
    run.warn(`the job was not submitted: ${record.error}`);
    return run.finish("error", db);
  }
  return run.collect(db);
}

/**
* Collects the clip of a video run that stopped waiting. Safe to repeat: a
* clip already on disk is handed back without asking OpenRouter again, and a
* job that already failed stays failed.
*/
export async function fetchVideo(options: FetchVideoOptions): Promise<VideoResult> {
  const config = options.config ?? loadConfig();
  const db = openDb(config.dbPath);
  const store = new RunStore(db);
  const saved = store.video(options.runId);
  if (!saved) {
    db.close();
    throw new Error(`${options.runId} is not a video run — see sonde runs.`);
  }
  const { direction, record } = saved;
  const run = new Collection(options.runId, direction, record, store, clientFor(config, options), config, options);
  if (record.clipPath && existsSync(record.clipPath)) return run.finish("complete", db, false);
  if (!record.jobId) {
    db.close();
    throw new Error(`${options.runId} was never submitted, so there is no clip to collect.`);
  }
  if (record.status && FAILED.has(record.status)) return run.finish("error", db, false);
  return run.collect(db);
}

const FAILED = new Set(["failed", "cancelled", "expired"]);

/** The waiting half of a video run, shared by the first wait and every fetch after it. */
class Collection {
  private readonly warnings: string[] = [];

  constructor(
    private readonly runId: string,
    private readonly direction: string,
    private readonly record: VideoRecord,
    private readonly store: RunStore,
    private readonly client: VideoClient,
    private readonly config: Config,
    private readonly options: VideoSeams,
  ) {}

  emit(event: VideoEvent): void {
    if (event.type !== "video_end") this.store.event(this.runId, event.type, event);
    this.options.onEvent?.(event);
  }

  warn(text: string): void {
    this.warnings.push(text);
    this.emit({ type: "warning", message: text });
  }

  async collect(db: { close(): void }): Promise<VideoResult> {
    const record = this.record;
    const started = Date.now();
    const deadline = AbortSignal.timeout(this.config.videoMaxWaitMs);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, deadline]) : deadline;
    try {
      for (;;) {
        const job = await this.client.poll(record.pollingUrl!, signal);
        if (job.status !== record.status) {
          record.status = job.status;
          this.store.saveVideo(this.runId, record);
          this.emit({ type: "video_status", status: job.status, elapsedMs: Date.now() - started });
        }
        if (job.status === "completed") {
          await this.save(job, signal);
          return this.finish("complete", db);
        }
        if (FAILED.has(job.status)) {
          record.error = jobError(job);
          record.costUsd = job.usage?.cost ?? null;
          this.warn(
            `the job ${job.status}: ${record.error}` +
              (record.costUsd === null ? "" : ` — OpenRouter charged ${usd(record.costUsd)} for it`),
          );
          return this.finish("error", db);
        }
        await delay(this.options.pollIntervalMs ?? POLL_INTERVAL_MS, undefined, { signal });
      }
    } catch (error) {
      const later = `the job keeps running and is still billed; collect it with: sonde video fetch ${this.runId}`;
      if (this.options.signal?.aborted) {
        this.warn(`stopped waiting when interrupted — ${later}`);
        return this.finish("max_wall_ms", db);
      }
      if (deadline.aborted) {
        this.warn(`no clip after ${Math.round(this.config.videoMaxWaitMs / 1000)}s (SONDE_VIDEO_MAX_WAIT_MS) — ${later}`);
        return this.finish("max_wall_ms", db);
      }
      record.error = message(error);
      this.warn(`could not collect the clip: ${record.error} — the job may still finish; try: sonde video fetch ${this.runId}`);
      return this.finish("error", db);
    }
  }

  finish(stoppedBy: StopReason, db: { close(): void }, persist = true): VideoResult {
    if (persist) this.store.saveVideo(this.runId, this.record, stoppedBy);
    const result: VideoResult = {
      runId: this.runId,
      direction: this.direction,
      record: this.record,
      stoppedBy,
      warnings: this.warnings,
    };
    this.emit({ type: "video_end", result });
    db.close();
    return result;
  }

  private async save(job: VideoJob, signal: AbortSignal): Promise<void> {
    const record = this.record;
    record.costUsd = job.usage?.cost ?? null;
    if (record.costUsd === null) {
      this.warn(`OpenRouter reported no cost for this job; it was estimated at ${usd(record.estimateUsd)}`);
    }
    const clip = await this.client.download(job, signal);
    const path = join(this.config.videoDir, `${this.runId}${extensionFor(clip.contentType)}`);
    mkdirSync(this.config.videoDir, { recursive: true });
    writeFileSync(path, clip.bytes);
    record.clipPath = path;
  }
}

function clientFor(config: Config, seams: VideoSeams): VideoClient {
  return new VideoClient({
    apiKey: config.openrouterApiKey,
    appUrl: config.appUrl,
    appTitle: config.appTitle,
    fetch: seams.fetch,
  });
}

function extensionFor(contentType: string): string {
  if (contentType.includes("webm")) return ".webm";
  if (contentType.includes("quicktime")) return ".mov";
  return ".mp4";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
