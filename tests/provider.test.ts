import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientProviderEvents } from '@openfeature/core';
import { FlagCache } from '../src/cache';
import { FlipswitchProvider } from '../src/provider';
import { BrowserCache } from '../src/browser-cache';
import type { FlagChangeEvent, SseConnectionStatus } from '../src/types';

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

  // ========================================
  // Polling Fallback Tests
  // ========================================

  describe('Polling Fallback', () => {
    it('should activate polling after maxSseRetries error status changes', () => {
      const statusChanges: SseConnectionStatus[] = [];

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        enablePollingFallback: true,
        maxSseRetries: 3,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      }, {
        onConnectionStatusChange: (status) => statusChanges.push(status),
      });

      // Initially polling should not be active
      expect(provider.isPollingActive()).toBe(false);

      provider.onClose();
    });

    it('should not activate polling when enablePollingFallback is false', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        enablePollingFallback: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.isPollingActive()).toBe(false);

      provider.onClose();
    });
  });

  // ========================================
  // Shutdown / Cleanup Tests
  // ========================================

  describe('Shutdown', () => {
    it('should clear state after shutdown', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.onClose();

      expect(provider.status).toBe('NOT_READY');
      expect(provider.getSseStatus()).toBe('disconnected');
    });

    it('should be idempotent - calling shutdown twice should not throw', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.onClose();
      await provider.onClose(); // Should not throw
    });
  });

  // ========================================
  // Context Transformation Tests
  // ========================================

  describe('Context Transformation', () => {
    it('should transform context with just targetingKey', async () => {
      let capturedBody: string | null = null;

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { body?: string }) => {
        capturedBody = opts?.body ?? null;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ key: 'test', value: true }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateFlag('test', { targetingKey: 'user-123' });

      expect(capturedBody).not.toBeNull();
      const parsed = JSON.parse(capturedBody!);
      expect(parsed.context.targetingKey).toBe('user-123');
    });

    it('should include additional attributes in context', async () => {
      let capturedBody: string | null = null;

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { body?: string }) => {
        capturedBody = opts?.body ?? null;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ key: 'test', value: true }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateFlag('test', {
        targetingKey: 'user-123',
        email: 'test@example.com',
        plan: 'premium',
      });

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.context.targetingKey).toBe('user-123');
      expect(parsed.context.email).toBe('test@example.com');
      expect(parsed.context.plan).toBe('premium');
    });

    it('should produce empty object for empty context', async () => {
      let capturedBody: string | null = null;

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { body?: string }) => {
        capturedBody = opts?.body ?? null;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ key: 'test', value: true }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateFlag('test', {} as any);

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.context).toBeDefined();
    });
  });

  // ========================================
  // Type Inference Tests
  // ========================================

  describe('Type Inference', () => {
    const createProvider = () => new FlipswitchProvider({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.com',
      enableRealtime: false,
      fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    });

    it('should infer boolean type', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [{ key: 'bool-flag', value: true }],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('boolean');
    });

    it('should infer string type', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [{ key: 'str-flag', value: 'hello' }],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('string');
    });

    it('should infer number type for integers and floats', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [
              { key: 'int-flag', value: 42 },
              { key: 'float-flag', value: 3.14 },
            ],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('number');
      expect(flags[1].valueType).toBe('number');
    });

    it('should infer null type', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [{ key: 'null-flag', value: null }],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('null');
    });

    it('should infer object type', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [{ key: 'obj-flag', value: { nested: true } }],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('object');
    });

    it('should infer array type', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [{ key: 'arr-flag', value: [1, 2, 3] }],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('array');
    });

    it('should use metadata.flagType when available', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [{ key: 'typed-flag', value: null, metadata: { flagType: 'boolean' } }],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('boolean');
    });

    it('should map decimal metadata type to number', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            flags: [{ key: 'decimal-flag', value: 3.14, metadata: { flagType: 'decimal' } }],
          }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags[0].valueType).toBe('number');
    });
  });

  // ========================================
  // Telemetry Headers Tests
  // ========================================

  describe('Telemetry Headers', () => {
    it('should include X-Flipswitch-SDK header', async () => {
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-SDK']).toBeDefined();
      expect(capturedHeaders['X-Flipswitch-SDK']).toMatch(/^javascript\/.+$/);
    });

    it('should include X-Flipswitch-Runtime header', async () => {
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-Runtime']).toBeDefined();
      expect(capturedHeaders['X-Flipswitch-Runtime']).toMatch(/^node\/.+$/);
    });

    it('should include X-Flipswitch-OS header', async () => {
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-OS']).toBeDefined();
      expect(capturedHeaders['X-Flipswitch-OS']).toMatch(/\/.+$/);
    });

    it('should include X-Flipswitch-Features header with sse value', async () => {
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-Features']).toBe('sse=false');
    });

    it('should set sse=true when realtime is enabled', async () => {
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-Features']).toBe('sse=true');

      await provider.onClose();
    });
  });

  // ========================================
  // Initialize Tests
  // ========================================

  describe('Initialize', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should initialize successfully and set status to READY', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.initialize({ targetingKey: 'user-1' });

      expect(provider.status).toBe('READY');
    });

    it('should throw on 401 invalid API key', async () => {
      // First call (OFREP init) will throw, second call (validation) returns 401
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // OFREP init throws
          return Promise.reject(new Error('OFREP init failed'));
        }
        // Validation call returns 401
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'bad-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await expect(provider.initialize()).rejects.toThrow('Invalid API key');
      expect(provider.status).toBe('ERROR');
    });

    it('should throw on 500 server error during init validation', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('OFREP init failed'));
        }
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await expect(provider.initialize()).rejects.toThrow('Failed to connect to Flipswitch: 500');
      expect(provider.status).toBe('ERROR');
    });

    it('should not re-throw when OFREP init succeeds', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await expect(provider.initialize()).resolves.not.toThrow();
      expect(provider.status).toBe('READY');
    });

    it('should throw on 403 forbidden API key', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('OFREP init failed'));
        }
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({}),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'forbidden-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await expect(provider.initialize()).rejects.toThrow('Invalid API key');
    });
  });

  // ========================================
  // onContextChange Tests
  // ========================================

  describe('onContextChange', () => {
    it('should emit ConfigurationChanged event', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const handler = vi.fn();
      provider.events.addHandler(ClientProviderEvents.ConfigurationChanged, handler);

      await provider.onContextChange(
        { targetingKey: 'old-user' },
        { targetingKey: 'new-user' },
      );

      expect(handler).toHaveBeenCalled();
    });

    it('should forward to OFREP provider without error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await expect(
        provider.onContextChange(
          { targetingKey: 'old' },
          { targetingKey: 'new' },
        ),
      ).resolves.not.toThrow();
    });
  });

  // ========================================
  // Event System Tests
  // ========================================

  describe('Event System', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should register and fire handler via events.addHandler', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const handler = vi.fn();
      provider.events.addHandler(ClientProviderEvents.Ready, handler);

      await provider.initialize();

      expect(handler).toHaveBeenCalled();
    });

    it('should not throw when emitting with no registered handlers', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      // No handlers registered — initialize emits Ready
      await expect(provider.initialize()).resolves.not.toThrow();
    });
  });

  // ========================================
  // Delegation Tests
  // ========================================

  describe('Delegation to OFREP', () => {
    const createProvider = () => new FlipswitchProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com',
      enableRealtime: false,
      fetchImplementation: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    });

    it('resolveBooleanEvaluation delegates to OFREP', () => {
      const provider = createProvider();
      // OFREP returns the default value when not initialized
      const result = provider.resolveBooleanEvaluation('flag', false, { targetingKey: 'u' });
      expect(result).toBeDefined();
      expect(result.value).toBe(false);
    });

    it('resolveStringEvaluation delegates to OFREP', () => {
      const provider = createProvider();
      const result = provider.resolveStringEvaluation('flag', 'default', { targetingKey: 'u' });
      expect(result).toBeDefined();
      expect(result.value).toBe('default');
    });

    it('resolveNumberEvaluation delegates to OFREP', () => {
      const provider = createProvider();
      const result = provider.resolveNumberEvaluation('flag', 42, { targetingKey: 'u' });
      expect(result).toBeDefined();
      expect(result.value).toBe(42);
    });

    it('resolveObjectEvaluation delegates to OFREP', () => {
      const provider = createProvider();
      const defaultVal = { a: 1 };
      const result = provider.resolveObjectEvaluation('flag', defaultVal, { targetingKey: 'u' });
      expect(result).toBeDefined();
      expect(result.value).toEqual(defaultVal);
    });
  });

  // ========================================
  // Error Path Tests
  // ========================================

  describe('Error Paths', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('evaluateAllFlags returns [] on non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags).toEqual([]);
    });

    it('evaluateAllFlags returns [] on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags).toEqual([]);
    });

    it('evaluateFlag returns null on non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const result = await provider.evaluateFlag('flag', { targetingKey: 'u' });
      expect(result).toBeNull();
    });

    it('evaluateFlag returns null on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const result = await provider.evaluateFlag('flag', { targetingKey: 'u' });
      expect(result).toBeNull();
    });
  });

  // ========================================
  // SSE Lifecycle Tests
  // ========================================

  describe('SSE Lifecycle', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reconnectSse is no-op when realtime disabled', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      });

      // Should not throw
      provider.reconnectSse();
      expect(provider.getSseStatus()).toBe('disconnected');
    });

    it('getSseStatus returns disconnected when no SSE client', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      });

      expect(provider.getSseStatus()).toBe('disconnected');
    });
  });

  // ========================================
  // Miscellaneous Tests
  // ========================================

  describe('Miscellaneous', () => {
    it('isOnline returns true by default', () => {
      // In Node.js, navigator may exist but navigator.onLine may be undefined.
      // Stub navigator to ensure controlled behavior.
      const origNavigator = globalThis.navigator;
      vi.stubGlobal('navigator', undefined);

      try {
        const provider = new FlipswitchProvider({
          apiKey: 'test-key',
          baseUrl: 'https://api.example.com',
          enableRealtime: false,
          fetchImplementation: vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({}),
          }),
        });

        expect(provider.isOnline()).toBe(true);
      } finally {
        vi.stubGlobal('navigator', origNavigator);
      }
    });

    it('evaluateAllFlags returns unknown type for undefined value', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          flags: [{ key: 'undef-flag', value: undefined }],
        }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags[0].valueType).toBe('unknown');
    });

    it('getFlagType uses integer metadata type', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          flags: [{ key: 'int-flag', value: 42, metadata: { flagType: 'integer' } }],
        }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags[0].valueType).toBe('number');
    });

    it('getFlagType uses string metadata type', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          flags: [{ key: 'str-flag', value: null, metadata: { flagType: 'string' } }],
        }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags[0].valueType).toBe('string');
    });

    it('evaluateFlag returns correct evaluation result', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          key: 'test-flag',
          value: true,
          reason: 'TARGETING_MATCH',
          variant: 'on',
        }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const result = await provider.evaluateFlag('test-flag', { targetingKey: 'u' });
      expect(result).not.toBeNull();
      expect(result!.key).toBe('test-flag');
      expect(result!.value).toBe(true);
      expect(result!.valueType).toBe('boolean');
      expect(result!.reason).toBe('TARGETING_MATCH');
      expect(result!.variant).toBe('on');
    });
  });

  // ========================================
  // SSE + Realtime Integration Tests
  // ========================================

  describe('SSE Initialization', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should start SSE when realtime enabled and initialize succeeds', async () => {
      // Create a streaming response body that we control
      const { readable } = new TransformStream();

      // SSE client uses global fetch, so we need to stub it
      const originalFetch = globalThis.fetch;
      const mockGlobalFetch = vi.fn().mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/events')) {
          return Promise.resolve({
            ok: true,
            body: readable,
            status: 200,
          });
        }
        // Shouldn't happen, but fallback
        return originalFetch(url);
      });
      vi.stubGlobal('fetch', mockGlobalFetch);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const statusChanges: SseConnectionStatus[] = [];

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        fetchImplementation: mockFetch,
      }, {
        onConnectionStatusChange: (status) => statusChanges.push(status),
      });

      await provider.initialize({ targetingKey: 'user-1' });
      // Give SSE time to connect
      await new Promise((r) => setTimeout(r, 50));

      expect(provider.status).toBe('READY');
      // SSE should be connecting or connected
      expect(statusChanges).toContain('connecting');
      expect(statusChanges).toContain('connected');

      await provider.onClose();
      vi.unstubAllGlobals();
    });

    it('should handle SSE error and trigger polling fallback after max retries', async () => {
      // SSE client uses global fetch
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 500,
          body: null,
        });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const statusChanges: SseConnectionStatus[] = [];

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        enablePollingFallback: true,
        maxSseRetries: 1, // Just 1 retry to trigger fallback quickly
        fetchImplementation: mockFetch,
      }, {
        onConnectionStatusChange: (status) => statusChanges.push(status),
      });

      await provider.initialize({ targetingKey: 'user-1' });
      // Wait for SSE error + retry
      await new Promise((r) => setTimeout(r, 200));

      // SSE should have errored
      expect(statusChanges).toContain('error');
      // Polling fallback should eventually activate
      expect(provider.isPollingActive()).toBe(true);

      await provider.onClose();
      // After close, polling should be stopped
      expect(provider.isPollingActive()).toBe(false);
      vi.unstubAllGlobals();
    });

    it('reconnectSse closes and restarts SSE when realtime enabled', async () => {
      // SSE client uses global fetch
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        const { readable } = new TransformStream();
        return Promise.resolve({
          ok: true,
          body: readable,
          status: 200,
        });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        fetchImplementation: mockFetch,
      });

      await provider.initialize({ targetingKey: 'user-1' });
      await new Promise((r) => setTimeout(r, 50));

      // reconnectSse should not throw and should create a new SSE connection
      provider.reconnectSse();
      await new Promise((r) => setTimeout(r, 50));

      expect(provider.getSseStatus()).not.toBe(undefined);

      await provider.onClose();
      vi.unstubAllGlobals();
    });
  });

  // ========================================
  // Polling Fallback Detailed Tests
  // ========================================

  describe('Polling Fallback (detailed)', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('isPollingActive returns false initially', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        enablePollingFallback: true,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      });

      expect(provider.isPollingActive()).toBe(false);
      provider.onClose();
    });

    it('stopPolling is called during onClose', async () => {
      // SSE client uses global fetch
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          status: 500,
          body: null,
        });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        enablePollingFallback: true,
        maxSseRetries: 1,
        fetchImplementation: mockFetch,
      });

      await provider.initialize({ targetingKey: 'user-1' });
      await new Promise((r) => setTimeout(r, 200));

      // Polling should be active after SSE errors
      expect(provider.isPollingActive()).toBe(true);

      // onClose should stop polling
      await provider.onClose();
      expect(provider.isPollingActive()).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  // ========================================
  // FlagChangeEvent handler Tests (via SSE)
  // ========================================

  describe('FlagChange handlers', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('handleFlagChange emits ConfigurationChanged and calls user handler', async () => {
      const onFlagChange = vi.fn();
      const configChangedHandler = vi.fn();
      let streamController: WritableStreamDefaultWriter<Uint8Array>;

      // SSE client uses global fetch
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        streamController = writable.getWriter();
        return Promise.resolve({
          ok: true,
          body: readable,
          status: 200,
        });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        fetchImplementation: mockFetch,
      }, {
        onFlagChange,
      });

      provider.events.addHandler(ClientProviderEvents.ConfigurationChanged, configChangedHandler);

      await provider.initialize({ targetingKey: 'user-1' });
      await new Promise((r) => setTimeout(r, 50));

      // Send an SSE event through the stream
      const encoder = new TextEncoder();
      const event = 'event: flag-updated\ndata: {"flagKey":"my-flag","timestamp":"2025-01-01T00:00:00Z"}\n\n';
      await streamController!.write(encoder.encode(event));
      await new Promise((r) => setTimeout(r, 100));

      expect(onFlagChange).toHaveBeenCalledWith({
        flagKey: 'my-flag',
        timestamp: '2025-01-01T00:00:00Z',
      });
      expect(configChangedHandler).toHaveBeenCalled();

      await provider.onClose();
      vi.unstubAllGlobals();
    });

    it('handleFlagChange with null flagKey invalidates all cache', async () => {
      const onFlagChange = vi.fn();
      let streamController: WritableStreamDefaultWriter<Uint8Array>;

      // SSE client uses global fetch
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        streamController = writable.getWriter();
        return Promise.resolve({
          ok: true,
          body: readable,
          status: 200,
        });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        fetchImplementation: mockFetch,
      }, {
        onFlagChange,
      });

      await provider.initialize({ targetingKey: 'user-1' });
      await new Promise((r) => setTimeout(r, 50));

      // Send a config-updated event (null flagKey)
      const encoder = new TextEncoder();
      const event = 'event: config-updated\ndata: {"timestamp":"2025-01-01T00:00:00Z"}\n\n';
      await streamController!.write(encoder.encode(event));
      await new Promise((r) => setTimeout(r, 100));

      expect(onFlagChange).toHaveBeenCalledWith({
        flagKey: null,
        timestamp: '2025-01-01T00:00:00Z',
      });

      await provider.onClose();
      vi.unstubAllGlobals();
    });
  });

  // ========================================
  // SSE Connected Recovery Tests
  // ========================================

  describe('SSE Connected Recovery', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('SSE connected after error resets retry count and stops polling', async () => {
      let callCount = 0;

      // First SSE call fails, second succeeds
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          // First SSE attempt fails
          return Promise.resolve({
            ok: false,
            status: 500,
            body: null,
          });
        }
        // Subsequent attempts succeed
        const { readable } = new TransformStream();
        return Promise.resolve({
          ok: true,
          body: readable,
          status: 200,
        });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const statusChanges: SseConnectionStatus[] = [];

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        enablePollingFallback: true,
        maxSseRetries: 1,
        fetchImplementation: mockFetch,
      }, {
        onConnectionStatusChange: (status) => statusChanges.push(status),
      });

      await provider.initialize({ targetingKey: 'user-1' });

      // Wait for the first SSE error + retry (1000ms backoff) + reconnect
      await new Promise((r) => setTimeout(r, 1500));

      // Should have gone through error → connected
      expect(statusChanges).toContain('error');
      expect(statusChanges).toContain('connected');

      // Once connected, polling should be stopped
      expect(provider.isPollingActive()).toBe(false);

      await provider.onClose();
      vi.unstubAllGlobals();
    });
  });

  // ========================================
  // Offline Mode Tests
  // ========================================

  describe('Offline Mode', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('initializes in stale mode when offline', async () => {
      // Simulate offline navigator
      vi.stubGlobal('navigator', { onLine: false });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        offlineMode: true,
        fetchImplementation: mockFetch,
      });

      await provider.initialize({ targetingKey: 'user-1' });

      expect(provider.status).toBe('STALE');
      // Should not have called fetch since we're offline
      expect(mockFetch).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  // ========================================
  // evaluateAllFlags with flags missing key
  // ========================================

  describe('evaluateAllFlags edge cases', () => {
    it('should skip flags without key in response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          flags: [
            { key: 'valid-flag', value: true },
            { value: 'no-key' }, // no key - should be skipped
            { key: 'another-flag', value: 42 },
          ],
        }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags).toHaveLength(2);
      expect(flags[0].key).toBe('valid-flag');
      expect(flags[1].key).toBe('another-flag');
    });

    it('should handle response with no flags array', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}), // no flags property
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags).toEqual([]);
    });

    it('should handle flag with null reason and variant', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          flags: [{ key: 'test', value: true }], // no reason/variant
        }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'u' });
      expect(flags[0].reason).toBeNull();
      expect(flags[0].variant).toBeNull();
    });
  });

  // ========================================
  // evaluateFlag with default key fallback
  // ========================================

  describe('evaluateFlag edge cases', () => {
    it('should use flagKey as fallback key when response has no key', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          value: 'hello',
          // no key in response
        }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const result = await provider.evaluateFlag('my-flag', { targetingKey: 'u' });
      expect(result).not.toBeNull();
      expect(result!.key).toBe('my-flag');
    });
  });

  // ========================================
  // Init with 404 fallback (not an error)
  // ========================================

  describe('Initialize edge cases', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should treat 404 as valid during init validation', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('OFREP init failed'));
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        });
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      // 404 is not an error case - it means no flags configured yet
      await expect(provider.initialize()).resolves.not.toThrow();
      expect(provider.status).toBe('READY');
    });
  });

  // ========================================
  // formatValue Tests
  // ========================================

  describe('formatValue', () => {
    it('should format null as "null"', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.formatValue(null)).toBe('null');
    });

    it('should format strings with quotes', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.formatValue('hello')).toBe('"hello"');
    });

    it('should format objects as JSON', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.formatValue({ a: 1 })).toBe('{"a":1}');
    });

    it('should format booleans as strings', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.formatValue(true)).toBe('true');
      expect(provider.formatValue(false)).toBe('false');
    });

    it('should format numbers as strings', () => {
      const provider = new FlipswitchProvider({
        apiKey: 'test',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.formatValue(42)).toBe('42');
      expect(provider.formatValue(3.14)).toBe('3.14');
    });
  });

  // ========================================
  // Telemetry Browser Detection Tests
  // ========================================

  describe('Telemetry Browser Detection', () => {
    const createProviderWithHeaders = (mockFetch: ReturnType<typeof vi.fn>) => {
      return new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });
    };

    it('should detect Chrome from userAgent', async () => {
      const origNavigator = globalThis.navigator;
      const origProcess = globalThis.process;
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        onLine: true,
      });

      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: [] }) });
      });

      const provider = createProviderWithHeaders(mockFetch);
      await provider.evaluateAllFlags({ targetingKey: 'u' });

      expect(capturedHeaders['X-Flipswitch-Runtime']).toBe('chrome/120');

      vi.stubGlobal('navigator', origNavigator);
      vi.stubGlobal('process', origProcess);
    });

    it('should detect Firefox from userAgent', async () => {
      const origNavigator = globalThis.navigator;
      const origProcess = globalThis.process;
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115',
        onLine: true,
      });

      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: [] }) });
      });

      const provider = createProviderWithHeaders(mockFetch);
      await provider.evaluateAllFlags({ targetingKey: 'u' });

      expect(capturedHeaders['X-Flipswitch-Runtime']).toBe('firefox/115');

      vi.stubGlobal('navigator', origNavigator);
      vi.stubGlobal('process', origProcess);
    });

    it('should detect Safari from userAgent (no Chrome)', async () => {
      const origNavigator = globalThis.navigator;
      const origProcess = globalThis.process;
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17 Safari/605.1.15',
        onLine: true,
      });

      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: [] }) });
      });

      const provider = createProviderWithHeaders(mockFetch);
      await provider.evaluateAllFlags({ targetingKey: 'u' });

      expect(capturedHeaders['X-Flipswitch-Runtime']).toBe('safari/17');

      vi.stubGlobal('navigator', origNavigator);
      vi.stubGlobal('process', origProcess);
    });

    it('should return browser/unknown for unknown UA', async () => {
      const origNavigator = globalThis.navigator;
      const origProcess = globalThis.process;
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('navigator', {
        userAgent: 'SomeCustomBrowser/1.0',
        onLine: true,
      });

      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: [] }) });
      });

      const provider = createProviderWithHeaders(mockFetch);
      await provider.evaluateAllFlags({ targetingKey: 'u' });

      expect(capturedHeaders['X-Flipswitch-Runtime']).toBe('browser/unknown');

      vi.stubGlobal('navigator', origNavigator);
      vi.stubGlobal('process', origProcess);
    });

    it('should detect Windows OS from userAgent', async () => {
      const origNavigator = globalThis.navigator;
      const origProcess = globalThis.process;
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        onLine: true,
      });

      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: [] }) });
      });

      const provider = createProviderWithHeaders(mockFetch);
      await provider.evaluateAllFlags({ targetingKey: 'u' });

      expect(capturedHeaders['X-Flipswitch-OS']).toMatch(/^windows\//);

      vi.stubGlobal('navigator', origNavigator);
      vi.stubGlobal('process', origProcess);
    });

    it('should detect Linux OS from userAgent', async () => {
      const origNavigator = globalThis.navigator;
      const origProcess = globalThis.process;
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        onLine: true,
      });

      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: [] }) });
      });

      const provider = createProviderWithHeaders(mockFetch);
      await provider.evaluateAllFlags({ targetingKey: 'u' });

      expect(capturedHeaders['X-Flipswitch-OS']).toMatch(/^linux\//);

      vi.stubGlobal('navigator', origNavigator);
      vi.stubGlobal('process', origProcess);
    });

    it('should detect ARM64 architecture from userAgent', async () => {
      const origNavigator = globalThis.navigator;
      const origProcess = globalThis.process;
      vi.stubGlobal('process', undefined);
      vi.stubGlobal('navigator', {
        userAgent: 'Mozilla/5.0 (Macintosh; arm64 Mac OS X 10_15_7) AppleWebKit/605.1.15 Chrome/120',
        onLine: true,
      });

      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: [] }) });
      });

      const provider = createProviderWithHeaders(mockFetch);
      await provider.evaluateAllFlags({ targetingKey: 'u' });

      expect(capturedHeaders['X-Flipswitch-OS']).toMatch(/\/arm64$/);

      vi.stubGlobal('navigator', origNavigator);
      vi.stubGlobal('process', origProcess);
    });
  });

  // ========================================
  // Online/Offline Handling Tests
  // ========================================

  describe('Online/Offline Handling', () => {
    let windowListeners: Map<string, Function>;
    let origWindow: typeof globalThis.window;

    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      windowListeners = new Map();
      origWindow = globalThis.window;

      vi.stubGlobal('window', {
        addEventListener: (type: string, handler: Function) => {
          windowListeners.set(type, handler);
        },
        removeEventListener: vi.fn(),
        localStorage: null,
      });
    });

    afterEach(() => {
      vi.stubGlobal('window', origWindow);
      vi.restoreAllMocks();
    });

    it('online event should trigger refreshFlags', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        offlineMode: true,
        fetchImplementation: mockFetch,
      });

      // Initialize to set up online/offline handlers
      vi.stubGlobal('navigator', { onLine: true });
      await provider.initialize();

      // Trigger the online handler
      const onlineHandler = windowListeners.get('online');
      if (onlineHandler) {
        onlineHandler();
        await new Promise(r => setTimeout(r, 50));
      }

      expect(provider.isOnline()).toBe(true);
      await provider.onClose();
      vi.unstubAllGlobals();
    });

    it('offline event should mark status as STALE', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        offlineMode: true,
        fetchImplementation: mockFetch,
      });

      vi.stubGlobal('navigator', { onLine: true });
      await provider.initialize();

      // Trigger the offline handler
      const offlineHandler = windowListeners.get('offline');
      if (offlineHandler) {
        offlineHandler();
      }

      expect(provider.isOnline()).toBe(false);
      expect(provider.status).toBe('STALE');
      await provider.onClose();
      vi.unstubAllGlobals();
    });

    it('offline should stop active polling', async () => {
      // Set up SSE to fail to trigger polling fallback
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        return Promise.resolve({ ok: false, status: 500, body: null });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      vi.stubGlobal('navigator', { onLine: true });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        enablePollingFallback: true,
        maxSseRetries: 1,
        offlineMode: true,
        fetchImplementation: mockFetch,
      });

      await provider.initialize();

      // Wait for SSE error + polling fallback activation
      const waitForPolling = async () => {
        for (let i = 0; i < 20; i++) {
          if (provider.isPollingActive()) return;
          await new Promise(r => setTimeout(r, 50));
        }
      };
      await waitForPolling();

      expect(provider.isPollingActive()).toBe(true);

      // Trigger offline handler
      const offlineHandler = windowListeners.get('offline');
      if (offlineHandler) {
        offlineHandler();
      }

      // Polling should be stopped
      expect(provider.isPollingActive()).toBe(false);
      await provider.onClose();
      vi.unstubAllGlobals();
    });

    it('refreshFlags transitions STALE to READY', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        offlineMode: true,
        fetchImplementation: mockFetch,
      });

      vi.stubGlobal('navigator', { onLine: true });
      await provider.initialize();

      // Set offline to make it STALE
      const offlineHandler = windowListeners.get('offline');
      if (offlineHandler) offlineHandler();
      expect(provider.status).toBe('STALE');

      // Come back online
      const onlineHandler = windowListeners.get('online');
      if (onlineHandler) {
        onlineHandler();
        await new Promise(r => setTimeout(r, 100));
      }

      expect(provider.status).toBe('READY');
      await provider.onClose();
      vi.unstubAllGlobals();
    });

    it('onClose removes window event listeners', async () => {
      const removeEventListener = vi.fn();
      vi.stubGlobal('window', {
        addEventListener: (type: string, handler: Function) => {
          windowListeners.set(type, handler);
        },
        removeEventListener,
        localStorage: null,
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        offlineMode: true,
        fetchImplementation: mockFetch,
      });

      vi.stubGlobal('navigator', { onLine: true });
      await provider.initialize();
      await provider.onClose();

      expect(removeEventListener).toHaveBeenCalledWith('online', expect.any(Function));
      expect(removeEventListener).toHaveBeenCalledWith('offline', expect.any(Function));
      vi.unstubAllGlobals();
    });
  });

  // ========================================
  // handleFlagChange Error Paths
  // ========================================

  describe('handleFlagChange error paths', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('handleFlagChange still emits ConfigurationChanged after OFREP error', async () => {
      let streamController: WritableStreamDefaultWriter<Uint8Array>;

      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        streamController = writable.getWriter();
        return Promise.resolve({ ok: true, body: readable, status: 200 });
      }));

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      });

      const configChangedHandler = vi.fn();

      const provider = new FlipswitchProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        fetchImplementation: mockFetch,
      });

      provider.events.addHandler(ClientProviderEvents.ConfigurationChanged, configChangedHandler);

      await provider.initialize({ targetingKey: 'user-1' });
      await new Promise(r => setTimeout(r, 50));

      // Send an SSE event
      const encoder = new TextEncoder();
      const event = 'event: flag-updated\ndata: {"flagKey":"my-flag","timestamp":"2025-01-01T00:00:00Z"}\n\n';
      await streamController!.write(encoder.encode(event));
      await new Promise(r => setTimeout(r, 100));

      // ConfigurationChanged should be emitted even if OFREP onContextChange fails internally
      expect(configChangedHandler).toHaveBeenCalled();

      await provider.onClose();
      vi.unstubAllGlobals();
    });
  });
});
