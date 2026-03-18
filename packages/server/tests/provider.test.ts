import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlipswitchServerProvider } from '../src/provider';

describe('FlipswitchServerProvider', () => {
  describe('Initialize', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should initialize successfully', async () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        }),
      });

      await provider.initialize();

      // Server provider doesn't expose status, but shouldn't throw
    });

    it('should throw on 401 invalid API key', async () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'bad-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({}),
        }),
      });

      await expect(provider.initialize()).rejects.toThrow('Invalid API key');
    });

    it('should throw on 403 forbidden', async () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'bad-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: () => Promise.resolve({}),
        }),
      });

      await expect(provider.initialize()).rejects.toThrow('Invalid API key');
    });

    it('should throw on 500 server error', async () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        }),
      });

      await expect(provider.initialize()).rejects.toThrow('Failed to connect to Flipswitch: 500');
    });
  });

  describe('Shutdown', () => {
    it('should clean up on close', async () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        }),
      });

      await provider.onClose();
      expect(provider.getSseStatus()).toBe('disconnected');
    });

    it('should be idempotent', async () => {
      const provider = new FlipswitchServerProvider({
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

  describe('Direct Flag Evaluation', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('evaluateAllFlags works', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          flags: [{ key: 'flag-1', value: true }],
        }),
      });

      const provider = new FlipswitchServerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags).toHaveLength(1);
      expect(flags[0].key).toBe('flag-1');
    });

    it('evaluateFlag works', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ key: 'my-flag', value: 'hello' }),
      });

      const provider = new FlipswitchServerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      const flag = await provider.evaluateFlag('my-flag', { targetingKey: 'user-1' });
      expect(flag).not.toBeNull();
      expect(flag!.key).toBe('my-flag');
      expect(flag!.value).toBe('hello');
    });

    it('evaluateAllFlags returns [] on error', async () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockRejectedValue(new Error('Network error')),
      });

      const flags = await provider.evaluateAllFlags({ targetingKey: 'user-1' });
      expect(flags).toEqual([]);
    });
  });

  describe('Telemetry Headers', () => {
    it('should include telemetry headers in requests', async () => {
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((_url: string, opts: { headers?: Record<string, string> }) => {
        capturedHeaders = opts?.headers ?? {};
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: [] }),
        });
      });

      const provider = new FlipswitchServerProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: mockFetch,
      });

      await provider.evaluateAllFlags({ targetingKey: 'user-1' });

      expect(capturedHeaders['X-Flipswitch-SDK']).toMatch(/^javascript\/.+$/);
      expect(capturedHeaders['X-Flipswitch-Runtime']).toMatch(/^node\/.+$/);
      expect(capturedHeaders['X-Flipswitch-OS']).toBeDefined();
      expect(capturedHeaders['X-Flipswitch-Features']).toBe('sse=false');
    });
  });

  describe('SSE Lifecycle', () => {
    it('getSseStatus returns disconnected when no SSE client', () => {
      const provider = new FlipswitchServerProvider({
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

    it('reconnectSse is no-op when realtime disabled', () => {
      const provider = new FlipswitchServerProvider({
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

    it('isPollingActive returns false initially', () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        }),
      });

      expect(provider.isPollingActive()).toBe(false);
    });
  });

  describe('Event System', () => {
    it('on/off flagChange works', () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      const handler = vi.fn();
      const unsub = provider.on('flagChange', handler);
      unsub();
    });

    it('on/off connectionStatusChange works', () => {
      const provider = new FlipswitchServerProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
        enableRealtime: false,
        fetchImplementation: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
      });

      const handler = vi.fn();
      const unsub = provider.on('connectionStatusChange', handler);
      unsub();
    });
  });
});
