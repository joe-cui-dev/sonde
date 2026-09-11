import { describe, expect, test } from "@jest/globals";

import { ReportPreviewRenderer, type PreviewClock } from "../src/cli-preview.js";
import { WritingPreviewRenderer } from "../src/writing-preview.js";

function output(tty = true) {
  let text = "";
  return {
    isTTY: tty,
    write(chunk: string) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

/** A deterministic clock: `advance(ms)` fires any interval callbacks whose
 * schedule has elapsed. Real timers are never used in these tests, so a run
 * cannot leave a hung Jest process behind. */
function fakeClock(): PreviewClock & { advance(ms: number): void; intervalCount: number } {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { ms: number; due: number; callback: () => void }>();
  return {
    now: () => now,
    setInterval(callback: () => void, ms: number) {
      const id = nextId++;
      intervals.set(id, { ms, due: now + ms, callback });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer: ReturnType<typeof setInterval>) {
      intervals.delete(timer as unknown as number);
    },
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        const due = [...intervals.entries()]
          .filter(([, entry]) => entry.due <= target)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const [, entry] = due;
        now = entry.due;
        entry.due += entry.ms;
        entry.callback();
      }
      now = target;
    },
    get intervalCount() {
      return intervals.size;
    },
  };
}

describe("ReportPreviewRenderer", () => {
  test("shows each incremental report suffix only once on an interactive stream", () => {
    const stderr = output();
    const renderer = new ReportPreviewRenderer(stderr);

    renderer.start();
    renderer.update({ report: "First sentence." });
    renderer.update({ report: "First sentence. Second sentence." });

    expect(stderr.text).toContain(
      "Report preview (in progress; not yet validated)",
    );
    expect(stderr.text.match(/First sentence\./g)).toHaveLength(1);
    expect(stderr.text).toContain(" Second sentence.");
  });

  test("shows the summary while it is the only field the writer has produced", () => {
    const stderr = output();
    const renderer = new ReportPreviewRenderer(stderr);

    renderer.start();
    renderer.update({ summary: "The limit is" });
    renderer.update({ summary: "The limit is 42 rps." });

    expect(stderr.text).toContain("The limit is 42 rps.");
    expect(stderr.text.match(/The limit is/g)).toHaveLength(1);
  });

  test("appends the report after the summary it followed", () => {
    const stderr = output();
    const renderer = new ReportPreviewRenderer(stderr);

    renderer.update({ summary: "The limit is 42 rps." });
    renderer.update({
      summary: "The limit is 42 rps.",
      report: "The documented",
    });
    renderer.update({
      summary: "The limit is 42 rps.",
      report: "The documented limit [S1].",
    });

    expect(stderr.text).toContain("The limit is 42 rps.");
    expect(stderr.text).toContain("The documented limit [S1].");
    expect(stderr.text).not.toContain("[preview updated]");
  });

  test("keeps displayed preview content when synthesis fails", () => {
    const stderr = output();
    const renderer = new ReportPreviewRenderer(stderr);

    renderer.update({ report: "Already visible." });
    renderer.fail("provider stopped");

    expect(stderr.text).toContain("Already visible.");
    expect(stderr.text).toContain(
      "incomplete / not validated: provider stopped",
    );
  });

  test("does nothing when stderr is not interactive", () => {
    const stderr = output(false);
    const renderer = new ReportPreviewRenderer(stderr);

    renderer.update({ report: "Must not leak into a pipe." });
    renderer.fail("failure");

    expect(stderr.text).toBe("");
  });
});

