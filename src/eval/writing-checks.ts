import type { WriteMode } from "../types.js";
import { countWords, shortfallTolerance } from "../writing/length.js";

/**
 * Checks a model is not asked to run: each one reads the prose a writing run
 * returned and measures one requirement the workflow states — so a prompt
 * change can be judged by numbers that moved, not by rereading every piece.
 * They are proxies. A pass says nothing about whether the prose is good.
 */
export type CheckName = "complete" | "length" | "echo" | "commentary" | "mentions";

export interface CheckResult {
  name: CheckName;
  passed: boolean;
  /** The measurement the verdict came from, where there is one to compare across runs. */
  value?: number;
  detail: string;
}

/** A run that did not finish has nothing else worth measuring against it. */
export function checkComplete(complete: boolean, text: string | null): CheckResult {
  const passed = complete && !!text?.trim();
  return {
    name: "complete",
    passed,
    detail: passed ? "finished with prose" : text?.trim() ? "partial prose" : "no prose",
  };
}

/**
 * The same margins `runWrite` warns at, so the eval fails exactly where a user
 * would have been told the prose came back short. The value is the ratio, which
 * shows drift long before it crosses the line.
 */
export function checkLength(mode: WriteMode, text: string, target: number): CheckResult {
  const written = countWords(text);
  const ratio = written / target;
  const floor = shortfallTolerance(mode);
  return {
    name: "length",
    passed: ratio >= floor,
    value: round(ratio),
    detail: `${written.toLocaleString()} of ${target.toLocaleString()} (${round(ratio)}×, floor ${floor}×)`,
  };
}

/**
 * Units long enough that a match is copied text rather than a shared phrase:
 * eight CJK characters, or eight words. A name, a set phrase, or a line of
 * dialogue the brief asked to be echoed rarely runs that long.
 */
const SHINGLE = 8;

/** More than this share of the new prose found verbatim in the draft is a recap. */
const MAX_ECHO = 0.1;

/**
 * How much of the returned prose repeats the draft. Continue and expand return
 * the new writing alone, so prose that restates where the draft left off — or
 * hands the draft back with a passage changed — is the failure this measures.
 */
export function checkEcho(draft: string, text: string): CheckResult {
  const source = units(draft);
  const output = units(text);
  const seen = new Set<string>();
  for (let i = 0; i + SHINGLE <= source.length; i += 1) {
    seen.add(source.slice(i, i + SHINGLE).join(" "));
  }
  const copied = new Array<boolean>(output.length).fill(false);
  for (let i = 0; i + SHINGLE <= output.length; i += 1) {
    if (seen.has(output.slice(i, i + SHINGLE).join(" "))) copied.fill(true, i, i + SHINGLE);
  }
  let covered = 0;
  let longest = 0;
  let run = 0;
  for (const unit of copied) {
    run = unit ? run + 1 : 0;
    if (unit) covered += 1;
    longest = Math.max(longest, run);
  }
  const ratio = output.length ? covered / output.length : 0;
  return {
    name: "echo",
    passed: ratio <= MAX_ECHO,
    value: round(ratio),
    detail: `${Math.round(ratio * 100)}% repeats the draft (longest copied run ${longest} units, limit ${MAX_ECHO * 100}%)`,
  };
}

// Ideographs, kana and hangul one unit each; CJK punctuation is not a unit.
const CJK_UNIT = "[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff]";
const UNIT = new RegExp(`${CJK_UNIT}|(?:(?!${CJK_UNIT})[\\p{L}\\p{N}])+`, "gu");

/** Comparable tokens: punctuation, spacing and case are not what makes text a copy. */
function units(text: string): string[] {
  return (text.match(UNIT) ?? []).map((unit) => unit.toLowerCase());
}

/**
 * Talk about the writing rather than the writing itself — the prompt forbids
 * it in every mode, and it is what a model falls back on when it treats the
 * run as a chat. Anchored to where it shows up: the opening line, the closing
 * lines, or a label line standing on its own.
 */
const COMMENTARY: Array<{ kind: string; where: "start" | "end" | "line"; pattern: RegExp }> = [
  // Narrow on purpose: "Sure enough", "这是一个寒冷的早晨" and a closing line
  // of dialogue are prose, and a check that fires on prose gets ignored.
  {
    kind: "preamble",
    where: "start",
    pattern: /^(?:(?:sure|certainly|of course|okay)[,!.]\s*(?:here|below|i\b)|here(?:'s| is| are) (?:the|your|a|an) (?:continuation|expanded|piece|passage|draft|story)|below is|i(?:'ve| have) (?:written|continued|expanded))/i,
  },
  { kind: "preamble", where: "start", pattern: /^(?:好的[，,。！!]|当然[，,]?(?:以下|下面)|以下是|下面是|我(?:为你|为您|已经?)(?:写|续写|扩写|展开))/ },
  {
    kind: "sign-off",
    where: "end",
    pattern: /\b(?:i hope (?:this|you enjoy)|let me know if|feel free to (?:ask|let)|would you like me to|word count:)/i,
  },
  {
    kind: "sign-off",
    where: "end",
    pattern: /(?:希望(?:这|以上)[^。\n]{0,12}(?:喜欢|帮助|满意|符合)|如(?:果)?(?:您|你)?(?:需要|有需要)[^。\n]{0,10}(?:调整|修改|继续)|字数[:：约]|全文约\s*\d)/,
  },
  {
    kind: "label",
    where: "line",
    pattern: /^[#>*\s]*(?:brief|draft|continuation|expanded passage|续写|扩写|正文|续文)\s*[:：]?[*\s]*$/im,
  },
];

/** Opening and closing windows, in characters: commentary sits at the seams. */
const EDGE = 200;

export function checkCommentary(text: string): CheckResult {
  const trimmed = text.trim();
  const windows = {
    start: trimmed.split("\n", 1)[0] ?? "",
    end: trimmed.slice(-EDGE),
    line: trimmed,
  };
  const found = COMMENTARY.flatMap(({ kind, where, pattern }) => {
    const match = windows[where].match(pattern);
    return match ? [`${kind}: "${match[0].trim().slice(0, 40)}"`] : [];
  });
  return {
    name: "commentary",
    passed: found.length === 0,
    value: found.length,
    detail: found.length ? found.join("; ") : "none found",
  };
}

/**
 * A stand-in for the brief's own requirements: the terms a case expects the
 * prose to contain. Crude on purpose — whether a requirement was honoured well
 * is a judgement, but whether it was mentioned at all is a fact.
 */
export function checkMentions(text: string, terms: string[]): CheckResult {
  const haystack = text.toLowerCase();
  const missing = terms.filter((term) => !haystack.includes(term.toLowerCase()));
  return {
    name: "mentions",
    passed: missing.length === 0,
    value: terms.length - missing.length,
    detail: missing.length ? `missing ${missing.map((m) => `"${m}"`).join(", ")}` : `all ${terms.length} present`,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
