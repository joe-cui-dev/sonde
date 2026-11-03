import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { Config } from "../config.js";
import type { WriteMode } from "../types.js";
import { countWords } from "../writing/length.js";
import { loadStyles, requireStyle } from "../writing/style-file.js";
import { runWrite } from "../writing/write-agent.js";
import {
  checkCommentary,
  checkComplete,
  checkEcho,
  checkLength,
  checkMentions,
  type CheckName,
  type CheckResult,
} from "./writing-checks.js";
import type { WritingCase } from "./writing-cases.js";

export interface WritingEvalRun {
  caseId: string;
  attempt: number;
  runId: string;
  mode: WriteMode;
  /**
   * Hash of the exact prompt sent, so a comparison can tell a case whose prompt
   * changed from one whose prompt did not — the second moved by variance alone.
   */
  promptHash: string;
  complete: boolean;
  words: number;
  usd: number;
  checks: CheckResult[];
  passed: boolean;
  warnings: string[];
  /** Kept so a run can be reread, or judged later, without digging through history. */
  text: string | null;
}

export interface WritingEvalReport {
  kind: "writing-eval";
  startedAt: string;
  label?: string;
  commit?: string;
  model: string;
  reasoningEffort: string;
  casesFile: string;
  repeat: number;
  runs: WritingEvalRun[];
  summary: { runs: number; passed: number; usd: number };
}

export interface RunWritingEvalOptions {
  cases: WritingCase[];
  casesFile: string;
  config: Config;
  /** Generation varies run to run; repeats turn one verdict into a pass rate. */
  repeat?: number;
  label?: string;
  commit?: string;
  signal?: AbortSignal;
  onRun?: (run: WritingEvalRun) => void;
  /** Test seam, passed through to `runWrite`. */
  model?: LanguageModel;
}

/**
 * Runs every case through the real writing workflow, one after another, and
 * checks what came back. Each run is an ordinary writing run — billed, and
 * recorded in run history — because a harness that bypassed `runWrite` would be
 * measuring something other than what users get.
 */
export async function runWritingEval(options: RunWritingEvalOptions): Promise<WritingEvalReport> {
  const repeat = options.repeat ?? 1;
  // Every style up front, against this machine's catalogue: a typo in the last
  // case should not surface after the others have been paid for.
  const styles = loadStyles(options.config.stylesPath);
  for (const entry of options.cases) if (entry.style) requireStyle(styles, entry.style);
  const report: WritingEvalReport = {
    kind: "writing-eval",
    startedAt: new Date().toISOString(),
    ...(options.label ? { label: options.label } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
    model: options.config.writeModel,
    reasoningEffort: options.config.writeReasoningEffort,
    casesFile: options.casesFile,
    repeat,
    runs: [],
    summary: { runs: 0, passed: 0, usd: 0 },
  };
  for (const entry of options.cases) {
    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      if (options.signal?.aborted) return summarize(report);
      let promptHash = "";
      const result = await runWrite({
        brief: entry.brief,
        draft: entry.draft,
        mode: entry.mode,
        style: entry.style,
        language: entry.lang,
        length: entry.length,
        config: options.config,
        signal: options.signal,
        model: options.model,
        onPrompt: (prompt) => {
          promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 12);
        },
      });
      const checks = checkRun(entry, result.complete, result.text);
      const run: WritingEvalRun = {
        caseId: entry.id,
        attempt,
        runId: result.runId,
        mode: entry.mode,
        promptHash,
        complete: result.complete,
        words: result.text ? countWords(result.text) : 0,
        usd: result.usage.usd,
        checks,
        passed: checks.every((check) => check.passed),
        warnings: result.warnings,
        text: result.text,
      };
      report.runs.push(run);
      options.onRun?.(run);
    }
  }
  return summarize(report);
}

/**
 * Only a finished run is measured further: the length of half a piece, or the
 * echo in it, describes where it was cut off rather than how it was written.
 */
