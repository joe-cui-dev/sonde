import { describe, expect, test } from "@jest/globals";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { RunStore } from "../src/store/runs.js";
import { runWrite } from "../src/writing/write-agent.js";
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

  test("uses an independent writing model and reasoning default", () => {
    const config = loadConfig({ OPENROUTER_API_KEY: "sk-or-test", TAVILY_API_KEY: "tvly-test", SONDE_WRITER_MODEL: "writer", SONDE_WRITE_MODEL: "writer-prose" });
    expect(config.writeModel).toBe("writer-prose"); expect(config.writeReasoningEffort).toBe("medium");
  });
});
