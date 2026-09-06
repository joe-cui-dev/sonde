/**
 * Words for space-separated scripts, characters for CJK. A Chinese brief that
 * asks for 2000 字 is asking for two thousand characters, and splitting that
 * paragraph on whitespace would count the whole of it as a single word — the
 * one measure that would make every Chinese run look like a shortfall.
 */
// CJK punctuation, kana, ideographs, hangul, and fullwidth forms.
const CJK = /[\u3001-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uffef]/gu;

export function countWords(text: string): number {
  const characters = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, " ").trim();
  return characters + (rest ? rest.split(/\s+/u).length : 0);
}
