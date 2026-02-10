import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserCache } from '../src/browser-cache';

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

function createMockLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BrowserCache', () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = createMockLocalStorage();
    vi.stubGlobal('window', { localStorage: mockStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- isAvailable ---

  it('isAvailable returns true when localStorage works', () => {
    const cache = new BrowserCache();
    expect(cache.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no window', () => {
    vi.unstubAllGlobals(); // remove window stub
    const cache = new BrowserCache();
    expect(cache.isAvailable()).toBe(false);
  });

  // --- get / set ---

  it('get returns null for missing key', () => {
    const cache = new BrowserCache();
    expect(cache.get('missing')).toBeNull();
  });

  it('get returns cached flag after set', () => {
    const cache = new BrowserCache();
    cache.set('my-flag', true);

    const result = cache.get('my-flag');
    expect(result).not.toBeNull();
    expect(result!.value).toBe(true);
    expect(result!.timestamp).toBeTypeOf('number');
  });

  it('set stores variant and reason', () => {
    const cache = new BrowserCache();
    cache.set('flag', 'val', 'v1', 'DEFAULT');

    const result = cache.get('flag');
    expect(result).not.toBeNull();
    expect(result!.value).toBe('val');
    expect(result!.variant).toBe('v1');
    expect(result!.reason).toBe('DEFAULT');
  });

  // --- setAll / getAll ---

  it('setAll batch stores multiple flags', () => {
    const cache = new BrowserCache();
    cache.setAll([
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
    ]);

    expect(cache.get('a')!.value).toBe(1);
    expect(cache.get('b')!.value).toBe(2);
  });

  it('getAll returns all cached flags', () => {
    const cache = new BrowserCache();
    cache.set('x', 10);
    cache.set('y', 20);
    cache.set('z', 30);

    const all = cache.getAll();
    expect(all.size).toBe(3);
    expect(all.get('x')!.value).toBe(10);
    expect(all.get('y')!.value).toBe(20);
    expect(all.get('z')!.value).toBe(30);
  });

  it('getAll returns empty map when nothing cached', () => {
    const cache = new BrowserCache();
    const all = cache.getAll();
    expect(all.size).toBe(0);
  });

  // --- invalidate ---

  it('invalidate(key) removes specific flag', () => {
    const cache = new BrowserCache();
    cache.set('a', 1);
    cache.set('b', 2);

    cache.invalidate('a');

    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).not.toBeNull();
  });

  it('invalidate() removes all flags', () => {
    const cache = new BrowserCache();
    cache.set('a', 1);
    cache.set('b', 2);

    cache.invalidate();

    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });

  // --- getMeta ---

  it('getMeta returns null when no meta', () => {
    // Fresh cache with no sets — but meta key doesn't exist
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { localStorage: createMockLocalStorage() });
    const cache = new BrowserCache();
    expect(cache.getMeta()).toBeNull();
  });

  it('getMeta returns meta after set', () => {
    const cache = new BrowserCache();
    cache.set('flag', true);

    const meta = cache.getMeta();
    expect(meta).not.toBeNull();
    expect(meta!.lastUpdated).toBeTypeOf('number');
    expect(meta!.version).toBe(1);
  });

  // --- getAge ---

  it('getAge returns null for missing flag', () => {
    const cache = new BrowserCache();
    expect(cache.getAge('missing')).toBeNull();
  });

  it('getAge returns age in ms', () => {
    const cache = new BrowserCache();
    cache.set('flag', true);

    const age = cache.getAge('flag');
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(1000); // should be near-instant
  });

  // --- isStale ---

  it('isStale returns true for missing flag', () => {
    const cache = new BrowserCache();
    expect(cache.isStale('missing', 5000)).toBe(true);
  });

  it('isStale returns false for fresh flag', () => {
    const cache = new BrowserCache();
    cache.set('flag', true);
    expect(cache.isStale('flag', 60000)).toBe(false);
  });

  it('isStale returns true for old flag', () => {
    const cache = new BrowserCache();

    // Manually insert an entry with an old timestamp
    const cacheKey = 'flipswitch:flags:old-flag';
    mockStorage.setItem(cacheKey, JSON.stringify({
      value: true,
      timestamp: Date.now() - 10000, // 10 seconds ago
    }));

    expect(cache.isStale('old-flag', 5000)).toBe(true);
  });

  // --- clear ---

  it('clear removes all flipswitch data', () => {
    const cache = new BrowserCache();
    cache.set('flag1', true);
    cache.set('flag2', false);

    // Add a non-flipswitch key
    mockStorage.setItem('other-app-key', 'some-value');

    cache.clear();

    // Flipswitch keys should be gone
    expect(cache.get('flag1')).toBeNull();
    expect(cache.get('flag2')).toBeNull();
    expect(cache.getMeta()).toBeNull();

    // Non-flipswitch key should remain
    expect(mockStorage.getItem('other-app-key')).toBe('some-value');
  });

  // --- localStorage unavailable ---

  it('isAvailable returns false when setItem throws', () => {
    vi.unstubAllGlobals();
    const throwingStorage = createMockLocalStorage();
    throwingStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    vi.stubGlobal('window', { localStorage: throwingStorage });

    const cache = new BrowserCache();
    expect(cache.isAvailable()).toBe(false);
  });

  // --- invalid JSON in cache ---

  it('get returns null for invalid JSON in cache', () => {
    mockStorage.setItem('flipswitch:flags:bad', 'not-valid-json{{{');
    const cache = new BrowserCache();
    expect(cache.get('bad')).toBeNull();
  });

  it('getMeta returns null for invalid JSON in meta key', () => {
    mockStorage.setItem('flipswitch:meta', '{broken json!!!');
    const cache = new BrowserCache();
    expect(cache.getMeta()).toBeNull();
  });

  // --- graceful fallback when storage is null ---

  it('graceful fallback when storage null', () => {
    vi.unstubAllGlobals(); // no window
    const cache = new BrowserCache();

    // None of these should throw
    expect(cache.get('x')).toBeNull();
    expect(cache.getAll().size).toBe(0);
    expect(cache.getMeta()).toBeNull();
    expect(cache.getAge('x')).toBeNull();
    expect(cache.isStale('x', 1000)).toBe(true);

    // These should be no-ops
    cache.set('x', 1);
    cache.setAll([{ key: 'y', value: 2 }]);
    cache.invalidate('x');
    cache.invalidate();
    cache.clear();
  });
});
