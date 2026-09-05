import { describe, expect, test } from '@jest/globals';
import { canonicalizeUrl, dedupeByUrl, isHttpUrl } from '../src/util/url.js';

describe('URL handling', () => {
  test('normalizes equivalent URLs while preserving meaningful query parameters', () => {
    expect(canonicalizeUrl(' http://www.Example.com/article/?b=2&utm_source=email&a=1#intro '))
      .toBe('https://example.com/article?a=1&b=2');
  });

  test('returns trimmed input when it is not a URL', () => {
    expect(canonicalizeUrl(' not a URL ')).toBe('not a URL');
  });

  test.each([
    ['https://example.com', true],
    ['http://example.com', true],
    ['file:///tmp/page.html', false],
    ['not a URL', false],
  ])('validates HTTP URL %s', (url, expected) => {
    expect(isHttpUrl(url)).toBe(expected);
  });

  test('deduplicates equivalent URLs and keeps the first item in order', () => {
    const first = { url: 'http://www.example.com/article/?utm_source=email', title: 'First' };
    const second = { url: 'https://example.com/other', title: 'Other' };
    const duplicate = { url: 'https://example.com/article#intro', title: 'Duplicate' };

    expect(dedupeByUrl([first, second, duplicate])).toEqual([first, second]);
  });
});
