import { describe, expect, test } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/store/db.js";
import type { VideoEvent } from "../src/types.js";
import type { VideoJob, VideoModel } from "../src/video/openrouter.js";
import {
  estimateUsd,
  planVideo,
  requireProfile,
  type VideoProfile,
} from "../src/video/profiles.js";
import { fetchVideo, runVideo } from "../src/video/video-run.js";
import { testConfig } from "./helpers/mock.js";

/** Seedance 2.0 Mini as OpenRouter's video catalogue listed it in November 2026. */
const MINI: VideoModel = {
  id: "bytedance/seedance-2.0-mini",
  supported_resolutions: ["480p", "720p"],
  supported_aspect_ratios: ["1:1", "3:4", "9:16", "4:3", "16:9", "21:9", "9:21"],
  supported_sizes: [
    "480x480", "480x640", "480x854", "640x480", "854x480", "1120x480",
    "720x720", "720x960", "720x1280", "720x1680", "960x720", "1280x720", "1680x720",
  ],
  supported_durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  supported_frame_images: ["first_frame", "last_frame"],
  generate_audio: true,
  seed: true,
  pricing_skus: {
    video_tokens: "0.0000035",
    video_tokens_without_audio: "0.0000035",
    video_tokens_with_video_input: "0.0000021",
  },
  allowed_passthrough_parameters: ["watermark", "req_key", "return_last_frame"],
};

/** MiniMax H3 Max as the catalogue listed it in November 2026: per-second, no audio, no seed. */
const H3_MAX: VideoModel = {
  id: "minimax/hailuo-3-max",
  supported_resolutions: ["768p", "480p"],
  supported_aspect_ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
  supported_sizes: null,
  supported_durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  supported_frame_images: ["first_frame", "last_frame"],
  generate_audio: false,
  seed: false,
  pricing_skus: { duration_seconds: "0.08", duration_seconds_480p: "0.05", duration_seconds_768p: "0.08" },
  allowed_passthrough_parameters: ["aigc_watermark"],
};

/** A model that can open a clip on an image but not end on one. */
const FIRST_ONLY: VideoModel = { ...H3_MAX, id: "example/first-only", supported_frame_images: ["first_frame"] };

const PER_SECOND: VideoProfile = { pricing: { scheme: "seconds" }, watermarkOff: {} };
const MINI_PROFILE = requireProfile(MINI.id);
const IMAGE = "https://images.example/room.png";

