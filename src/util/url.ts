const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^mc_/i,
  /^pk_/i,
  /^hsa_/i,
  /^_hs/i,
  /^(fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|twclid)$/i,
  /^(ref|ref_src|referrer|source|src)$/i,
  /^(spm|scm|share_source|share_medium)$/i,
];

/**
 * Canonicalize a URL so the same page is never fetched (or paid for) twice.
 * Returns the input untouched if it is not parseable.
 */
export function canonicalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return input.trim();
  }

  if (u.protocol === "http:") u.protocol = "https:";
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  ) {
    u.port = "";
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of u.searchParams) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [key, value] of kept) u.searchParams.append(key, value);

  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}

export function isHttpUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function hostOf(input: string): string {
  try {
    return new URL(input).hostname.replace(/^www\./, "");
  } catch {
    return input;
  }
}

/** Dedupe by canonical URL, preserving first-seen order. */
export function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = canonicalizeUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
