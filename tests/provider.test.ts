import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlagCache } from '../src/cache';
import { FlipswitchProvider } from '../src/provider';
import type { FlagChangeEvent } from '../src/types';

// Note: Most FlipswitchProvider tests are skipped because the provider wraps
// OFREPWebProvider which has its own internal HTTP handling that's difficult
// to mock. The provider is effectively tested through the OFREP provider's
// test suite. We focus on testing our custom additions (FlagCache, SSE) and
// critical path validation.

describe('FlagCache', () => {
  it('should store and retrieve values', () => {
    const cache = new FlagCache();
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');
  });

  it('should return undefined for missing keys', () => {
    const cache = new FlagCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('should invalidate specific key', () => {
    const cache = new FlagCache();
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');

    cache.invalidate('key1');

    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBe('value2');
  });

  it('should invalidate all keys', () => {
    const cache = new FlagCache();
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');

    cache.invalidate();

    expect(cache.get('key1')).toBeUndefined();
    expect(cache.get('key2')).toBeUndefined();
  });

  it('should handle flag change event with specific key', () => {
    const cache = new FlagCache();
    cache.set('flag-1', true);
    cache.set('flag-2', false);

    const event: FlagChangeEvent = {
      environmentId: 1,
      flagKey: 'flag-1',
      timestamp: new Date().toISOString(),
    };

    cache.handleFlagChange(event);

    expect(cache.get('flag-1')).toBeUndefined();
    expect(cache.get('flag-2')).toBe(false);
  });

  it('should handle flag change event with null key (bulk)', () => {
    const cache = new FlagCache();
    cache.set('flag-1', true);
    cache.set('flag-2', false);

    const event: FlagChangeEvent = {
      environmentId: 1,
      flagKey: null,
      timestamp: new Date().toISOString(),
    };

    cache.handleFlagChange(event);

    expect(cache.get('flag-1')).toBeUndefined();
    expect(cache.get('flag-2')).toBeUndefined();
  });

  it('should expire values after TTL', async () => {
    const cache = new FlagCache(50); // 50ms TTL
    cache.set('key', 'value');

    expect(cache.get('key')).toBe('value');

    await new Promise(resolve => setTimeout(resolve, 60));

    expect(cache.get('key')).toBeUndefined();
  });
});

describe('FlipswitchProvider', () => {
  describe('URL Path', () => {
    it('should use correct OFREP path without duplication', async () => {
      let capturedUrl: string | null = null;

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ key: 'test-flag', value: true }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      // Trigger a flag evaluation via the direct HTTP method
      await provider.evaluateFlag('test-flag', { targetingKey: 'user-1' });

      // Verify the URL is correct (no duplicated /ofrep/v1)
      expect(capturedUrl).toBe('https://api.example.com/ofrep/v1/evaluate/flags/test-flag');
    });
  });
});
