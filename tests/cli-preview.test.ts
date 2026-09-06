import { describe, expect, test } from "@jest/globals";

import { ReportPreviewRenderer } from "../src/cli-preview.js";
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
});
