#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { runResearch } from "./agent/research-agent.js";
import { loadConfig, type Config } from "./config.js";
import { openDb } from "./store/db.js";
import { RunStore } from "./store/runs.js";
import { preflight } from "./preflight.js";
import { createLogger, usd } from "./util/log.js";
import { ReportPreviewRenderer } from "./cli-preview.js";
import { runWrite } from "./writing/write-agent.js";
import { archivePath, saveProse } from "./writing/archive.js";
import { WRITE_STYLES } from "./writing/styles.js";
import { loadStyles, requireStyle } from "./writing/style-file.js";
import { loadCharacters, requireCharacter } from "./writing/character-file.js";
import { WritingPreviewRenderer } from "./writing-preview.js";
import type { ResearchResult, RunEvent, WriteMode, WriteResult } from "./types.js";

const USAGE = `
sonde — a web research agent

  sonde research "<question>" [options]
  sonde write "<brief>" [--mode new|continue|expand] [--in draft.md]
  sonde runs [--limit N]
  sonde doctor

Options
  -o, --out <file>       write the report to a markdown file
      --json             print the full result as JSON on stdout
      --max-steps <n>    override SONDE_MAX_STEPS
      --max-usd <n>      override SONDE_MAX_USD
      --quiet            suppress progress output
      --mode <mode>      new (default), continue, or expand
      --in <file>        read a draft (stdin is used when piped)
      --style <style>    ${Object.keys(WRITE_STYLES).join(", ")}
                         (default: match under continue and expand, plain under new)
                         plus any style in SONDE_STYLES_FILE
      --character <id>   inject a character reference by id (repeatable);
                         ids come from SONDE_CHARACTERS_FILE
      --lang <language>  language for writing
      --length <n>       words to write; under expand, the length of the
                         passage it returns
  -h, --help             show this

Every write run also saves its prose under SONDE_WRITING_DIR (.sonde/writing,
which is gitignored) and prints the path — pass it back with --in to continue
or expand the piece.

Styles of your own go in SONDE_STYLES_FILE (.sonde/styles.json, also
gitignored). One named for a built-in style replaces it. See styles.example.json.

A project's cast goes in SONDE_CHARACTERS_FILE (.sonde/characters.json, also
gitignored) — a record of ids to character cards, injected with --character
<id> (repeatable). See characters.example.json.
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      json: { type: "boolean", default: false },
      "max-steps": { type: "string" },
      "max-usd": { type: "string" },
      limit: { type: "string" },
      quiet: { type: "boolean", default: false },
      mode: { type: "string" },
      in: { type: "string" },
      style: { type: "string" },
      character: { type: "string", multiple: true },
      lang: { type: "string" },
      length: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  if (command === "doctor") {
    const config = loadConfig();
    const log = createLogger("info");
    const checks = await preflight(config);
    for (const check of checks) {
      const mark = check.ok ? log.c.green("ok  ") : log.c.red("fail");
      process.stdout.write(
        `${mark} ${check.name.padEnd(20)} ${check.detail}\n`,
      );
    }
    const failed = checks.filter((c) => !c.ok).length;
    process.stdout.write(
      failed === 0
        ? log.c.green("\nAll checks passed — safe to spend money.\n")
        : log.c.red(
            `\n${failed} check(s) failed — fix these before running research.\n`,
          ),
    );
    return failed === 0 ? 0 : 1;
  }

  if (command === "runs") {
    const config = loadConfig();
    const db = openDb(config.dbPath);
    const rows = new RunStore(db).recent(Number(values.limit ?? 20));
    db.close();
    if (rows.length === 0) {
      process.stdout.write("No runs recorded yet.\n");
      return 0;
    }
    for (const r of rows) {
      const when = new Date(Number(r["started_at"]))
        .toISOString()
        .replace("T", " ")
        .slice(0, 16);
      process.stdout.write(
        `${String(r["id"]).padEnd(14)} ${when}  ${String(r["stopped_by"] ?? "running").padEnd(18)}` +
          `${usd(Number(r["usd"] ?? 0)).padStart(9)}  ${String(r["question"]).slice(0, 60)}\n`,
      );
    }
    return 0;
  }

  if (command === "write") return writeCommand(values, positionals.slice(1));

  if (command !== "research") {
    process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
    return 1;
  }

  const question = positionals.slice(1).join(" ").trim();
  if (!question) {
    process.stderr.write("A question is required.\n" + USAGE);
    return 1;
  }

  const config = loadConfig();
  if (values.quiet) config.logLevel = "silent";
  const log = createLogger(config.logLevel);
  const preview = new ReportPreviewRenderer(process.stderr);

  const limits = {
    ...(values["max-steps"] ? { maxSteps: Number(values["max-steps"]) } : {}),
    ...(values["max-usd"] ? { maxUsd: Number(values["max-usd"]) } : {}),
  };

  const controller = new AbortController();
  process.once("SIGINT", () => {
    log.warn("interrupted — wrapping up with what has been gathered");
    controller.abort();
  });

  const result = await runResearch({
    question,
    config,
    limits,
    signal: controller.signal,
    onEvent: (event) => {
      if (!values.quiet && event.type === "phase" && event.phase === "synthesis") {
        preview.start();
      }
      if (!values.quiet && event.type === "report_preview") {
        preview.update(event.preview);
      }
      renderEvent(event, log);
    },
  });

  if (values.json) {
    try {
      await writeStdout(JSON.stringify(result, null, 2) + "\n");
      if (result.report) preview.complete();
      else preview.fail(lastWarning(result));
    } catch (error) {
      preview.fail(errorMessage(error));
      throw error;
    }
    return result.report ? 0 : 2;
  }

  const markdown = toMarkdown(result);
  if (values.out) {
    try {
      writeFileSync(values.out, markdown, "utf8");
      log.info(log.c.green(`\n→ written to ${values.out}`));
      if (result.report) preview.complete();
      else preview.fail(lastWarning(result));
    } catch (error) {
      preview.fail(errorMessage(error));
      throw error;
    }
  } else {
    try {
      await writeStdout("\n" + markdown);
      if (result.report) preview.complete();
      else preview.fail(lastWarning(result));
    } catch (error) {
      preview.fail(errorMessage(error));
      throw error;
    }
  }

  return result.report ? 0 : 2;
}

async function writeCommand(
  values: Record<string, string | string[] | boolean | undefined>,
  args: string[],
): Promise<number> {
  const mode = (values.mode ?? "new") as WriteMode;
  if (!(["new", "continue", "expand"] as string[]).includes(mode)) throw new Error("--mode must be new, continue, or expand.");
  // Left undefined when the flag is absent, so the workflow can pick the default
  // that suits the mode: a continue or expand run takes its register from the
  // draft, and pinning "plain" here would have overridden that before it ran.
  const style = typeof values.style === "string" ? values.style : undefined;
  const characters = Array.isArray(values.character) ? values.character : [];
  const brief = args.join(" ").trim();
  if (!brief) throw new Error("A brief is required.");
  const hasDraft = typeof values.in === "string" || !process.stdin.isTTY;
  const draft = typeof values.in === "string"
    ? readFileSync(values.in, "utf8")
    : !process.stdin.isTTY ? readFileSync(0, "utf8") : undefined;
  if (mode === "new" && hasDraft) throw new Error("new mode does not accept a draft.");
  if (mode === "new" && style === "match") throw new Error("--style match needs a draft to match; use continue or expand.");
  if (mode !== "new" && !hasDraft) throw new Error(`${mode} mode requires a draft via --in or stdin.`);
  const length = parseLength(values.length);
  const config = loadConfig(); if (values.quiet) config.logLevel = "silent";
  // Checked here rather than against the built-in list, so that a typo is
  // answered with the styles this machine actually has, custom ones included.
  if (style !== undefined) requireStyle(loadStyles(config.stylesPath), style);
  // Same reasoning as the style check above: an unknown --character is a typo
  // in the command, and should fail before the draft is read further or
  // anything is spent, with the cast this machine's characters file actually has.
  if (characters.length) {
    const catalogue = loadCharacters(config.charactersPath, config.maxCharactersFileBytes);
    for (const id of characters) requireCharacter(catalogue, id);
  }
  const log = createLogger(config.logLevel);
  const controller = new AbortController(); process.once("SIGINT", () => controller.abort());
  const preview = new WritingPreviewRenderer(process.stderr);
  const result = await runWrite({
    brief, draft, mode, style, characters,
    language: typeof values.lang === "string" ? values.lang : undefined,
    length, config, signal: controller.signal,
    onEvent: (event) => {
      if (values.quiet) return;
      if (event.type === "write_start") preview.start();
      else if (event.type === "write_phase" && event.phase === "thinking") preview.thinking();
      else if (event.type === "reasoning_delta") preview.reasoning(event.delta);
      else if (event.type === "text_delta") preview.update(event.delta);
    },
  });
  const savedTo = archiveProse(result, config, log);
  const output = values.json ? JSON.stringify({ ...result, savedTo }, null, 2) + "\n" : writeText(result);

  // The stream already put this prose on the terminal, character by character;
  // printing the finished text to stdout would show the same piece twice. A
  // file, a pipe, or --json still gets the whole thing.
  const alreadyOnScreen =
    preview.streamed && !values.json && process.stdout.isTTY === true;

  if (typeof values.out === "string") writeFileSync(values.out, output, "utf8");
  else if (!alreadyOnScreen) await writeStdout(output);
  if (result.complete) preview.complete(); else preview.fail(lastWriteWarning(result));
  logWriteUsage(result, log);
  if (savedTo) logSavedPath(savedTo, result.complete, log);
  return result.complete ? 0 : 2;
}

/** A word count is a count: a bad one would reach the model as "roughly NaN". */
function parseLength(value: string | string[] | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const length = Number(value);
  if (!Number.isFinite(length) || length <= 0)
    throw new Error("--length must be a positive number of words.");
  return length;
}

/**
 * Keeps the finished prose on disk under the gitignored writing directory and
 * hands back the path, so the next run can be pointed straight at it. Failing
 * to save is reported and survived: the piece itself has already been paid for
 * and is on its way to stdout.
 */
function archiveProse(
  result: WriteResult,
  config: Config,
  log: ReturnType<typeof createLogger>,
): string | null {
  if (!result.text) return null;
  const path = archivePath(config.writingDir, result.mode, result.runId);
  try {
    saveProse(path, result.text);
    return path;
  } catch (error) {
    log.warn(`the piece could not be saved to ${path}: ${errorMessage(error)}`);
    return null;
  }
}

/** The last thing on the terminal, because it is the thing worth copying. */
function logSavedPath(
  path: string,
  complete: boolean,
  log: ReturnType<typeof createLogger>,
): void {
  log.info(
    log.c.green(`\n→ saved to ${path}`) +
      (complete ? "" : log.c.dim(" (partial prose)")),
  );
  log.info(
    log.c.dim(`  sonde write "<what to do next>" --mode continue --in ${path}`),
  );
}

/** What the run cost, on stderr, so stdout stays exactly the prose. */
function logWriteUsage(
  result: WriteResult,
  log: ReturnType<typeof createLogger>,
): void {
  const s = result.usage;
  log.info(
    log.c.dim(
      `${s.totalTokens.toLocaleString()} tokens ` +
        `(${s.inputTokens.toLocaleString()} in · ${s.outputTokens.toLocaleString()} out) · ` +
        `${usd(s.usd)} · ${(s.elapsedMs / 1000).toFixed(1)}s · stopped: ${result.stoppedBy}`,
    ),
  );
}

function writeText(result: WriteResult): string { return `${result.text ?? ""}${result.complete ? "" : "\n\n[INCOMPLETE — " + lastWriteWarning(result) + "]"}\n`; }
function lastWriteWarning(result: WriteResult): string { return result.warnings.at(-1) ?? "writing did not complete"; }

function renderEvent(
  event: RunEvent,
  log: ReturnType<typeof createLogger>,
): void {
  const { c } = log;
  switch (event.type) {
    case "run_start":
      log.info(`${c.bold("sonde")} ${c.dim(event.runId)}  ${event.question}`);
      break;
    case "phase":
      log.info(c.dim(`\n── ${event.phase} ─────────────────────────────`));
      break;
    case "report_preview":
      // The renderer owns interactive preview output. It is intentionally not
      // passed through the logger, which may be configured for a pipe.
      break;
    case "tool_start":
      log.debug(
        `  → ${event.tool} ${JSON.stringify(event.input).slice(0, 160)}`,
      );
      break;
    case "tool_end":
      log.info(
        `  ${c.cyan(event.tool)} ${event.summary} ${c.dim(`${event.ms}ms`)}`,
      );
      break;
    case "step": {
      const s = event.snapshot;
      log.debug(
        `  step ${s.steps}/${s.limits.maxSteps} · ${s.totalTokens.toLocaleString()} tok · ` +
          `${usd(s.usd)} · ${s.searchCredits} credits`,
      );
      break;
    }
    case "warning":
      log.warn(event.message);
      break;
    case "run_end": {
      const s = event.result.usage;
      log.info(
        c.dim(
          `\n${s.steps} steps · ${s.totalTokens.toLocaleString()} tokens · ${usd(s.usd)} · ` +
            `${s.searchCredits} credits · ${(s.elapsedMs / 1000).toFixed(1)}s · stopped: ${event.result.stoppedBy}`,
        ),
      );
      break;
    }
  }
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

function lastWarning(result: ResearchResult): string {
  return result.warnings.at(-1) ?? "no final report was produced";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toMarkdown(result: ResearchResult): string {
  const lines: string[] = [`# ${result.question}`, ""];

  if (!result.report) {
    lines.push("_No report was produced._", "");
    if (result.warnings.length) {
      lines.push(
        "## Warnings",
        "",
        ...result.warnings.map((w) => `- ${w}`),
        "",
      );
    }
    if (result.notes) lines.push("## Raw notes", "", result.notes, "");
    return lines.join("\n");
  }

  const r = result.report;
  lines.push(r.summary, "", r.report, "");

  if (r.openQuestions.length) {
    lines.push(
      "## Open questions",
      "",
      ...r.openQuestions.map((q) => `- ${q}`),
      "",
    );
  }

  lines.push("## Sources", "");
  for (const citation of r.citations) {
    lines.push(`- **${citation.id}** [${citation.title}](${citation.url})`);
    if (citation.quote)
      lines.push(`  > ${citation.quote.replace(/\n+/g, " ")}`);
  }
  lines.push("");

  if (result.warnings.length) {
    lines.push("## Warnings", "", ...result.warnings.map((w) => `- ${w}`), "");
  }

  const s = result.usage;
  lines.push(
    "---",
    "",
    `_confidence: ${r.confidence} · ${s.steps} steps · ${s.totalTokens.toLocaleString()} tokens · ` +
      `${usd(s.usd)} · ${s.searchCredits} search credits · stopped: ${result.stoppedBy}_`,
    "",
  );

  return lines.join("\n");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `\n${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
