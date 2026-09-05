import { describe, expect, test } from '@jest/globals';
import { SourceRegistry } from '../src/agent/source-registry.js';

describe('SourceRegistry', () => {
  test('assigns stable citation IDs to canonical URLs', () => {
    const registry = new SourceRegistry();
    const first = registry.register({ url: 'http://www.example.com/a/?utm_source=email', title: 'A' });
    const duplicate = registry.register({ url: 'https://example.com/a#intro', title: 'A again' });
    const second = registry.register({ url: 'https://example.com/b', title: 'B' });

    expect(duplicate).toBe(first);
    expect([first.id, second.id]).toEqual(['S1', 'S2']);
    expect(registry.size).toBe(2);
    expect(registry.byId('S1')).toBe(first);
    expect(registry.byId('S99')).toBeUndefined();
  });

  test('only includes fetched sources in the read list', () => {
    const registry = new SourceRegistry();
    const first = registry.register({ url: 'https://example.com/a', title: 'A' });
    registry.register({ url: 'https://example.com/b', title: 'B' });

    expect(registry.read()).toEqual([]);
    registry.markRead('http://www.example.com/a/?utm_source=email');
    expect(registry.read()).toEqual([first]);
    expect(registry.markRead('https://example.com/unknown')).toBeUndefined();
    expect(registry.size).toBe(2);
  });
});
