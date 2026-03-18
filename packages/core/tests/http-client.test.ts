import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlipswitchHttpClient, transformContext, inferType, getFlagType, formatValue } from '../src/http-client';

describe('transformContext', () => {
  it('should transform context with just targetingKey', () => {
    const result = transformContext({ targetingKey: 'user-123' });
    expect(result.targetingKey).toBe('user-123');
  });

  it('should include additional attributes', () => {
    const result = transformContext({
      targetingKey: 'user-123',
      email: 'test@example.com',
      plan: 'premium',
    });
    expect(result.targetingKey).toBe('user-123');
    expect(result.email).toBe('test@example.com');
    expect(result.plan).toBe('premium');
  });

  it('should produce empty object for empty context', () => {
    const result = transformContext({});
    expect(result).toBeDefined();
  });
});

describe('inferType', () => {
  it('should infer boolean', () => expect(inferType(true)).toBe('boolean'));
  it('should infer string', () => expect(inferType('hello')).toBe('string'));
  it('should infer number', () => expect(inferType(42)).toBe('number'));
  it('should infer null', () => expect(inferType(null)).toBe('null'));
  it('should infer array', () => expect(inferType([1, 2])).toBe('array'));
  it('should infer object', () => expect(inferType({ a: 1 })).toBe('object'));
  it('should infer unknown for undefined', () => expect(inferType(undefined)).toBe('unknown'));
});

describe('getFlagType', () => {
  it('should use metadata.flagType when available', () => {
    expect(getFlagType({ value: null, metadata: { flagType: 'boolean' } })).toBe('boolean');
  });

  it('should map decimal to number', () => {
    expect(getFlagType({ value: 3.14, metadata: { flagType: 'decimal' } })).toBe('number');
  });

  it('should map integer to number', () => {
    expect(getFlagType({ value: 42, metadata: { flagType: 'integer' } })).toBe('number');
  });

  it('should fall back to inferring from value', () => {
    expect(getFlagType({ value: true })).toBe('boolean');
    expect(getFlagType({ value: 'str' })).toBe('string');
  });
});

describe('formatValue', () => {
  it('should format null', () => expect(formatValue(null)).toBe('null'));
  it('should format string', () => expect(formatValue('hello')).toBe('"hello"'));
  it('should format number', () => expect(formatValue(42)).toBe('42'));
  it('should format boolean', () => expect(formatValue(true)).toBe('true'));
  it('should format object', () => expect(formatValue({ a: 1 })).toBe('{"a":1}'));
});

describe('FlipswitchHttpClient', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('evaluateAllFlags returns flags on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        flags: [
          { key: 'flag-1', value: true },
          { key: 'flag-2', value: 'hello' },
        ],
      }),
    });

    const client = new FlipswitchHttpClient(
      'https://api.example.com',
      'test-key',
      mockFetch,
      {},
    );

    const flags = await client.evaluateAllFlags({ targetingKey: 'user-1' });
    expect(flags).toHaveLength(2);
    expect(flags[0].key).toBe('flag-1');
    expect(flags[0].valueType).toBe('boolean');
    expect(flags[1].key).toBe('flag-2');
    expect(flags[1].valueType).toBe('string');
  });

  it('evaluateAllFlags returns [] on error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const client = new FlipswitchHttpClient('https://api.example.com', 'test-key', mockFetch, {});
    const flags = await client.evaluateAllFlags({ targetingKey: 'user-1' });
    expect(flags).toEqual([]);
  });

  it('evaluateAllFlags returns [] on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const client = new FlipswitchHttpClient('https://api.example.com', 'test-key', mockFetch, {});
    const flags = await client.evaluateAllFlags({ targetingKey: 'user-1' });
    expect(flags).toEqual([]);
  });

  it('evaluateFlag returns flag on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ key: 'my-flag', value: true, reason: 'TARGETING_MATCH' }),
    });

    const client = new FlipswitchHttpClient('https://api.example.com', 'test-key', mockFetch, {});
    const flag = await client.evaluateFlag('my-flag', { targetingKey: 'user-1' });
    expect(flag).not.toBeNull();
    expect(flag!.key).toBe('my-flag');
    expect(flag!.value).toBe(true);
  });

  it('evaluateFlag returns null on error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const client = new FlipswitchHttpClient('https://api.example.com', 'test-key', mockFetch, {});
    const flag = await client.evaluateFlag('missing', { targetingKey: 'user-1' });
    expect(flag).toBeNull();
  });

  it('sends correct URL and headers', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn().mockImplementation((url: string, opts: { headers?: Record<string, string> }) => {
      capturedUrl = url;
      capturedHeaders = opts?.headers ?? {};
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ key: 'test', value: true }),
      });
    });

    const client = new FlipswitchHttpClient(
      'https://api.example.com',
      'my-api-key',
      mockFetch,
      { 'X-Custom': 'header' },
    );

    await client.evaluateFlag('test', { targetingKey: 'user-1' });

    expect(capturedUrl).toBe('https://api.example.com/ofrep/v1/evaluate/flags/test');
    expect(capturedHeaders['X-API-Key']).toBe('my-api-key');
    expect(capturedHeaders['X-Custom']).toBe('header');
  });
});
