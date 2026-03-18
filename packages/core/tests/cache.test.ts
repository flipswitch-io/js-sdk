import { describe, it, expect } from 'vitest';
import { FlagCache } from '../src/cache';
import type { FlagChangeEvent } from '../src/types';

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
