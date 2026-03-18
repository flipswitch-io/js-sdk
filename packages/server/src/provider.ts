import type {
  EvaluationContext,
  JsonValue,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/core';
import type { Provider } from '@openfeature/server-sdk';
import { OpenFeatureEventEmitter } from '@openfeature/server-sdk';
import { OFREPProvider } from '@openfeature/ofrep-provider';
import {
  SseClient,
  FlagCache,
  FlipswitchHttpClient,
  buildTelemetryHeaders,
  formatValue,
  type FlagChangeEvent,
  type FlagEvaluation,
  type SseConnectionStatus,
  type FlagChangeHandler,
  type ConnectionStatusHandler,
  type Unsubscribe,
} from '@flipswitch-io/core';
import type { FlipswitchServerOptions } from './types';
import { version as SDK_VERSION } from '../package.json';

const DEFAULT_BASE_URL = 'https://api.flipswitch.io';
const DEFAULT_POLLING_INTERVAL = 30000;
const DEFAULT_MAX_SSE_RETRIES = 5;

/**
 * Flipswitch OpenFeature server provider with real-time SSE support.
 *
 * This provider wraps the OFREP server provider for flag evaluation and adds
 * real-time cache invalidation via Server-Sent Events (SSE).
 *
 * Each flag evaluation is an async HTTP request with per-request context,
 * matching the OpenFeature server SDK contract.
 *
 * @example
 * ```typescript
 * import { FlipswitchServerProvider } from '@flipswitch-io/server-provider';
 * import { OpenFeature } from '@openfeature/server-sdk';
 *
 * const provider = new FlipswitchServerProvider({
 *   apiKey: 'your-api-key'
 * });
 *
 * await OpenFeature.setProviderAndWait(provider);
 * const client = OpenFeature.getClient();
 *
 * // Each evaluation hits the server with request-scoped context
 * const darkMode = await client.getBooleanValue('dark-mode', false, {
 *   targetingKey: 'user-123',
 * });
 * ```
 */
export class FlipswitchServerProvider implements Provider {
  readonly metadata: ProviderMetadata = {
    name: 'flipswitch-server',
  };

  readonly runsOn = 'server' as const;
  readonly events = new OpenFeatureEventEmitter();

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly enableRealtime: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly ofrepProvider: OFREPProvider;
  private readonly cache: FlagCache | null;
  private readonly enablePollingFallback: boolean;
  private readonly pollingInterval: number;
  private readonly maxSseRetries: number;
  private readonly httpClient: FlipswitchHttpClient;
  private readonly telemetryHeaders: Record<string, string>;

  private sseClient: SseClient | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private sseRetryCount = 0;
  private isPollingFallbackActive = false;

  // Event listener storage
  private globalFlagChangeListeners = new Set<FlagChangeHandler>();
  private keyFlagChangeListeners = new Map<string, Set<FlagChangeHandler>>();
  private connectionStatusListeners = new Set<ConnectionStatusHandler>();

  constructor(options: FlipswitchServerOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.enableRealtime = options.enableRealtime ?? true;
    this.fetchImpl = options.fetchImplementation ?? fetch;
    this.enablePollingFallback = options.enablePollingFallback ?? true;
    this.pollingInterval = options.pollingInterval ?? DEFAULT_POLLING_INTERVAL;
    this.maxSseRetries = options.maxSseRetries ?? DEFAULT_MAX_SSE_RETRIES;

    // Optional in-memory cache
    const cacheTtl = options.cacheTtl ?? 0;
    this.cache = cacheTtl > 0 ? new FlagCache(cacheTtl) : null;

    // Build telemetry headers
    this.telemetryHeaders = buildTelemetryHeaders(SDK_VERSION, this.enableRealtime);

    // Create underlying OFREP server provider for flag evaluation
    this.ofrepProvider = new OFREPProvider({
      baseUrl: this.baseUrl,
      fetchImplementation: this.fetchImpl,
      headers: [
        ['X-API-Key', this.apiKey],
        ...Object.entries(this.telemetryHeaders) as [string, string][],
      ],
    });

    // Create HTTP client for direct flag evaluation
    this.httpClient = new FlipswitchHttpClient(
      this.baseUrl,
      this.apiKey,
      this.fetchImpl,
      this.telemetryHeaders,
    );
  }

  /**
   * Initialize the provider.
   * Validates the API key and starts SSE connection if real-time is enabled.
   */
  async initialize(context?: EvaluationContext): Promise<void> {
    // Validate API key by making a test request
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/ofrep/v1/evaluate/flags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          ...this.telemetryHeaders,
        },
        body: JSON.stringify({
          context: { targetingKey: context?.targetingKey ?? '_init_' },
        }),
      });

      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid API key');
      }

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to connect to Flipswitch: ${response.status}`);
      }
    } catch (error) {
      throw error;
    }

    // Start SSE connection for real-time cache invalidation
    if (this.enableRealtime) {
      this.startSseConnection();
    }
  }

  /**
   * Called when the provider is shut down.
   */
  async onClose(): Promise<void> {
    this.sseClient?.close();
    this.sseClient = null;
    this.stopPolling();
    this.cache?.invalidate();
  }

  // ===============================
  // Flag Resolution Methods - Async, per-request
  // ===============================

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext
  ): Promise<ResolutionDetails<boolean>> {
    return this.ofrepProvider.resolveBooleanEvaluation(flagKey, defaultValue, context);
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext
  ): Promise<ResolutionDetails<string>> {
    return this.ofrepProvider.resolveStringEvaluation(flagKey, defaultValue, context);
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext
  ): Promise<ResolutionDetails<number>> {
    return this.ofrepProvider.resolveNumberEvaluation(flagKey, defaultValue, context);
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext
  ): Promise<ResolutionDetails<T>> {
    return this.ofrepProvider.resolveObjectEvaluation(flagKey, defaultValue, context);
  }

  // ===============================
  // SSE Connection
  // ===============================

  private startSseConnection(): void {
    this.sseClient = new SseClient(
      this.baseUrl,
      this.apiKey,
      (event: FlagChangeEvent) => {
        this.handleFlagChange(event);
      },
      (status: SseConnectionStatus) => {
        for (const listener of this.connectionStatusListeners) {
          try {
            listener(status);
          } catch (e) {
            console.error('[Flipswitch] Error in connection status listener:', e);
          }
        }

        if (status === 'error') {
          this.sseRetryCount++;

          if (this.sseRetryCount >= this.maxSseRetries && this.enablePollingFallback) {
            console.warn(`[Flipswitch] SSE failed after ${this.sseRetryCount} retries - falling back to polling`);
            this.startPollingFallback();
          }
        } else if (status === 'connected') {
          this.sseRetryCount = 0;

          if (this.isPollingFallbackActive) {
            console.info('[Flipswitch] SSE reconnected - stopping polling fallback');
            this.stopPolling();
          }
        }
      },
      this.telemetryHeaders,
    );

    this.sseClient.connect();
  }

  private handleFlagChange(event: FlagChangeEvent): void {
    // Invalidate cache
    if (this.cache) {
      if (event.flagKey) {
        this.cache.invalidate(event.flagKey);
      } else {
        this.cache.invalidate();
      }
    }

    // Notify global flag change listeners
    for (const listener of this.globalFlagChangeListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[Flipswitch] Error in flag change listener:', e);
      }
    }

    // Notify key-specific listeners
    if (event.flagKey) {
      const listeners = this.keyFlagChangeListeners.get(event.flagKey);
      if (listeners) {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (e) {
            console.error('[Flipswitch] Error in flag change listener:', e);
          }
        }
      }
    } else {
      for (const listeners of this.keyFlagChangeListeners.values()) {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (e) {
            console.error('[Flipswitch] Error in flag change listener:', e);
          }
        }
      }
    }
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.isPollingFallbackActive = false;
    }
  }

  private startPollingFallback(): void {
    if (this.isPollingFallbackActive || !this.enablePollingFallback) return;

    console.info(`[Flipswitch] Starting polling fallback (interval: ${this.pollingInterval}ms)`);
    this.isPollingFallbackActive = true;

    this.pollingTimer = setInterval(() => {
      // For server provider, polling is mainly about keeping the SSE retry logic going
      // Cache invalidation happens via SSE events
      this.cache?.invalidate();
    }, this.pollingInterval);
  }

  // ===============================
  // Event Listener Methods
  // ===============================

  on(event: 'flagChange', handler: FlagChangeHandler): Unsubscribe;
  on(event: 'flagChange', flagKey: string, handler: FlagChangeHandler): Unsubscribe;
  on(event: 'connectionStatusChange', handler: ConnectionStatusHandler): Unsubscribe;
  on(
    event: 'flagChange' | 'connectionStatusChange',
    handlerOrFlagKey: FlagChangeHandler | ConnectionStatusHandler | string,
    maybeHandler?: FlagChangeHandler
  ): Unsubscribe {
    if (event === 'connectionStatusChange') {
      const handler = handlerOrFlagKey as ConnectionStatusHandler;
      this.connectionStatusListeners.add(handler);
      return () => {
        this.connectionStatusListeners.delete(handler);
      };
    }

    if (typeof handlerOrFlagKey === 'string') {
      const flagKey = handlerOrFlagKey;
      const handler = maybeHandler!;
      let listeners = this.keyFlagChangeListeners.get(flagKey);
      if (!listeners) {
        listeners = new Set();
        this.keyFlagChangeListeners.set(flagKey, listeners);
      }
      listeners.add(handler);
      return () => {
        listeners!.delete(handler);
        if (listeners!.size === 0) {
          this.keyFlagChangeListeners.delete(flagKey);
        }
      };
    }

    const handler = handlerOrFlagKey as FlagChangeHandler;
    this.globalFlagChangeListeners.add(handler);
    return () => {
      this.globalFlagChangeListeners.delete(handler);
    };
  }

  off(event: 'flagChange', handler: FlagChangeHandler): void;
  off(event: 'flagChange', flagKey: string, handler: FlagChangeHandler): void;
  off(event: 'connectionStatusChange', handler: ConnectionStatusHandler): void;
  off(
    event: 'flagChange' | 'connectionStatusChange',
    handlerOrFlagKey: FlagChangeHandler | ConnectionStatusHandler | string,
    maybeHandler?: FlagChangeHandler
  ): void {
    if (event === 'connectionStatusChange') {
      this.connectionStatusListeners.delete(handlerOrFlagKey as ConnectionStatusHandler);
      return;
    }

    if (typeof handlerOrFlagKey === 'string') {
      const flagKey = handlerOrFlagKey;
      const handler = maybeHandler!;
      const listeners = this.keyFlagChangeListeners.get(flagKey);
      if (listeners) {
        listeners.delete(handler);
        if (listeners.size === 0) {
          this.keyFlagChangeListeners.delete(flagKey);
        }
      }
      return;
    }

    this.globalFlagChangeListeners.delete(handlerOrFlagKey as FlagChangeHandler);
  }

  /**
   * Get SSE connection status.
   */
  getSseStatus(): SseConnectionStatus {
    return this.sseClient?.getStatus() ?? 'disconnected';
  }

  /**
   * Force reconnect SSE connection.
   */
  reconnectSse(): void {
    if (this.enableRealtime && this.sseClient) {
      this.sseClient.close();
      this.startSseConnection();
    }
  }

  /**
   * Check if polling fallback is active.
   */
  isPollingActive(): boolean {
    return this.isPollingFallbackActive;
  }

  // ===============================
  // Direct Flag Evaluation (HTTP)
  // ===============================

  /**
   * Evaluate all flags for the given context.
   */
  async evaluateAllFlags(context: EvaluationContext): Promise<FlagEvaluation[]> {
    return this.httpClient.evaluateAllFlags(context);
  }

  /**
   * Evaluate a single flag.
   */
  async evaluateFlag(flagKey: string, context: EvaluationContext): Promise<FlagEvaluation | null> {
    return this.httpClient.evaluateFlag(flagKey, context);
  }

  /**
   * Format a value for display.
   */
  formatValue(value: unknown): string {
    return formatValue(value);
  }
}