function databasePath() {
  return join(mkdtempSync(join(tmpdir(), "sonde-video-")), "sonde.db");
}

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
* OpenRouter's video API, scripted: the catalogue, one submission, and a
* sequence of job states — the last one repeats for as long as it is polled.
*/
function fakeOpenRouter(options: {
  jobs?: Array<Partial<VideoJob>>;
  submit?: Response;
  clip?: { bytes: string; contentType: string };
} = {}) {
  const calls: Call[] = [];
  const jobs = options.jobs ?? [{ status: "completed", usage: { cost: 0.17 } }];
  let polled = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (url.endsWith("/videos/models")) return Response.json({ data: [MINI, H3_MAX] });
    if (url.endsWith("/videos") && init?.method === "POST") {
      return options.submit ?? Response.json(
        { id: "job-1", polling_url: "/api/v1/videos/job-1", status: "pending" },
        { status: 202 },
      );
    }
    if (url.endsWith("/videos/job-1")) {
      const job = jobs[Math.min(polled, jobs.length - 1)]!;
      polled += 1;
      return Response.json({ id: "job-1", polling_url: "/api/v1/videos/job-1", ...job });
    }
    const clip = options.clip ?? { bytes: "fake-mp4", contentType: "video/mp4" };
    return new Response(clip.bytes, { headers: { "content-type": clip.contentType } });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function runRow(dbPath: string, runId: string) {
  const db = openDb(dbPath);
  const row = db.prepare("SELECT kind, stopped_by, usd, report_json FROM runs WHERE id = ?").get(runId) as
    | { kind: string; stopped_by: string | null; usd: number | null; report_json: string }
    | undefined;
  db.close();
  return row;
}

describe("video cost estimate", () => {
  test("prices a token-billed model at the largest frame it offers when no aspect is named", () => {
    const spec = planVideo(MINI, { lastFrame: false });
    // 1120x480 (21:9) is the largest 480p frame: 1120·480·24·5 / 1024 tokens.
    expect(estimateUsd(MINI, MINI_PROFILE, spec)).toBeCloseTo((1120 * 480 * 24 * 5 / 1024) * 0.0000035, 6);
  });

  test("prices the named aspect ratio's frame when there is one", () => {
    const spec = planVideo(MINI, { aspectRatio: "16:9", resolution: "720p", duration: 8, lastFrame: false });
    expect(estimateUsd(MINI, MINI_PROFILE, spec)).toBeCloseTo((1280 * 720 * 24 * 8 / 1024) * 0.0000035, 6);
  });

  test("prices a per-second model from its resolution's rate", () => {
    const spec = planVideo(H3_MAX, { resolution: "768p", duration: 6, lastFrame: false });
    expect(estimateUsd(H3_MAX, PER_SECOND, spec)).toBeCloseTo(0.48, 6);
  });

  test("refuses to guess a price the list does not hold", () => {
    const unpriced = { ...H3_MAX, pricing_skus: { duration_seconds_480p: "0.05" } };
    const spec = planVideo(unpriced, { resolution: "768p", lastFrame: false });
    expect(() => estimateUsd(unpriced, PER_SECOND, spec)).toThrow(/no price/);
  });

  test("refuses a model with no profile", () => {
    expect(() => requireProfile("minimax/hailuo-2.3")).toThrow(/no video profile/);
  });
});

describe("video request against the catalogue", () => {
  test("defaults to five seconds at 480p, audio on where the model has it", () => {
    expect(planVideo(MINI, { lastFrame: false })).toEqual({ duration: 5, resolution: "480p", generateAudio: true });
    expect(planVideo(MINI, { audio: false, lastFrame: false }).generateAudio).toBe(false);
    expect(planVideo(H3_MAX, { lastFrame: false })).not.toHaveProperty("generateAudio");
  });

  test("names what the model takes instead of a request it does not", () => {
    expect(() => planVideo(MINI, { duration: 3, lastFrame: false })).toThrow("--duration 3 is not offered by bytedance/seedance-2.0-mini; it takes 4, 5");
    expect(() => planVideo(MINI, { resolution: "1080p", lastFrame: false })).toThrow(/--resolution 1080p/);
    expect(() => planVideo(FIRST_ONLY, { lastFrame: true })).toThrow(/--last is not offered/);
    expect(() => planVideo(H3_MAX, { seed: 7, lastFrame: false })).toThrow(/--seed is not offered/);
  });
});

describe("video run", () => {
  test("submits, waits, saves the clip and records what it cost", async () => {
    const config = testConfig(databasePath());
    const api = fakeOpenRouter({
      jobs: [{ status: "in_progress" }, { status: "completed", usage: { cost: 0.17 } }],
    });
    const events: VideoEvent[] = [];
    const result = await runVideo({
      direction: "the lamp flickers", first: IMAGE, config,
      fetch: api.fetch, pollIntervalMs: 1, runId: "run_ok",
      onEvent: (event) => events.push(event),
    });

    expect(result.stoppedBy).toBe("complete");
    expect(result.record.clipPath).toBe(join(config.videoDir, "run_ok.mp4"));
    expect(readFileSync(result.record.clipPath!, "utf8")).toBe("fake-mp4");
    const submitted = api.calls.find((call) => call.method === "POST")!.body!;
    expect(submitted).toEqual({
      model: MINI.id,
      prompt: "the lamp flickers",
      duration: 5,
      resolution: "480p",
      generate_audio: true,
      frame_images: [{ type: "image_url", image_url: { url: IMAGE }, frame_type: "first_frame" }],
      provider: {
        options: {
          seed: { parameters: { watermark: false } },
          byteplus: { parameters: { watermark: false } },
        },
      },
    });
    expect(events.filter((e) => e.type === "video_status").map((e) => e.type === "video_status" && e.status))
      .toEqual(["in_progress", "completed"]);
    const download = api.calls.at(-1)!;
    expect(download.url).toBe("https://openrouter.ai/api/v1/videos/job-1/content?index=0");
    expect(download.headers["Authorization"]).toBe("Bearer sk-or-test");
    expect(runRow(config.dbPath, "run_ok")).toEqual(
      expect.objectContaining({ kind: "video", stopped_by: "complete", usd: 0.17 }),
    );
  });

  test("--model picks H3 Max over the configured model: no audio field, its own watermark switch and a per-second estimate", async () => {
    const config = testConfig(databasePath());
    const api = fakeOpenRouter({ jobs: [{ status: "completed", usage: { cost: 0.25 } }] });
    const result = await runVideo({
      direction: "x", first: IMAGE, last: IMAGE, model: H3_MAX.id, config, fetch: api.fetch, pollIntervalMs: 1,
    });
    expect(config.videoModel).toBe(MINI.id);
    expect(result.record.estimateUsd).toBeCloseTo(0.25, 6);
    expect(api.calls.find((call) => call.method === "POST")!.body).toEqual({
      model: H3_MAX.id,
      prompt: "x",
      duration: 5,
      resolution: "480p",
      frame_images: [
        { type: "image_url", image_url: { url: IMAGE }, frame_type: "first_frame" },
        { type: "image_url", image_url: { url: IMAGE }, frame_type: "last_frame" },
      ],
      provider: { options: { minimax: { parameters: { aigc_watermark: false } } } },
    });
  });

  test("refuses a --model with no profile before calling OpenRouter", async () => {
    const config = testConfig(databasePath());
    const api = fakeOpenRouter();
    await expect(
      runVideo({ direction: "x", first: IMAGE, model: "minimax/hailuo-2.3", config, fetch: api.fetch }),
    ).rejects.toThrow(/minimax\/hailuo-2.3 has no video profile/);
    expect(api.calls).toHaveLength(0);
  });

  test("never sends the key to a download host other than OpenRouter", async () => {
    const config = testConfig(databasePath());
    const api = fakeOpenRouter({
      jobs: [{ status: "completed", usage: { cost: 0.17 }, unsigned_urls: ["https://cdn.example/clip.webm"] }],
      clip: { bytes: "fake-webm", contentType: "video/webm" },
    });
    const result = await runVideo({ direction: "x", first: IMAGE, config, fetch: api.fetch, pollIntervalMs: 1 });
    expect(api.calls.at(-1)).toEqual(expect.objectContaining({ url: "https://cdn.example/clip.webm", headers: {} }));
    expect(result.record.clipPath).toMatch(/\.webm$/);
  });

  test("refuses a clip estimated over the spend cap before anything is recorded or submitted", async () => {
    const config = { ...testConfig(databasePath()), videoMaxUsd: 0.1 };
    const api = fakeOpenRouter();
    await expect(
      runVideo({ direction: "x", first: IMAGE, config, fetch: api.fetch, runId: "run_cap" }),
    ).rejects.toThrow(/over the video spend cap/);
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    expect(runRow(config.dbPath, "run_cap")).toBeUndefined();
  });

  test("sends a local frame inline and records it by path and hash, never its bytes", async () => {
    const config = testConfig(databasePath());
    const image = join(mkdtempSync(join(tmpdir(), "sonde-frame-")), "first.png");
    writeFileSync(image, "png-bytes");
    const api = fakeOpenRouter();
    const result = await runVideo({ direction: "x", first: image, config, fetch: api.fetch, pollIntervalMs: 1 });
    const frame = (api.calls.find((call) => call.method === "POST")!.body!["frame_images"] as Array<{ image_url: { url: string } }>)[0]!;
    expect(frame.image_url.url).toBe(`data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`);
    expect(result.record.frames[0]).toEqual({
      frameType: "first_frame", kind: "file", path: image,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(runRow(config.dbPath, result.runId)!.report_json).not.toContain("base64");
  });

  test("refuses a local frame that is missing or not an image before calling OpenRouter", async () => {
    const config = testConfig(databasePath());
    const dir = mkdtempSync(join(tmpdir(), "sonde-frame-"));
    const api = fakeOpenRouter();
    await expect(
      runVideo({ direction: "x", first: join(dir, "missing.png"), config, fetch: api.fetch }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      runVideo({ direction: "x", first: join(dir, "notes.txt"), config, fetch: api.fetch }),
    ).rejects.toThrow(/not a PNG, JPEG or WebP/);
    expect(api.calls).toHaveLength(0);
  });

  test("reports a failed job with the provider's reason and does not retry it", async () => {
    const config = testConfig(databasePath());
    const api = fakeOpenRouter({ jobs: [{ status: "failed", error: "Content policy violation", usage: { cost: 0 } }] });
    const result = await runVideo({ direction: "x", first: IMAGE, config, fetch: api.fetch, pollIntervalMs: 1, runId: "run_bad" });

    expect(result.stoppedBy).toBe("error");
    expect(result.warnings.at(-1)).toMatch(/failed: Content policy violation/);
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    const again = fakeOpenRouter();
    expect((await fetchVideo({ runId: "run_bad", config, fetch: again.fetch })).stoppedBy).toBe("error");
    expect(again.calls).toHaveLength(0);
  });

  test("a refused submission owes nothing and leaves nothing to fetch", async () => {
    const config = testConfig(databasePath());
    const api = fakeOpenRouter({
      submit: Response.json({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 }),
    });
    const result = await runVideo({ direction: "x", first: IMAGE, config, fetch: api.fetch, runId: "run_402" });
    expect(result).toEqual(expect.objectContaining({ stoppedBy: "error" }));
    expect(result.record.jobId).toBeNull();
    expect(result.warnings.at(-1)).toMatch(/not submitted: .*402.*Insufficient credits/);
    await expect(fetchVideo({ runId: "run_402", config, fetch: api.fetch })).rejects.toThrow(/never submitted/);
  });

  test("a provider refusal passed through by OpenRouter reads as the provider's code and message", async () => {
    const config = testConfig(databasePath());
    const upstream = JSON.stringify({
      error: { code: "InputImageSensitiveContentDetected", message: "The input image may contain sensitive information.", type: "BadRequest" },
    });
    const api = fakeOpenRouter({
      submit: Response.json({ error: { code: 400, message: `HTTP 400: ${upstream}` } }, { status: 400 }),
    });
    const result = await runVideo({ direction: "x", first: IMAGE, config, fetch: api.fetch });
    expect(result.warnings.at(-1)).toBe(
      "the job was not submitted: OpenRouter refused the job: HTTP 400 — " +
        "InputImageSensitiveContentDetected: The input image may contain sensitive information.",
    );
  });
});

describe("collecting a clip later", () => {
  test("running out of wait keeps the job id, and fetch collects the clip exactly once", async () => {
    const config = { ...testConfig(databasePath()), videoMaxWaitMs: 30 };
    const waiting = fakeOpenRouter({ jobs: [{ status: "in_progress" }] });
    const first = await runVideo({
      direction: "x", first: IMAGE, config, fetch: waiting.fetch, pollIntervalMs: 5, runId: "run_slow",
    });
    expect(first.stoppedBy).toBe("max_wall_ms");
    expect(first.record.jobId).toBe("job-1");
    expect(first.warnings.at(-1)).toMatch(/sonde video fetch run_slow/);
    expect(runRow(config.dbPath, "run_slow")!.stopped_by).toBe("max_wall_ms");

    const done = fakeOpenRouter({ jobs: [{ status: "completed", usage: { cost: 0.22 } }] });
    const fetched = await fetchVideo({ runId: "run_slow", config, fetch: done.fetch, pollIntervalMs: 1 });
    expect(fetched.stoppedBy).toBe("complete");
    expect(existsSync(fetched.record.clipPath!)).toBe(true);
    expect(runRow(config.dbPath, "run_slow")).toEqual(expect.objectContaining({ stopped_by: "complete", usd: 0.22 }));

    const repeat = fakeOpenRouter();
    expect((await fetchVideo({ runId: "run_slow", config, fetch: repeat.fetch })).record.clipPath).toBe(fetched.record.clipPath);
    expect(repeat.calls).toHaveLength(0);
  });

  test("an interrupt stops the waiting, not the job", async () => {
    const config = testConfig(databasePath());
    const controller = new AbortController();
    const api = fakeOpenRouter({ jobs: [{ status: "in_progress" }] });
    const result = await runVideo({
      direction: "x", first: IMAGE, config, fetch: api.fetch, pollIntervalMs: 50,
      signal: controller.signal,
      onEvent: (event) => { if (event.type === "video_status") controller.abort(); },
    });
    expect(result.stoppedBy).toBe("max_wall_ms");
    expect(result.warnings.at(-1)).toMatch(/interrupted .* sonde video fetch/);
  });

  test("fetch refuses a run id that is not a video run", async () => {
    const config = testConfig(databasePath());
    await expect(fetchVideo({ runId: "run_none", config })).rejects.toThrow(/not a video run/);
  });
});