export function checkRun(entry: WritingCase, complete: boolean, text: string | null): CheckResult[] {
  const done = checkComplete(complete, text);
  if (!done.passed || !text) return [done];
  return [
    done,
    ...(entry.length ? [checkLength(entry.mode, text, entry.length)] : []),
    ...(entry.draft ? [checkEcho(entry.draft, text)] : []),
    checkCommentary(text),
    ...(entry.mustMention.length ? [checkMentions(text, entry.mustMention)] : []),
  ];
}

function summarize(report: WritingEvalReport): WritingEvalReport {
  report.summary = {
    runs: report.runs.length,
    passed: report.runs.filter((run) => run.passed).length,
    usd: report.runs.reduce((sum, run) => sum + run.usd, 0),
  };
  return report;
}

/** What one case did across its repeats, reduced to numbers that compare. */
export interface CaseStats {
  caseId: string;
  runs: number;
  passRate: number;
  /** Mean value per measured check, across the runs that reached it. */
  means: Partial<Record<CheckName, number>>;
  /** How many runs failed each check. */
  failures: Partial<Record<CheckName, number>>;
  promptHashes: string[];
}

export function caseStats(report: WritingEvalReport): CaseStats[] {
  const byCase = new Map<string, WritingEvalRun[]>();
  for (const run of report.runs) byCase.set(run.caseId, [...(byCase.get(run.caseId) ?? []), run]);
  return [...byCase].map(([caseId, runs]) => {
    const values = new Map<CheckName, number[]>();
    const failures: Partial<Record<CheckName, number>> = {};
    for (const check of runs.flatMap((run) => run.checks)) {
      if (check.value !== undefined) values.set(check.name, [...(values.get(check.name) ?? []), check.value]);
      if (!check.passed) failures[check.name] = (failures[check.name] ?? 0) + 1;
    }
    const means: Partial<Record<CheckName, number>> = {};
    for (const [name, list] of values) means[name] = round(list.reduce((a, b) => a + b, 0) / list.length);
    return {
      caseId,
      runs: runs.length,
      passRate: round(runs.filter((run) => run.passed).length / runs.length),
      means,
      failures,
      promptHashes: [...new Set(runs.map((run) => run.promptHash))],
    };
  });
}

export interface CaseComparison {
  caseId: string;
  before?: CaseStats;
  after?: CaseStats;
  /** True when the prompt sent for this case differs between the two reports. */
  promptChanged: boolean;
  regressed: boolean;
}

/**
 * Case by case, against an earlier report. A regression is a lower pass rate;
 * the means are shown beside it because a ratio sliding from 1.0 to 0.6 is
 * worth seeing before it crosses a floor.
 */
export function compareReports(before: WritingEvalReport, after: WritingEvalReport): CaseComparison[] {
  const old = new Map(caseStats(before).map((stats) => [stats.caseId, stats]));
  const now = new Map(caseStats(after).map((stats) => [stats.caseId, stats]));
  const ids = [...new Set([...now.keys(), ...old.keys()])];
  return ids.map((caseId) => {
    const a = old.get(caseId);
    const b = now.get(caseId);
    return {
      caseId,
      before: a,
      after: b,
      promptChanged: !!a && !!b && a.promptHashes.join() !== b.promptHashes.join(),
      regressed: !!a && !!b && b.passRate < a.passRate,
    };
  });
}

/** The newest saved report in `dir`, the default baseline for the next eval. */
export function latestReport(dir: string): { path: string; report: WritingEvalReport } | null {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^writing-.*\.json$/.test(name)).sort();
  } catch {
    return null;
  }
  const name = names.at(-1);
  if (!name) return null;
  const path = join(dir, name);
  return { path, report: readReport(path) };
}

export function readReport(path: string): WritingEvalReport {
  const report = JSON.parse(readFileSync(path, "utf8")) as WritingEvalReport;
  if (report.kind !== "writing-eval") throw new Error(`${path} is not a writing eval report`);
  return report;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
