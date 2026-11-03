import { describe, expect, test } from "@jest/globals";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkCommentary,
  checkEcho,
  checkLength,
  checkMentions,
} from "../src/eval/writing-checks.js";
import { loadWritingCases, type WritingCase } from "../src/eval/writing-cases.js";
import {
  caseStats,
  checkRun,
  compareReports,
  runWritingEval,
  type WritingEvalReport,
} from "../src/eval/writing-eval.js";
import { says, scriptedModel, testConfig } from "./helpers/mock.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "sonde-eval-"));
}

const DRAFT_ZH =
  "渡口在镇子最西头，一条石阶从老街一直伸进江里。林秀每天清晨五点起来开售票亭。" +
  "第三遍笛响的时候，石阶上传来脚步声，来的是一个三十来岁的男人，手里捏着一枚一元硬币。";

const DRAFT_EN =
  "The keeper's logbook had not been opened in eleven years, and the first thing Ines noticed " +
  "was that the last entry stopped mid-sentence. Below her, somewhere in the base of the tower, " +
  "a door she was sure she had closed banged once against its frame.";

describe("checkEcho", () => {
  test("new prose that only shares names and short phrases passes", () => {
    const check = checkEcho(DRAFT_ZH, "男人把硬币放在窗台上，林秀看了他一眼，没有说话。江上的雾更浓了。");
    expect(check.passed).toBe(true);
    expect(check.value).toBe(0);
  });

  test("a continuation that opens by retelling the draft's ending fails", () => {
    const text =
      "第三遍笛响的时候，石阶上传来脚步声，来的是一个三十来岁的男人，手里捏着一枚一元硬币。" +
      "他走到窗前。";
    const check = checkEcho(DRAFT_ZH, text);
    expect(check.passed).toBe(false);
    expect(check.value).toBeGreaterThan(0.8);
  });

  test("ignores punctuation and case when matching English", () => {
    const text =
      "BELOW HER — somewhere in the base of the tower — a door she was sure she had closed banged once. " +
      "She went down.";
    expect(checkEcho(DRAFT_EN, text).passed).toBe(false);
    expect(checkEcho(DRAFT_EN, "She took the torch and went down the stairs, counting them.").value).toBe(0);
  });
});

describe("checkCommentary", () => {
  test.each([
    "好的，以下是续写内容：\n\n男人走进售票亭。",
    "以下是扩写后的段落。\n\n雷声滚过。",
    "Sure, here is the continuation.\n\nShe went down.",
    "Here's the expanded passage:\n\nThe market filled.",
  ])("flags a preamble: %s", (text) => {
    const check = checkCommentary(text);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("preamble");
  });

  test.each([
    "他走了。\n\n希望这段续写符合你的要求！",
    "She closed the door.\n\nI hope this captures the mood you wanted.",
    "雨停了。\n\n（全文约 1200 字）",
  ])("flags a sign-off: %s", (text) => {
    expect(checkCommentary(text).detail).toContain("sign-off");
  });

  test("flags a label standing on its own line", () => {
    expect(checkCommentary("**续写：**\n\n男人走进售票亭。").detail).toContain("label");
  });

  test.each([
    "这是一个寒冷的早晨，渡口还没有人。",
    "当然，他知道她不会信。",
    "Sure enough, the door was open.",
    "Here is the house where she was born, and here is the road out of it.",
    "“如果你需要，”他说，“我明天再来。”",
  ])("leaves prose alone: %s", (text) => {
    expect(checkCommentary(text).passed).toBe(true);
  });
});

describe("checkLength", () => {
  test("uses the floor the workflow warns at, per mode", () => {
    const text = "字".repeat(85);
    expect(checkLength("expand", text, 100).passed).toBe(false);
    expect(checkLength("continue", text, 100).passed).toBe(true);
    expect(checkLength("new", "字".repeat(40), 100).passed).toBe(false);
    expect(checkLength("continue", text, 100).value).toBe(0.85);
  });
});

describe("checkMentions", () => {
  test("names what is missing, case-insensitively", () => {
    const check = checkMentions("The Generators went off at midnight.", ["generator", "aunt"]);
    expect(check.passed).toBe(false);
    expect(check.detail).toBe('missing "aunt"');
  });
});

describe("checkRun", () => {
  const entry: WritingCase = {
    id: "c", mode: "continue", brief: "go on", draft: DRAFT_EN, length: 10, mustMention: ["door"],
  };

  test("measures nothing past a run that did not finish", () => {
    const checks = checkRun(entry, false, "Half a");
    expect(checks.map((check) => check.name)).toEqual(["complete"]);
    expect(checks[0]!.passed).toBe(false);
  });

  test("runs every check the case calls for", () => {
    const checks = checkRun(entry, true, "She found the door open and the stairs wet below it.");
    expect(checks.map((check) => check.name)).toEqual(["complete", "length", "echo", "commentary", "mentions"]);
    expect(checks.every((check) => check.passed)).toBe(true);
  });
});

