import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SseClient } from '../src/sse-client';
import type { FlagChangeEvent, SseConnectionStatus } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function createSseServer() {
  let currentRes: http.ServerResponse | null = null;
  let nextStatus = 200;
  let connectionCount = 0;
  let onConnection: (() => void) | null = null;

  const server = http.createServer((req, res) => {
    connectionCount++;

    if (nextStatus !== 200) {
      res.writeHead(nextStatus);
      res.end();
      nextStatus = 200;
      onConnection?.();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    currentRes = res;
    onConnection?.();
  });

  function getUrl(): string {
    const addr = server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  function sendEvent(type: string, data: object | string): void {
    if (!currentRes) throw new Error('No active SSE response');
    const json = typeof data === 'string' ? data : JSON.stringify(data);
    currentRes.write(`event: ${type}\ndata: ${json}\n\n`);
  }

  function dropConnection(): void {
    if (currentRes) {
      currentRes.end();
      currentRes = null;
    }
  }

  function setNextStatus(status: number): void {
    nextStatus = status;
  }

  function waitForConnection(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (currentRes) {
        resolve();
        return;
      }
      onConnection = () => {
        onConnection = null;
        resolve();
      };
    });
  }

  function getConnectionCount(): number {
    return connectionCount;
  }

  async function listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
  }

  async function close(): Promise<void> {
    currentRes = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    server,
    getUrl,
    sendEvent,
    dropConnection,
    setNextStatus,
    waitForConnection,
    getConnectionCount,
    listen,
    close,
  };
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('SseClient - Unit Tests', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should have disconnected status before connect', () => {
      const client = new SseClient(
        'http://localhost:0',
        'test-key',
        vi.fn(),
      );
      expect(client.getStatus()).toBe('disconnected');
      client.close();
    });
  });

  describe('event parsing via mock SSE server', () => {
    let sseServer: ReturnType<typeof createSseServer>;
    let client: SseClient;
    let onFlagChange: ReturnType<typeof vi.fn>;
    let onStatusChange: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      sseServer = createSseServer();
      await sseServer.listen();

      onFlagChange = vi.fn();
      onStatusChange = vi.fn();
    });

    afterEach(async () => {
      client?.close();
      await sseServer.close();
    });

    it('flag-updated produces correct FlagChangeEvent with flagKey', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        onFlagChange,
        onStatusChange,
      );
      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      sseServer.sendEvent('flag-updated', {
        flagKey: 'my-flag',
        timestamp: '2025-01-01T00:00:00Z',
      });
      await wait(50);

      expect(onFlagChange).toHaveBeenCalledTimes(1);
      const event: FlagChangeEvent = onFlagChange.mock.calls[0][0];
      expect(event.flagKey).toBe('my-flag');
      expect(event.timestamp).toBe('2025-01-01T00:00:00Z');
    });

    it('config-updated produces FlagChangeEvent with null flagKey', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        onFlagChange,
        onStatusChange,
      );
      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      sseServer.sendEvent('config-updated', {
        timestamp: '2025-06-15T12:00:00Z',
      });
      await wait(50);

      expect(onFlagChange).toHaveBeenCalledTimes(1);
      const event: FlagChangeEvent = onFlagChange.mock.calls[0][0];
      expect(event.flagKey).toBeNull();
      expect(event.timestamp).toBe('2025-06-15T12:00:00Z');
    });

    it('api-key-rotated is handled without calling onFlagChange', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        onFlagChange,
        onStatusChange,
      );
      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      sseServer.sendEvent('api-key-rotated', {
        validUntil: '2025-12-31T23:59:59Z',
        timestamp: '2025-01-01T00:00:00Z',
      });
      await wait(50);

      expect(onFlagChange).not.toHaveBeenCalled();
    });

    it('heartbeat is ignored and does not invoke callback', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        onFlagChange,
        onStatusChange,
      );
      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      sseServer.sendEvent('heartbeat', '{}');
      await wait(50);

      expect(onFlagChange).not.toHaveBeenCalled();
    });

    it('malformed JSON does not crash the client', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        onFlagChange,
        onStatusChange,
      );
      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      sseServer.sendEvent('flag-updated', '{not valid json!!!');
      await wait(50);

      expect(onFlagChange).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();

      sseServer.sendEvent('flag-updated', {
        flagKey: 'after-bad',
        timestamp: '2025-01-01T00:00:00Z',
      });
      await wait(50);

      expect(onFlagChange).toHaveBeenCalledTimes(1);
      expect(onFlagChange.mock.calls[0][0].flagKey).toBe('after-bad');
    });
  });

  describe('status transitions', () => {
    let sseServer: ReturnType<typeof createSseServer>;
    let client: SseClient;
    let onStatusChange: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      sseServer = createSseServer();
      await sseServer.listen();
      onStatusChange = vi.fn();
    });

    afterEach(async () => {
      client?.close();
      await sseServer.close();
    });

    it('invokes onStatusChange on each transition', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        vi.fn(),
        onStatusChange,
      );

      expect(client.getStatus()).toBe('disconnected');

      client.connect();
      expect(onStatusChange).toHaveBeenCalledWith('connecting');

      await sseServer.waitForConnection();
      await wait(50);

      expect(onStatusChange).toHaveBeenCalledWith('connected');
      expect(client.getStatus()).toBe('connected');
    });
  });

  describe('exponential backoff', () => {
    let client: SseClient;
    let onStatusChange: ReturnType<typeof vi.fn>;
    let fetchCallCount: number;

    beforeEach(() => {
      vi.useFakeTimers();
      onStatusChange = vi.fn();
      fetchCallCount = 0;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          fetchCallCount++;
          return Promise.resolve({
            ok: false,
            status: 500,
            body: null,
          });
        }),
      );
    });

    afterEach(() => {
      client?.close();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('retry delay doubles on successive failures', async () => {
      client = new SseClient(
        'http://localhost:9999',
        'test-key',
        vi.fn(),
        onStatusChange,
      );

      client.connect();

      await vi.advanceTimersByTimeAsync(0);

      expect(onStatusChange).toHaveBeenCalledWith('connecting');
      expect(onStatusChange).toHaveBeenCalledWith('error');
      expect(fetchCallCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchCallCount).toBe(2);

      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCallCount).toBe(2);

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCallCount).toBe(3);
    });
  });

  describe('pause / resume', () => {
    let sseServer: ReturnType<typeof createSseServer>;
    let client: SseClient;
    let onStatusChange: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      sseServer = createSseServer();
      await sseServer.listen();
      onStatusChange = vi.fn();
    });

    afterEach(async () => {
      client?.close();
      await sseServer.close();
    });

    it('pause disconnects and sets paused state', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        vi.fn(),
        onStatusChange,
      );

      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      expect(client.getStatus()).toBe('connected');

      client.pause();

      expect(client.isPaused()).toBe(true);
      expect(client.getStatus()).toBe('disconnected');
    });

    it('resume reconnects after pause', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        vi.fn(),
        onStatusChange,
      );

      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      client.pause();
      expect(client.isPaused()).toBe(true);

      client.resume();
      expect(client.isPaused()).toBe(false);

      await sseServer.waitForConnection();
      await wait(50);

      expect(client.getStatus()).toBe('connected');
    });

    it('isPaused returns false initially', () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        vi.fn(),
      );

      expect(client.isPaused()).toBe(false);
    });

    it('pause is no-op when already paused', async () => {
      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        vi.fn(),
        onStatusChange,
      );

      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      client.pause();
      const statusAfterFirstPause = client.getStatus();

      client.pause();
      expect(client.getStatus()).toBe(statusAfterFirstPause);
      expect(client.isPaused()).toBe(true);
    });
  });

  describe('api-key-rotated edge cases', () => {
    let sseServer: ReturnType<typeof createSseServer>;
    let client: SseClient;

    beforeEach(async () => {
      sseServer = createSseServer();
      await sseServer.listen();
    });

    afterEach(async () => {
      client?.close();
      await sseServer.close();
    });

    it('api-key-rotated with null validUntil logs aborted', async () => {
      const onFlagChange = vi.fn();

      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        onFlagChange,
      );

      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      sseServer.sendEvent('api-key-rotated', {
        validUntil: null,
        timestamp: '2025-01-01T00:00:00Z',
      });
      await wait(50);

      expect(console.info).toHaveBeenCalledWith(
        '[Flipswitch] API key rotation was aborted',
      );
      expect(onFlagChange).not.toHaveBeenCalled();
    });
  });

  describe('close cleanup', () => {
    let sseServer: ReturnType<typeof createSseServer>;
    let client: SseClient;

    beforeEach(async () => {
      sseServer = createSseServer();
      await sseServer.listen();
    });

    afterEach(async () => {
      client?.close();
      await sseServer.close();
    });

    it('close cleans up and prevents reconnection', async () => {
      const onStatusChange = vi.fn();

      client = new SseClient(
        sseServer.getUrl(),
        'test-key',
        vi.fn(),
        onStatusChange,
      );

      client.connect();
      await sseServer.waitForConnection();
      await wait(50);

      expect(client.getStatus()).toBe('connected');

      client.close();

      expect(client.getStatus()).toBe('disconnected');
      expect(onStatusChange).toHaveBeenCalledWith('disconnected');

      sseServer.dropConnection();
      await wait(200);

      expect(client.getStatus()).toBe('disconnected');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('SseClient - Integration Tests', () => {
  let sseServer: ReturnType<typeof createSseServer>;
  let client: SseClient;

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    sseServer = createSseServer();
    await sseServer.listen();
  });

  afterEach(async () => {
    client?.close();
    await sseServer.close();
    vi.restoreAllMocks();
  });

  it('client connects and receives connected status', async () => {
    const onStatusChange = vi.fn();

    client = new SseClient(
      sseServer.getUrl(),
      'integration-key',
      vi.fn(),
      onStatusChange,
    );

    client.connect();
    await sseServer.waitForConnection();
    await wait(50);

    expect(client.getStatus()).toBe('connected');

    const statuses: SseConnectionStatus[] = onStatusChange.mock.calls.map(
      (c: [SseConnectionStatus]) => c[0],
    );
    expect(statuses).toContain('connecting');
    expect(statuses).toContain('connected');
  });

  it('server sends flag-updated SSE, client delivers to callback', async () => {
    const onFlagChange = vi.fn();

    client = new SseClient(
      sseServer.getUrl(),
      'integration-key',
      onFlagChange,
    );

    client.connect();
    await sseServer.waitForConnection();
    await wait(50);

    sseServer.sendEvent('flag-updated', {
      flagKey: 'integration-flag',
      timestamp: '2025-03-01T10:00:00Z',
    });
    await wait(100);

    expect(onFlagChange).toHaveBeenCalledTimes(1);
    expect(onFlagChange).toHaveBeenCalledWith({
      flagKey: 'integration-flag',
      timestamp: '2025-03-01T10:00:00Z',
    });
  });

  it('server closes connection, client reconnects automatically', async () => {
    const onStatusChange = vi.fn();

    client = new SseClient(
      sseServer.getUrl(),
      'integration-key',
      vi.fn(),
      onStatusChange,
    );

    client.connect();
    await sseServer.waitForConnection();
    await wait(50);

    expect(sseServer.getConnectionCount()).toBe(1);

    sseServer.dropConnection();

    await wait(1500);
    await sseServer.waitForConnection();
    await wait(50);

    expect(sseServer.getConnectionCount()).toBeGreaterThanOrEqual(2);
    expect(client.getStatus()).toBe('connected');
  });

  it('server returns non-200, client reports error status', async () => {
    const onStatusChange = vi.fn();

    sseServer.setNextStatus(503);

    client = new SseClient(
      sseServer.getUrl(),
      'integration-key',
      vi.fn(),
      onStatusChange,
    );

    client.connect();
    await wait(200);

    const statuses: SseConnectionStatus[] = onStatusChange.mock.calls.map(
      (c: [SseConnectionStatus]) => c[0],
    );
    expect(statuses).toContain('error');
  });
});
