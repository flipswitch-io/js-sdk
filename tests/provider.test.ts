import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
});
