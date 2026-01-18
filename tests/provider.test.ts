import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlipswitchProvider } from '../src/provider';
import { FlagCache } from '../src/cache';
import type { FlagChangeEvent } from '../src/types';

describe('FlipswitchProvider', () => {
  const mockFetch = vi.fn();
  const defaultOptions = {
    baseUrl: 'https://api.flipswitch.dev',
    apiKey: 'test-api-key',
    enableRealtime: false, // Disable SSE for unit tests
    fetchImplementation: mockFetch,
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      expect(provider.status).toBe('READY');
    });

    it('should handle initialization failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const provider = new FlipswitchProvider(defaultOptions);

      await expect(provider.initialize()).rejects.toThrow();
      expect(provider.status).toBe('ERROR');
    });

    it('should accept 404 from configuration endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      expect(provider.status).toBe('READY');
    });
  });

  describe('flag resolution', () => {
    it('should resolve boolean flag', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // init
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            value: true,
            variant: 'on',
            reason: 'TARGETING_MATCH',
          }),
        });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      const result = await provider.resolveBooleanEvaluation(
        'dark-mode',
        false,
        { targetingKey: 'user-1' },
        console
      );

      expect(result.value).toBe(true);
      expect(result.variant).toBe('on');
      expect(result.reason).toBe('TARGETING_MATCH');
    });

    it('should resolve string flag', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            value: 'Welcome!',
            variant: 'greeting',
            reason: 'DEFAULT',
          }),
        });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      const result = await provider.resolveStringEvaluation(
        'welcome-message',
        'Hello',
        {},
        console
      );

      expect(result.value).toBe('Welcome!');
    });

    it('should resolve number flag', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            value: 42,
            variant: 'large',
            reason: 'TARGETING_MATCH',
          }),
        });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      const result = await provider.resolveNumberEvaluation(
        'max-items',
        10,
        {},
        console
      );

      expect(result.value).toBe(42);
    });

    it('should return default on 404', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      const result = await provider.resolveBooleanEvaluation(
        'nonexistent',
        true,
        {},
        console
      );

      expect(result.value).toBe(true);
      expect(result.errorCode).toBe('FLAG_NOT_FOUND');
    });

    it('should handle type mismatch', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            value: 'not-a-boolean',
          }),
        });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      const result = await provider.resolveBooleanEvaluation(
        'wrong-type',
        false,
        {},
        console
      );

      expect(result.value).toBe(false);
      expect(result.errorCode).toBe('TYPE_MISMATCH');
    });

    it('should include context in request', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ value: true }),
        });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      await provider.resolveBooleanEvaluation(
        'test-flag',
        false,
        {
          targetingKey: 'user-123',
          email: 'test@example.com',
          plan: 'premium',
        },
        console
      );

      const lastCall = mockFetch.mock.calls[1];
      const body = JSON.parse(lastCall[1].body);

      expect(body.context).toEqual({
        targetingKey: 'user-123',
        email: 'test@example.com',
        plan: 'premium',
      });
    });
  });

  describe('API key header', () => {
    it('should send X-API-Key header', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ value: true }),
        });

      const provider = new FlipswitchProvider(defaultOptions);
      await provider.initialize();

      await provider.resolveBooleanEvaluation('test', false, {}, console);

      const evalCall = mockFetch.mock.calls[1];
      expect(evalCall[1].headers['X-API-Key']).toBe('test-api-key');
    });
  });
});

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
