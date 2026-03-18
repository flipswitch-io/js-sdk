import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientProviderEvents } from '@openfeature/core';
import { FlipswitchWebProvider } from '../src/provider';
import type { SseConnectionStatus } from '@flipswitch-io/core';

describe('FlipswitchWebProvider', () => {
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

      const provider = new FlipswitchWebProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateFlag('test-flag', { targetingKey: 'user-1' });

      expect(capturedUrl).toBe('https://api.example.com/ofrep/v1/evaluate/flags/test-flag');
    });
  });

  describe('Polling Fallback', () => {
    it('should not be active initially', () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: true,
        enablePollingFallback: true,
        maxSseRetries: 3,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.isPollingActive()).toBe(false);

      provider.onClose();
    });
  });

  describe('Shutdown', () => {
    it('should clear state after shutdown', async () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        }),
      });

      await provider.onClose();

      expect(provider.status).toBe('NOT_READY');
      expect(provider.getSseStatus()).toBe('disconnected');
    });

    it('should be idempotent', async () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        }),
      });

      await provider.onClose();
      await provider.onClose();
    });
  });

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

      const provider = new FlipswitchWebProvider({
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

      const provider = new FlipswitchWebProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-Runtime']).toBeDefined();
      expect(capturedHeaders['X-Flipswitch-Runtime']).toMatch(/^node\/.+$/);
    });

    it('should set sse=false when realtime is disabled', async () => {
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchWebProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-Features']).toBe('sse=false');
    });
  });

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
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        }),
      });

      await provider.initialize({ targetingKey: 'user-1' });

      expect(provider.status).toBe('READY');
    });

    it('should throw on 401 invalid API key', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('OFREP init failed'));
        }
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        });
      });

      const provider = new FlipswitchWebProvider({
        apiKey: 'bad-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await expect(provider.initialize()).rejects.toThrow('Invalid API key');
      expect(provider.status).toBe('ERROR');
    });
  });

  describe('onContextChange', () => {
    it('should emit ConfigurationChanged event', async () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        }),
      });

      const handler = vi.fn();
      provider.events.addHandler(ClientProviderEvents.ConfigurationChanged, handler);

      await provider.onContextChange(
        { targetingKey: 'old-user' },
        { targetingKey: 'new-user' },
      );

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('Delegation to OFREP', () => {
    const createProvider = () => new FlipswitchWebProvider({
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
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      });

      provider.reconnectSse();
      expect(provider.getSseStatus()).toBe('disconnected');
    });

    it('getSseStatus returns disconnected when no SSE client', () => {
      const provider = new FlipswitchWebProvider({
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

  describe('Miscellaneous', () => {
    it('isOnline returns true by default', () => {
      const origNavigator = globalThis.navigator;
      vi.stubGlobal('navigator', undefined);

      try {
        const provider = new FlipswitchWebProvider({
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

    it('formatValue works', () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      expect(provider.formatValue(null)).toBe('null');
      expect(provider.formatValue('hello')).toBe('"hello"');
      expect(provider.formatValue(42)).toBe('42');
    });
  });

  describe('Event System', () => {
    it('on/off flagChange works', () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      const handler = vi.fn();
      const unsub = provider.on('flagChange', handler);

      // Unsubscribe
      unsub();
    });

    it('on/off connectionStatusChange works', () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      const handler = vi.fn();
      const unsub = provider.on('connectionStatusChange', handler);
      unsub();
    });

    it('on flagChange with specific key works', () => {
      const provider = new FlipswitchWebProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      const handler = vi.fn();
      const unsub = provider.on('flagChange', 'dark-mode', handler);
      unsub();
    });
  });
});
