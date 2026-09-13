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
