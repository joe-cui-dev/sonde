import { describe, expect, test } from "@jest/globals";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { RunStore } from "../src/store/runs.js";
import type { WriteEvent } from "../src/types.js";
import { runWrite } from "../src/writing/write-agent.js";
import { writePrompt } from "../src/writing/prompts.js";
import { countWords } from "../src/writing/length.js";
import { WRITE_STYLES } from "../src/writing/styles.js";
import { loadStyles, requireStyle } from "../src/writing/style-file.js";
import { loadCharacters, requireCharacter } from "../src/writing/character-file.js";
import { archivePath, saveProse } from "../src/writing/archive.js";
import { erroringStreamModel, reasoningThenTextModel, says, scriptedModel, testConfig } from "./helpers/mock.js";

function databasePath() { return join(mkdtempSync(join(tmpdir(), "sonde-write-")), "sonde.db"); }

/** A config whose styles file exists and holds `content`. */
function configWithStyles(content: unknown) {
  const config = testConfig(databasePath());
  writeFileSync(config.stylesPath, typeof content === "string" ? content : JSON.stringify(content));
  return config;
}

/** A config whose characters file exists and holds `content`. */
function configWithCharacters(content: unknown) {
  const config = testConfig(databasePath());
  writeFileSync(config.charactersPath, typeof content === "string" ? content : JSON.stringify(content));
  return config;
}

