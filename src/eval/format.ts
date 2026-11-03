import { usd, type Logger } from "../util/log.js";
import type { CheckResult } from "./writing-checks.js";
import { caseStats, type CaseComparison, type WritingEvalReport, type WritingEvalRun } from "./writing-eval.js";

type Colors = Logger["c"];

/** One line per run as it finishes; a failing check carries its detail, a passing one its number. */
export function formatRun(run: WritingEvalRun, c: Colors): string {
  const mark = run.passed ? c.green("✓") : c.red("✗");
  const checks = run.checks
    .filter((check) => check.name !== "complete" || !check.passed)
    .map((check) => (check.passed ? c.dim(brief(check)) : c.red(`${check.name}: ${check.detail}`)))
    .join(c.dim(" · "));
  return `${mark} ${run.caseId} #${run.attempt}  ${checks}  ${c.dim(`${usd(run.usd)} · ${run.runId}`)}`;
}

function brief(check: CheckResult): string {
  return check.value === undefined ? check.name : `${check.name} ${check.value}`;
}

/** Per case, across repeats: the table read after the run, and the one compared next time. */
export function formatSummary(report: WritingEvalReport, c: Colors): string {
  const lines = caseStats(report).map((stats) => {
    const means = Object.entries(stats.means).map(([name, value]) => `${name} ${value}`).join(" · ");
    const rate = `${Math.round(stats.passRate * 100)}%`.padStart(4);
    return `  ${stats.caseId.padEnd(24)} ${stats.passRate === 1 ? c.green(rate) : c.red(rate)}  ${c.dim(means)}`;
  });
  const { runs, passed, usd: spent } = report.summary;
  return [
    ...lines,
    "",
    `${passed}/${runs} runs passed · ${usd(spent)} · ${report.model} (${report.reasoningEffort})`,
  ].join("\n");
}

export function formatComparison(rows: CaseComparison[], baseline: string, c: Colors): string {
  const lines = rows.map(({ caseId, before, after, promptChanged, regressed }) => {
    if (!before) return `  ${caseId.padEnd(24)} ${c.dim("new case")}`;
    if (!after) return `  ${caseId.padEnd(24)} ${c.dim("not run this time")}`;
    const rate = `pass ${pct(before.passRate)} → ${pct(after.passRate)}`;
    const verdict = regressed
      ? c.red(`${rate}  regressed`)
      : after.passRate > before.passRate
        ? c.green(`${rate}  improved`)
        : rate;
    const moved = Object.keys({ ...before.means, ...after.means })
      .map((name) => {
        const a = before.means[name as keyof typeof before.means];
        const b = after.means[name as keyof typeof after.means];
        return a === b ? "" : `${name} ${a ?? "–"} → ${b ?? "–"}`;
      })
      .filter(Boolean)
      .join(" · ");
    // Unchanged prompt, moved numbers: that movement is the model's variance, not the change.
    const prompt = promptChanged ? c.yellow("prompt changed") : c.dim("same prompt");
    return `  ${caseId.padEnd(24)} ${verdict}  ${prompt}${moved ? c.dim(`  ${moved}`) : ""}`;
  });
  return [`Compared with ${baseline}`, ...lines].join("\n");
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
