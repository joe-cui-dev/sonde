import type { WriteMode } from "../types.js";

/**
* Words for space-separated scripts, characters for CJK. A brief asking for
* 2000 字 wants two thousand characters, and splitting that on whitespace would
* count the paragraph as one word — making every Chinese run look short.
*/
// CJK punctuation, kana, ideographs, hangul, and fullwidth forms.
const CJK = /[\u3001-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uffef]/gu;

export function countWords(text: string): number {
  const characters = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, " ").trim();
  return characters + (rest ? rest.split(/\s+/u).length : 0);
}

/** The count is an estimate, so only a miss wide enough to be real is worth reporting. */
const SHORTFALL_TOLERANCE = 0.9;

/**
 * Under new and continue the count is a soft target, so only order-of-magnitude
 * misses are worth naming — a piece that stopped in its first paragraph, or a
 * model that declined the brief. A warning that is noise is one nobody reads.
 */
const SOFT_TARGET_TOLERANCE = 0.5;

/** The share of its count a mode's prose may fall to before it is a shortfall. */
export function shortfallTolerance(mode: WriteMode): number {
  return mode === "expand" ? SHORTFALL_TOLERANCE : SOFT_TARGET_TOLERANCE;
}
