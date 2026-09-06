import { describe, expect, test } from "@jest/globals";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { RunStore } from "../src/store/runs.js";
import { runWrite } from "../src/writing/write-agent.js";
import { writePrompt } from "../src/writing/prompts.js";
import { countWords } from "../src/writing/length.js";
import { WRITE_STYLES } from "../src/writing/styles.js";
import { archivePath, saveProse } from "../src/writing/archive.js";
import { erroringStreamModel, says, scriptedModel, testConfig } from "./helpers/mock.js";

function databasePath() { return join(mkdtempSync(join(tmpdir(), "sonde-write-")), "sonde.db"); }

describe("writing workflow seams", () => {
  test("upgrades a legacy run database once and labels historical rows research", () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, question TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, stopped_by TEXT, usd REAL, total_tokens INTEGER, search_credits INTEGER, report_json TEXT)");
    legacy.prepare("INSERT INTO runs (id, question, started_at) VALUES (?, ?, ?)").run("old", "old question", 1);
    legacy.close();
    const db = openDb(path);
    expect(new RunStore(db).recent()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "old", kind: "research" })]));
    db.close();
    expect(() => openDb(path).close()).not.toThrow();
  });

  test("writes a complete whole piece and records it as writing", async () => {
    const dbPath = databasePath(); const model = scriptedModel([says("Finished prose.")]);
    const result = await runWrite({ brief: "Write a note", config: testConfig(dbPath), model });
    expect(result).toMatchObject({ text: "Finished prose.", complete: true, stoppedBy: "complete", mode: "new" });
    expect(model.prompts[0]).toContain("complete, finished piece");
    const db = openDb(dbPath);
    expect(new RunStore(db).recent()[0]).toMatchObject({ kind: "writing", question: "Write a note" }); db.close();
  });

  test("delivers streamed partial prose after an in-stream provider error", async () => {
    const result = await runWrite({ brief: "Write", config: testConfig(databasePath()), model: erroringStreamModel("upstream stopped", "Useful beginning.") });
    expect(result).toMatchObject({ text: "Useful beginning.", complete: false, stoppedBy: "error" });
    expect(result.warnings.join(" ")).toContain("upstream stopped");
  });

  test("names a saved piece by local time, mode, and run id", () => {
    const at = new Date(2026, 8, 6, 21, 2, 33);
    expect(archivePath(".sonde/writing", "new", "run_ab12cd34", at))
      .toBe(".sonde/writing/20260906-210233-new-run_ab12cd34.md");
    // The brief never reaches the filename, whatever it says or which script
    // it is in — the run id ties the file to its row in run history.
    expect(archivePath("w", "expand", "run_x", at)).toBe("w/20260906-210233-expand-run_x.md");
  });

  test("saves the prose alone, so continue can read the file back as a draft", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sonde-archive-")), "deep", "piece.md");
    saveProse(path, "The tide came in.");
    expect(readFileSync(path, "utf8")).toBe("The tide came in.\n");
  });

  test("asks expand for the named passage alone, with the draft as context only", async () => {
    const model = scriptedModel([says("The storm scene, opened up.")]);
    await runWrite({
      brief: "详细展开描写原文中的暴风雨那一段",
      draft: "They set out. A storm came. They arrived.",
      mode: "expand",
      length: 3000,
      config: testConfig(databasePath()),
      model,
    });
    const prompt = model.prompts[0]!;
    expect(prompt).toContain("Expand one part of the draft, not the draft as a whole");
    expect(prompt).toContain("Return the new passage and nothing else");
    expect(prompt).toContain("do not reproduce it");
    // The floor is the passage, which is now the whole of what comes back.
    expect(prompt).toContain("The passage must run to at least 3000 words");
    expect(prompt).toContain("详细展开描写原文中的暴风雨那一段");
    // Context, not output: the writer still needs to see the draft to know what
    // it is opening up and where the passage sits.
    expect(prompt).toContain("They set out. A storm came. They arrived.");
    expect(prompt).not.toContain("× the draft");
  });

  test("puts every requirement in the brief to the writer as binding", async () => {
    const model = scriptedModel([says("The whole piece, storm and all.")]);
    await runWrite({
      brief:
        "详细展开描写原文中的暴风雨那一段，并额外描写暴风雨中行人艰难在路上行走的样子，" +
        "从第一次打雷的时间点开始写起，字数2000字以上。",
      draft: "They set out. A storm came. They arrived.",
      mode: "expand",
      length: 2000,
      config: testConfig(databasePath()),
      model,
    });
    const prompt = model.prompts[0]!;
    expect(prompt).toContain("Read it as a list of requirements and satisfy every one");
    expect(prompt).toContain("where to begin and end");
    expect(prompt).toContain("check the brief again against what you have written");
    // A brief that names its own count has to beat the flag, or the two numbers
    // in front of the writer contradict each other.
    expect(prompt).toContain("If the brief states its own length, that figure governs");
    // A brief that says where to start is asking for prose that starts there,
    // not for a run-up through what came before it.
    expect(prompt).toContain("do not lead in with what came before the passage");
    expect(prompt).toContain("rather than summarizing");
  });

  test("takes its register from the draft when continue and expand are given no style", async () => {
    const model = scriptedModel([says("More of the same.")]);
    const result = await runWrite({
      brief: "Carry it on",
      draft: "起风了。他把领子竖起来。",
      mode: "continue",
      config: testConfig(databasePath()),
      model,
    });
    // Pinning a register on a run that writes into someone else's prose would
    // show at exactly the seam it is supposed to hide.
    expect(result.style).toBe("match");
    expect(model.prompts[0]).toContain("Take the register from the draft itself");
    expect(model.prompts[0]).toContain("the seam does not show");
  });

  test("falls back to plain only where there is no draft to take a register from", async () => {
    const model = scriptedModel([says("A note.")]);
    const result = await runWrite({ brief: "Write a note", config: testConfig(databasePath()), model });
    expect(result.style).toBe("plain");
    expect(model.prompts[0]).toContain("Style — Plain");
  });

  test("gives the writer moves and failures instead of an adjective", () => {
    const prompt = writePrompt({ brief: "b", mode: "new", style: WRITE_STYLES.literary });
    expect(prompt).toContain("Style — Literary");
    expect(prompt).toContain("Do this:");
    expect(prompt).toContain("Carry feeling through physical detail");
    expect(prompt).toContain("Avoid:");
    expect(prompt).toContain("Simile as decoration");
  });

  test("states the anti-autopilot rules once, whichever style is asked for", () => {
    for (const style of [WRITE_STYLES.business, WRITE_STYLES.literary]) {
      const prompt = writePrompt({ brief: "b", mode: "new", style });
      expect(prompt).toContain("read as machine-made");
      expect(prompt).toContain("not merely X, but Y");
      expect(prompt).toContain("No meta-commentary");
      // House rules belong to no style, so they are stated once, not per entry.
      expect(prompt.match(/read as machine-made/gu)).toHaveLength(1);
    }
  });

  test("restates the register after the draft, where the drift is worst", () => {
    const prompt = writePrompt({
      brief: "Open up the storm", draft: "A storm came.", mode: "expand",
      style: WRITE_STYLES.literary, length: 3000,
    });
    const reminder = "Hold the style described above — Literary — from the first sentence to the last.";
    expect(prompt.trimEnd().endsWith(reminder)).toBe(true);
    expect(prompt.indexOf(reminder)).toBeGreaterThan(prompt.indexOf("A storm came."));
  });

  test("says nothing about length when neither brief nor flag asks for one", () => {
    expect(writePrompt({ brief: "b", draft: "d", mode: "expand", style: WRITE_STYLES.plain }))
      .toContain("Choose an appropriate length");
  });

  test("reports an expansion that lands well under the floor it was given", async () => {
    const result = await runWrite({
      brief: "Open up the storm",
      draft: "They set out. A storm came.",
      mode: "expand",
      length: 2000,
      config: testConfig(databasePath()),
      model: scriptedModel([says("Thunder, once, and then the rain.")]),
    });
    // The run still succeeded and still delivered its prose: the count is
    // reported, not enforced.
    expect(result).toMatchObject({ complete: true, stoppedBy: "complete" });
    expect(result.warnings.join(" ")).toContain("short of the 2,000 asked for");
  });

  test("leaves an expansion that meets its floor unremarked", async () => {
    const result = await runWrite({
      brief: "Open up the storm",
      draft: "起。",
      mode: "expand",
      length: 30,
      config: testConfig(databasePath()),
      model: scriptedModel([says("雷声轰鸣，行人艰难前行。".repeat(3))]),
    });
    expect(result.warnings).toEqual([]);
  });

  test("counts characters for CJK prose and words elsewhere", () => {
    expect(countWords("暴风雨来了。")).toBe(6);
    expect(countWords("the storm arrived at last")).toBe(5);
    expect(countWords("")).toBe(0);
    expect(countWords("行人 walking 艰难")).toBe(5);
  });

  test("reads length as words in every mode", () => {
    const style = WRITE_STYLES.plain;
    expect(writePrompt({ brief: "b", mode: "new", style, length: 500 }))
      .toContain("roughly 500 words");
    expect(writePrompt({ brief: "b", draft: "d", mode: "continue", style, length: 500 }))
      .toContain("roughly 500 words");
    expect(writePrompt({ brief: "b", draft: "d", mode: "expand", style, length: 500 }))
      .toContain("at least 500 words");
    expect(writePrompt({ brief: "b", draft: "d", mode: "expand", style }))
      .toContain("Choose an appropriate length");
  });

  test("uses an independent writing model and reasoning default", () => {
    const config = loadConfig({ OPENROUTER_API_KEY: "sk-or-test", TAVILY_API_KEY: "tvly-test", SONDE_WRITER_MODEL: "writer", SONDE_WRITE_MODEL: "writer-prose" });
    expect(config.writeModel).toBe("writer-prose"); expect(config.writeReasoningEffort).toBe("medium");
  });
});