describe("loadWritingCases", () => {
  test("the repository's own cases load, with their drafts", () => {
    const cases = loadWritingCases("evals/writing/cases.json");
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      if (entry.mode === "new") expect(entry.draft).toBeUndefined();
      else expect(entry.draft?.length).toBeGreaterThan(100);
    }
  });

  function write(cases: unknown) {
    const path = join(scratch(), "cases.json");
    writeFileSync(path, JSON.stringify({ cases }));
    return path;
  }

  test("resolves drafts beside the cases file", () => {
    const path = write([{ id: "a", mode: "continue", brief: "go on", draft: "draft.md" }]);
    writeFileSync(join(path, "..", "draft.md"), "Once.");
    expect(loadWritingCases(path)[0]!.draft).toBe("Once.");
  });

  test.each([
    [[{ id: "a", mode: "new", brief: "b", draft: "x.md" }], "new mode does not accept a draft"],
    [[{ id: "a", mode: "expand", brief: "b" }], "expand mode needs a draft"],
    [[{ id: "a", mode: "new", brief: "b" }, { id: "a", mode: "new", brief: "c" }], 'duplicate id "a"'],
    [[{ id: "a", mode: "new", brief: "b", length: -1 }], "cases.0.length"],
    [[{ id: "a", mode: "new", brief: "b", typo: 1 }], "cases.0"],
    [[{ id: "a", mode: "continue", brief: "b", draft: "missing.md" }], "could not be read"],
  ])("refuses a bad file before anything runs: %j", (cases, message) => {
    expect(() => loadWritingCases(write(cases))).toThrow(message);
  });
});

describe("runWritingEval", () => {
  const cases: WritingCase[] = [
    { id: "fresh", mode: "continue", brief: "go on", draft: DRAFT_EN, length: 12, mustMention: ["torch"] },
    { id: "recap", mode: "continue", brief: "go on", draft: DRAFT_EN, mustMention: [] },
  ];

  test("runs each case through runWrite and checks what came back", async () => {
    const model = scriptedModel([
      says("She took the torch and went down the stairs, counting each one as she went."),
      says("She took the torch and went down."),
      says(DRAFT_EN),
      says(DRAFT_EN),
    ]);
    const seen: string[] = [];
    const report = await runWritingEval({
      cases, casesFile: "cases.json", config: testConfig(join(scratch(), "sonde.db")),
      repeat: 2, model, onRun: (run) => seen.push(`${run.caseId}#${run.attempt}`),
    });
    expect(seen).toEqual(["fresh#1", "fresh#2", "recap#1", "recap#2"]);
    expect(report.runs.map((run) => run.passed)).toEqual([true, true, false, false]);
    expect(report.runs[2]!.checks.find((check) => check.name === "echo")!.passed).toBe(false);
    expect(report.runs[0]!.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(report.runs[0]!.promptHash).toBe(report.runs[1]!.promptHash);
    expect(report.summary).toMatchObject({ runs: 4, passed: 2 });
    expect(report.summary.usd).toBeCloseTo(0.004);
    expect(caseStats(report).map((stats) => [stats.caseId, stats.passRate])).toEqual([["fresh", 1], ["recap", 0]]);
  });

  test("an unknown style stops the eval before the first run is paid for", async () => {
    const model = scriptedModel([]);
    await expect(
      runWritingEval({
        cases: [...cases, { id: "styled", mode: "new", brief: "b", style: "nope", mustMention: [] }],
        casesFile: "cases.json", config: testConfig(join(scratch(), "sonde.db")), model,
      }),
    ).rejects.toThrow("Unknown style: nope");
    expect(model.callCount).toBe(0);
  });
});

describe("compareReports", () => {
  function report(runs: Array<[string, boolean, string, number]>): WritingEvalReport {
    return {
      kind: "writing-eval", startedAt: "", model: "m", reasoningEffort: "low", casesFile: "", repeat: 1,
      summary: { runs: runs.length, passed: 0, usd: 0 },
      runs: runs.map(([caseId, passed, promptHash, ratio], index) => ({
        caseId, attempt: index + 1, runId: `r${index}`, mode: "expand", promptHash, complete: true,
        words: 0, usd: 0, warnings: [], text: "", passed,
        checks: [{ name: "length", passed, value: ratio, detail: "" }],
      })),
    };
  }

  test("a lower pass rate is a regression; a changed prompt is marked as such", () => {
    const rows = compareReports(
      report([["a", true, "p1", 1.1], ["a", true, "p1", 1.0], ["b", true, "q", 1], ["gone", true, "g", 1]]),
      report([["a", true, "p2", 1.0], ["a", false, "p2", 0.6], ["b", true, "q", 1], ["added", true, "n", 1]]),
    );
    const a = rows.find((row) => row.caseId === "a")!;
    expect(a).toMatchObject({ regressed: true, promptChanged: true });
    expect(a.before!.means.length).toBe(1.05);
    expect(a.after!.means.length).toBe(0.8);
    expect(rows.find((row) => row.caseId === "b")).toMatchObject({ regressed: false, promptChanged: false });
    expect(rows.find((row) => row.caseId === "added")!.before).toBeUndefined();
    expect(rows.find((row) => row.caseId === "gone")!.after).toBeUndefined();
  });
});
