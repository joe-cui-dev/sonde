import { describe, expect, test } from "@jest/globals";

import { ReportPreviewRenderer } from "../src/cli-preview.js";

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

    expect(stderr.text).toContain("Report preview (in progress; not yet validated)");
    expect(stderr.text.match(/First sentence\./g)).toHaveLength(1);
    expect(stderr.text).toContain(" Second sentence.");
  });

  test("keeps displayed preview content when synthesis fails", () => {
    const stderr = output();
    const renderer = new ReportPreviewRenderer(stderr);

    renderer.update({ report: "Already visible." });
    renderer.fail("provider stopped");

    expect(stderr.text).toContain("Already visible.");
    expect(stderr.text).toContain("incomplete / not validated: provider stopped");
  });

  test("does nothing when stderr is not interactive", () => {
    const stderr = output(false);
    const renderer = new ReportPreviewRenderer(stderr);

    renderer.update({ report: "Must not leak into a pipe." });
    renderer.fail("failure");

    expect(stderr.text).toBe("");
  });
});