describe("WritingPreviewRenderer", () => {
  test("reports having streamed once prose reaches an interactive stream", () => {
    const stderr = output();
    const renderer = new WritingPreviewRenderer(stderr);

    expect(renderer.streamed).toBe(false);
    renderer.update("");
    expect(renderer.streamed).toBe(false);

    renderer.update("The first line.");

    expect(renderer.streamed).toBe(true);
    expect(stderr.text).toBe("The first line.");
  });

  test("reports nothing streamed into a pipe, so the caller still prints it", () => {
    const stderr = output(false);
    const renderer = new WritingPreviewRenderer(stderr);

    renderer.update("Must not leak into a pipe.");

    expect(renderer.streamed).toBe(false);
    expect(stderr.text).toBe("");
  });

  test("start() immediately shows waiting at 0 seconds and schedules one-second updates", () => {
    const stderr = output();
    const clock = fakeClock();
    const renderer = new WritingPreviewRenderer(stderr, clock);

    renderer.start();

    expect(stderr.text).toContain("Writing · waiting for model · 0s · Ctrl-C to cancel");
    expect(clock.intervalCount).toBe(1);

    clock.advance(1_000);
    expect(stderr.text).toContain("Writing · waiting for model · 1s · Ctrl-C to cancel");

    clock.advance(11_000);
    expect(stderr.text).toContain("Writing · waiting for model · 12s · Ctrl-C to cancel");
  });

  test("thinking() switches the label only after being called, and only from an observed phase event", () => {
    const stderr = output();
    const clock = fakeClock();
    const renderer = new WritingPreviewRenderer(stderr, clock);

    renderer.start();
    expect(stderr.text).not.toContain("thinking");

    renderer.thinking();
    expect(stderr.text).toContain("Writing · thinking · 0s · Ctrl-C to cancel");

    clock.advance(12_000);
    expect(stderr.text).toContain("Writing · thinking · 12s · Ctrl-C to cancel");
  });

  test("thinking() starts the renderer defensively when start() was never called", () => {
    const stderr = output();
    const clock = fakeClock();
    const renderer = new WritingPreviewRenderer(stderr, clock);

    renderer.thinking();

    expect(stderr.text).toContain("Writing · thinking · 0s · Ctrl-C to cancel");
    expect(clock.intervalCount).toBe(1);
  });

  test("first prose clears the transient status, stops the timer, and appends the delta once", () => {
    const stderr = output();
    const clock = fakeClock();
    const renderer = new WritingPreviewRenderer(stderr, clock);

    renderer.start();
    clock.advance(3_000);
    renderer.update("Finished ");

    expect(clock.intervalCount).toBe(0);
    expect(renderer.streamed).toBe(true);
    expect(stderr.text.endsWith("Finished ")).toBe(true);

    renderer.update("prose.");
    expect(stderr.text.endsWith("Finished prose.")).toBe(true);

    // Advancing further must not resurrect the status line: the timer is gone.
    clock.advance(5_000);
    expect(stderr.text.endsWith("Finished prose.")).toBe(true);
  });

  test("repeated start()/thinking() calls do not create multiple intervals or duplicate headers", () => {
    const stderr = output();
    const clock = fakeClock();
    const renderer = new WritingPreviewRenderer(stderr, clock);

    renderer.start();
    renderer.start();
    renderer.thinking();
    renderer.thinking();

    expect(clock.intervalCount).toBe(1);
  });

  test("complete() clears a live timer, both before and after prose", () => {
    const stderr = output();
    const clock = fakeClock();
    const beforeProse = new WritingPreviewRenderer(stderr, clock);
    beforeProse.start();
    beforeProse.complete();
    expect(clock.intervalCount).toBe(0);
    expect(stderr.text).toContain("[writing complete]");

    const stderr2 = output();
    const clock2 = fakeClock();
    const afterProse = new WritingPreviewRenderer(stderr2, clock2);
    afterProse.start();
    afterProse.update("Some prose.");
    afterProse.complete();
    expect(clock2.intervalCount).toBe(0);
    expect(stderr2.text).toContain("[writing complete]");
  });

  test("fail() clears a live timer, both before and after prose", () => {
    const stderr = output();
    const clock = fakeClock();
    const beforeProse = new WritingPreviewRenderer(stderr, clock);
    beforeProse.start();
    beforeProse.fail("provider stopped");
    expect(clock.intervalCount).toBe(0);
    expect(stderr.text).toContain("[writing incomplete: provider stopped]");

    const stderr2 = output();
    const clock2 = fakeClock();
    const afterProse = new WritingPreviewRenderer(stderr2, clock2);
    afterProse.start();
    afterProse.update("Some prose.");
    afterProse.fail("timed out");
    expect(clock2.intervalCount).toBe(0);
    expect(stderr2.text).toContain("[writing incomplete: timed out]");
  });

  test("does nothing and creates no timer on non-interactive output", () => {
    const stderr = output(false);
    const clock = fakeClock();
    const renderer = new WritingPreviewRenderer(stderr, clock);

    renderer.start();
    renderer.thinking();
    renderer.update("Must not leak into a pipe.");
    renderer.complete();

    expect(clock.intervalCount).toBe(0);
    expect(renderer.streamed).toBe(false);
    expect(stderr.text).toBe("");
  });

  test("a status line alone does not set streamed, preserving final stdout delivery on a no-prose failure", () => {
    const stderr = output();
    const clock = fakeClock();
    const renderer = new WritingPreviewRenderer(stderr, clock);

    renderer.start();
    renderer.thinking();
    clock.advance(2_000);
    renderer.fail("upstream stopped before any prose");

    expect(renderer.streamed).toBe(false);
  });
});
