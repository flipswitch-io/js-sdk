import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserCache } from '../src/browser-cache';

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

describe('BrowserCache', () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = createMockLocalStorage();
    vi.stubGlobal('window', { localStorage: mockStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isAvailable returns true when localStorage works', () => {
    const cache = new BrowserCache();
    expect(cache.isAvailable()).toBe(true);
  });

  it('isAvailable returns false when no window', () => {
    vi.unstubAllGlobals();
    const cache = new BrowserCache();
    expect(cache.isAvailable()).toBe(false);
  });

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
  });

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

  it('getMeta returns meta after set', () => {
    const cache = new BrowserCache();
    cache.set('flag', true);

    const meta = cache.getMeta();
    expect(meta).not.toBeNull();
    expect(meta!.lastUpdated).toBeTypeOf('number');
    expect(meta!.version).toBe(1);
  });

  it('getAge returns age in ms', () => {
    const cache = new BrowserCache();
    cache.set('flag', true);

    const age = cache.getAge('flag');
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(1000);
  });

  it('isStale returns true for missing flag', () => {
    const cache = new BrowserCache();
    expect(cache.isStale('missing', 5000)).toBe(true);
  });

  it('clear removes all flipswitch data', () => {
    const cache = new BrowserCache();
    cache.set('flag1', true);
    cache.set('flag2', false);

    mockStorage.setItem('other-app-key', 'some-value');

    cache.clear();

    expect(cache.get('flag1')).toBeNull();
    expect(cache.get('flag2')).toBeNull();
    expect(mockStorage.getItem('other-app-key')).toBe('some-value');
  });

  it('graceful fallback when storage null', () => {
    vi.unstubAllGlobals();
    const cache = new BrowserCache();

    expect(cache.get('x')).toBeNull();
    expect(cache.getAll().size).toBe(0);
    expect(cache.getMeta()).toBeNull();
    expect(cache.getAge('x')).toBeNull();
    expect(cache.isStale('x', 1000)).toBe(true);

    cache.set('x', 1);
    cache.setAll([{ key: 'y', value: 2 }]);
    cache.invalidate('x');
    cache.invalidate();
    cache.clear();
  });
});