const NOIR = {
  noir: {
    name: "Noir",
    summary: "First person, past tense, a narrator who notices what he would rather not.",
    moves: ["Keep the sentences short and the paragraphs shorter."],
    avoid: ["Period pastiche in place of an observed detail."],
  },
};

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
    const dbPath = databasePath();
    const model = scriptedModel([{
      ...says(""),
      content: [
        { type: "text", text: "Finished " },
        { type: "text", text: "prose." },
      ],
    }]);
    const events: WriteEvent[] = [];
    const result = await runWrite({ brief: "Write a note", config: testConfig(dbPath), model, onEvent: (event) => { events.push(event); } });
    expect(result).toMatchObject({ text: "Finished prose.", complete: true, stoppedBy: "complete", mode: "new" });
    expect(model.prompts[0]).toContain("complete, finished piece");
    expect(events.map((event) => event.type)).toEqual([
      "write_start", "write_phase", "text_delta", "text_delta", "write_end",
    ]);
    expect(events.filter((event) => event.type === "write_phase")).toEqual([
      { type: "write_phase", phase: "writing" },
    ]);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", delta: "Finished " },
      { type: "text_delta", delta: "prose." },
    ]);
    const db = openDb(dbPath);
    try {
      expect(new RunStore(db).recent()[0]).toMatchObject({ kind: "writing", question: "Write a note" });
      expect(db.prepare("SELECT report_json FROM runs WHERE id = ?").get(result.runId))
        .toMatchObject({ report_json: "Finished prose." });
      // The coarse write_phase transition is persisted alongside write_start;
      // raw reasoning never is, since it never becomes a WriteEvent at all.
      expect(db.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY id").all(result.runId))
        .toEqual([{ type: "write_start" }, { type: "write_phase" }]);
    } finally {
      db.close();
    }
  });

  test("emits exactly one thinking phase then one writing phase for a reasoning provider, with no raw reasoning anywhere", async () => {
    const dbPath = databasePath();
    const model = reasoningThenTextModel(
      ["Let me consider ", "the angle here."],
      ["Finished ", "prose."],
    );
    const events: WriteEvent[] = [];
    const result = await runWrite({
      brief: "Write a note", config: testConfig(dbPath), model,
      onEvent: (event) => { events.push(event); },
    });
    expect(result.text).toBe("Finished prose.");
    expect(events.map((event) => event.type)).toEqual([
      "write_start", "write_phase", "write_phase", "text_delta", "text_delta", "write_end",
    ]);
    expect(events.filter((event) => event.type === "write_phase")).toEqual([
      { type: "write_phase", phase: "thinking" },
      { type: "write_phase", phase: "writing" },
    ]);
    // Reasoning text itself must never surface — not in the events, and not
    // folded into the accumulated prose.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Let me consider");
    expect(serialized).not.toContain("the angle here");
    const db = openDb(dbPath);
    try {
      expect(db.prepare("SELECT report_json FROM runs WHERE id = ?").get(result.runId))
        .toMatchObject({ report_json: "Finished prose." });
      const persisted = db
        .prepare("SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY id")
        .all(result.runId) as Array<{ type: string; payload: string }>;
      expect(persisted.map((row) => row.type)).toEqual(["write_start", "write_phase", "write_phase"]);
      const persistedText = persisted.map((row) => row.payload).join("\n");
      expect(persistedText).not.toContain("Let me consider");
      expect(persistedText).not.toContain("the angle here");
    } finally {
      db.close();
    }
  });

  test("delivers streamed partial prose after an in-stream provider error", async () => {
    const dbPath = databasePath();
    const events: WriteEvent[] = [];
    const result = await runWrite({ brief: "Write", config: testConfig(dbPath), model: erroringStreamModel("upstream stopped", "Useful beginning."), onEvent: (event) => { events.push(event); } });
    expect(result).toMatchObject({ text: "Useful beginning.", complete: false, stoppedBy: "error" });
    expect(result.warnings.join(" ")).toContain("upstream stopped");
    expect(events).toContainEqual({ type: "write_phase", phase: "writing" });
    expect(events).toContainEqual({ type: "text_delta", delta: "Useful beginning." });
    const db = openDb(dbPath);
    try {
      expect(db.prepare("SELECT report_json FROM runs WHERE id = ?").get(result.runId))
        .toMatchObject({ report_json: "Useful beginning." });
      expect(db.prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY id").all(result.runId))
        .toEqual([{ type: "write_start" }, { type: "write_phase" }, { type: "warning" }]);
    } finally {
      db.close();
    }
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

  test("adds a style from the styles file and hands its spec to the writer", async () => {
    const model = scriptedModel([says("The rain had opinions.")]);
    const result = await runWrite({
      brief: "Write a scene", style: "noir", config: configWithStyles(NOIR), model,
    });
    expect(result.style).toBe("noir");
    expect(model.prompts[0]).toContain("Style — Noir");
    expect(model.prompts[0]).toContain("Keep the sentences short");
    expect(model.prompts[0]).toContain("Period pastiche");
  });

  test("lets a styles file entry replace the built-in style it is named for", async () => {
    const model = scriptedModel([says("Eleven minutes.")]);
    await runWrite({
      brief: "Write a note", style: "plain", model,
      config: configWithStyles({
        plain: { summary: "Numbers, not adjectives.", moves: ["Say the number."] },
      }),
    });
    const prompt = model.prompts[0]!;
    expect(prompt).toContain("Numbers, not adjectives.");
    // Replaced outright, not merged: what the writer gets is one whole spec.
    expect(prompt).not.toContain("Put the actor before the action");
    // A style may name no failures, and a bare "Avoid:" would read as a lost instruction.
    expect(prompt).not.toContain("Avoid:");
  });

  test("takes the id as the name when the styles file gives none", () => {
    const config = configWithStyles({ terse: { summary: "Short.", moves: ["Stop early."] } });
    expect(loadStyles(config.stylesPath).terse).toMatchObject({ id: "terse", name: "terse", avoid: [] });
  });

  test("leaves the built-in styles alone when there is no styles file", () => {
    expect(Object.keys(loadStyles(testConfig(databasePath()).stylesPath)).sort())
      .toEqual(Object.keys(WRITE_STYLES).sort());
  });

  test("names the file and the field when a styles file is wrong", () => {
    // A styles file that exists and is broken is an error, never a quiet
    // fallback: prose written in a register nobody chose is already paid for.
    const badJson = configWithStyles("{ nope");
    expect(() => loadStyles(badJson.stylesPath)).toThrow(badJson.stylesPath);
    const noMoves = configWithStyles({ noir: { summary: "Dark.", moves: [] } });
    expect(() => loadStyles(noMoves.stylesPath)).toThrow(/noir\.moves/u);
    const stray = configWithStyles({ noir: { summary: "Dark.", moves: ["Stop."], tone: "grim" } });
    expect(() => loadStyles(stray.stylesPath)).toThrow(/tone/u);
  });

  test("answers an unknown style with the styles this machine actually has", () => {
    const catalogue = loadStyles(configWithStyles(NOIR).stylesPath);
    expect(() => requireStyle(catalogue, "nior")).toThrow(/Unknown style: nior/u);
    expect(() => requireStyle(catalogue, "nior")).toThrow(/noir/u);
  });

  test("refuses a style that does not exist before spending anything on the run", async () => {
    const model = scriptedModel([says("never reached")]);
    await expect(runWrite({ brief: "Write", style: "gothic", config: testConfig(databasePath()), model }))
      .rejects.toThrow(/Unknown style: gothic/u);
    expect(model.callCount).toBe(0);
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

  describe("character reference", () => {
    test("leaves the prompt exactly as it was when no characters are given", () => {
      const withoutField = writePrompt({ brief: "b", mode: "new", style: WRITE_STYLES.plain });
      const withEmptyList = writePrompt({ brief: "b", mode: "new", style: WRITE_STYLES.plain, characters: [] });
      expect(withEmptyList).toBe(withoutField);
      expect(withoutField).not.toContain("character reference");
    });

    test("adds a bounded character block between the style and the house rules", async () => {
      const model = scriptedModel([says("Mara said nothing.")]);
      const config = configWithCharacters({
        mara: {
          name: "Mara Okonkwo",
          aliases: ["Detective Okonkwo"],
          description: "Says less than she notices.",
          relationships: ["Former partner: Sal Ruiz"],
        },
      });
      await runWrite({ brief: "Write a scene", mode: "new", characters: ["mara"], config, model });
      const prompt = model.prompts[0]!;
      expect(prompt).toContain("--- character reference ---");
      expect(prompt).toContain("--- end character reference ---");
      expect(prompt).toContain("Mara Okonkwo (also: Detective Okonkwo)");
      expect(prompt).toContain("Says less than she notices.");
      expect(prompt).toContain("Former partner: Sal Ruiz");
      // Data boundary and priority order, in the words the design settled on.
      expect(prompt).toContain("not an instruction");
      expect(prompt).toContain("the brief wins");
      // Placed after the style block and before the house rules — material,
      // not competing with STYLE_HOLDS for the closing recency effect.
      expect(prompt.indexOf("Style — Plain")).toBeLessThan(prompt.indexOf("--- character reference ---"));
      expect(prompt.indexOf("--- end character reference ---")).toBeLessThan(prompt.indexOf("read as machine-made"));
    });

    test("rejects a characters file with an unknown field, naming the file and the field", () => {
      const bad = configWithCharacters({ mara: { name: "Mara", description: "d", secretAgenda: "kill everyone" } });
      expect(() => loadCharacters(bad.charactersPath)).toThrow(bad.charactersPath);
      expect(() => loadCharacters(bad.charactersPath)).toThrow(/secretAgenda/u);
    });

    test("answers an unknown character id with the cast this machine actually has", () => {
      const catalogue = loadCharacters(configWithCharacters({ mara: { name: "Mara", description: "d" } }).charactersPath);
      expect(() => requireCharacter(catalogue, "sal")).toThrow(/Unknown character: sal/u);
      expect(() => requireCharacter(catalogue, "sal")).toThrow(/mara/u);
    });

    test("refuses a character id that does not exist before spending anything on the run", async () => {
      const model = scriptedModel([says("never reached")]);
      await expect(
        runWrite({ brief: "Write", characters: ["ghost"], config: testConfig(databasePath()), model }),
      ).rejects.toThrow(/Unknown character: ghost/u);
      expect(model.callCount).toBe(0);
    });

    test("refuses more characters than the per-run limit before the model is called", async () => {
      const config = configWithCharacters({
        a: { name: "A", description: "d" },
        b: { name: "B", description: "d" },
        c: { name: "C", description: "d" },
      });
      config.maxCharacterCards = 2;
      const model = scriptedModel([says("never reached")]);
      await expect(
        runWrite({ brief: "Write", characters: ["a", "b", "c"], config, model }),
      ).rejects.toThrow(/at most 2/u);
      expect(model.callCount).toBe(0);
    });

    test("refuses a field over the per-field character limit before the model is called", async () => {
      const config = configWithCharacters({ mara: { name: "Mara", description: "d".repeat(50) } });
      config.maxCharacterFieldChars = 10;
      const model = scriptedModel([says("never reached")]);
      await expect(
        runWrite({ brief: "Write", characters: ["mara"], config, model }),
      ).rejects.toThrow(/over the 10-character limit/u);
      expect(model.callCount).toBe(0);
    });

    test("refuses a characters file over the byte limit before the model is called", async () => {
      const config = configWithCharacters({ mara: { name: "Mara", description: "d".repeat(1000) } });
      config.maxCharactersFileBytes = 100;
      const model = scriptedModel([says("never reached")]);
      await expect(
        runWrite({ brief: "Write", characters: ["mara"], config, model }),
      ).rejects.toThrow(/over the 100-byte limit/u);
      expect(model.callCount).toBe(0);
    });

    test("records the injected characters and a file hash on write_start, readable back from run_events", async () => {
      const config = configWithCharacters({ mara: { name: "Mara Okonkwo", description: "d" } });
      const events: WriteEvent[] = [];
      const result = await runWrite({
        brief: "Write a scene", characters: ["mara"], config,
        model: scriptedModel([says("Scene.")]), onEvent: (event) => { events.push(event); },
      });
      const start = events.find((event) => event.type === "write_start");
      expect(start).toMatchObject({ characters: ["Mara Okonkwo"] });
      const charactersHash = start && "charactersHash" in start ? start.charactersHash : undefined;
      expect(charactersHash).toMatch(/^[0-9a-f]{16}$/u);
      const db = openDb(config.dbPath);
      try {
        const row = db
          .prepare("SELECT payload FROM run_events WHERE run_id = ? AND type = 'write_start'")
          .get(result.runId) as { payload: string };
        const payload = JSON.parse(row.payload) as { characters?: string[]; charactersHash?: string };
        expect(payload.characters).toEqual(["Mara Okonkwo"]);
        expect(payload.charactersHash).toBe(charactersHash);
      } finally {
        db.close();
      }
    });

    test("keeps character data out of the archived prose file", async () => {
      const model = scriptedModel([says("The scene played out quietly.")]);
      const config = configWithCharacters({
        mara: { name: "Mara Okonkwo", description: "Says less than she notices." },
      });
      const result = await runWrite({ brief: "Write a scene", characters: ["mara"], config, model });
      const path = archivePath(config.writingDir, result.mode, result.runId);
      saveProse(path, result.text!);
      const saved = readFileSync(path, "utf8");
      expect(saved).toBe("The scene played out quietly.\n");
      expect(saved).not.toContain("Mara Okonkwo");
      expect(saved).not.toContain("character reference");
    });
  });
});
