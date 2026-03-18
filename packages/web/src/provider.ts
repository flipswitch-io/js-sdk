import {
  ClientProviderStatus,
  ClientProviderEvents,
  type EvaluationContext,
  type EventContext,
  type JsonValue,
  type ProviderMetadata,
  type ResolutionDetails,
} from '@openfeature/core';
import { OpenFeatureEventEmitter, type ProviderEmittableEvents } from '@openfeature/web-sdk';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import {
  SseClient,
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
import { BrowserCache } from './browser-cache';
import type { FlipswitchWebOptions } from './types';
import { version as SDK_VERSION } from '../package.json';

const DEFAULT_BASE_URL = 'https://api.flipswitch.io';
const DEFAULT_POLLING_INTERVAL = 30000; // 30 seconds
const DEFAULT_MAX_SSE_RETRIES = 5;

/**
 * Flipswitch OpenFeature web provider with real-time SSE support.
 *
 * This provider wraps the OFREP web provider for flag evaluation and adds
 * real-time updates via Server-Sent Events (SSE), browser caching,
 * offline support, and visibility handling.
 *
 * @example
 * ```typescript
 * import { FlipswitchWebProvider } from '@flipswitch-io/web-provider';
 * import { OpenFeature } from '@openfeature/web-sdk';
 *
 * const provider = new FlipswitchWebProvider({
 *   apiKey: 'your-api-key'
 * });
 *
 * await OpenFeature.setProviderAndWait(provider);
 * const client = OpenFeature.getClient();
 * const darkMode = await client.getBooleanValue('dark-mode', false);
 * ```
 */
export class FlipswitchWebProvider {
  readonly metadata: ProviderMetadata = {
    name: 'flipswitch-web',
  };

  readonly rulesFromFlagValue = false;
  readonly events = new OpenFeatureEventEmitter();

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly enableRealtime: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly ofrepProvider: OFREPWebProvider;
  private readonly browserCache: BrowserCache | null;
  private readonly enableVisibilityHandling: boolean;
  private readonly enablePollingFallback: boolean;
  private readonly pollingInterval: number;
  private readonly maxSseRetries: number;
  private readonly offlineMode: boolean;
  private readonly httpClient: FlipswitchHttpClient;
  private readonly telemetryHeaders: Record<string, string>;

  private sseClient: SseClient | null = null;
  private _status: ClientProviderStatus = ClientProviderStatus.NOT_READY;
  private _currentContext: EvaluationContext = {};
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private sseRetryCount = 0;
  private isPollingFallbackActive = false;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private _isOnline = true;

  // Event listener storage
  private globalFlagChangeListeners = new Set<FlagChangeHandler>();
  private keyFlagChangeListeners = new Map<string, Set<FlagChangeHandler>>();
  private connectionStatusListeners = new Set<ConnectionStatusHandler>();

  constructor(options: FlipswitchWebOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.enableRealtime = options.enableRealtime ?? true;
    this.fetchImpl = options.fetchImplementation ?? (typeof window !== 'undefined' ? fetch.bind(window) : fetch);

    // Browser-specific features default to enabled in browser, disabled in Node.js
    const isBrowser = typeof window !== 'undefined';
    this.enableVisibilityHandling = options.enableVisibilityHandling ?? isBrowser;
    this.offlineMode = options.offlineMode ?? isBrowser;
    this.enablePollingFallback = options.enablePollingFallback ?? true;
    this.pollingInterval = options.pollingInterval ?? DEFAULT_POLLING_INTERVAL;
    this.maxSseRetries = options.maxSseRetries ?? DEFAULT_MAX_SSE_RETRIES;

    // Initialize browser cache if enabled
    const persistCache = options.persistCache ?? isBrowser;
    this.browserCache = persistCache ? new BrowserCache() : null;

    // Detect initial online state
    if (typeof navigator !== 'undefined') {
      this._isOnline = navigator.onLine;
    }

    // Build telemetry headers
    this.telemetryHeaders = buildTelemetryHeaders(SDK_VERSION, this.enableRealtime);

    // Build headers array for OFREP provider
    const headers: [string, string][] = [
      ['X-API-Key', this.apiKey],
      ...Object.entries(this.telemetryHeaders) as [string, string][],
    ];

    // Create underlying OFREP provider for flag evaluation
    // Disable OFREP polling - we use SSE for real-time updates instead
    this.ofrepProvider = new OFREPWebProvider({
      baseUrl: this.baseUrl,
      fetchImplementation: this.fetchImpl,
      headers,
      pollInterval: 0,
    });

    // Create HTTP client for direct flag evaluation
    this.httpClient = new FlipswitchHttpClient(
      this.baseUrl,
      this.apiKey,
      this.fetchImpl,
      this.telemetryHeaders,
    );
  }

  get status(): ClientProviderStatus {
    return this._status;
  }

  /**
   * Initialize the provider.
   * Validates the API key and starts SSE connection if real-time is enabled.
   */
  async initialize(context?: EvaluationContext): Promise<void> {
    this._status = ClientProviderStatus.NOT_READY;
    this._currentContext = context ?? {};

    // Setup offline/online handling for browsers
    this.setupOfflineHandling();

    // If offline, use cached data and mark as stale
    if (!this._isOnline && this.offlineMode) {
      console.warn('[Flipswitch] Starting in offline mode - using cached flag values');
      this._status = ClientProviderStatus.STALE;
      this.emit(ClientProviderEvents.Stale);
      return;
    }

    // Initialize the underlying OFREP provider
    try {
      await this.ofrepProvider.initialize(context);
    } catch (_error) {
      // OFREP provider may fail on init, try a bulk evaluation to validate API key
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/ofrep/v1/evaluate/flags`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            ...this.telemetryHeaders,
          },
          body: JSON.stringify({
            context: { targetingKey: '_init_' },
          }),
        });

        if (response.status === 401 || response.status === 403) {
          this._status = ClientProviderStatus.ERROR;
          throw new Error('Invalid API key');
        }

        if (!response.ok && response.status !== 404) {
          this._status = ClientProviderStatus.ERROR;
          throw new Error(`Failed to connect to Flipswitch: ${response.status}`);
        }
      } catch (validationError) {
        this._status = ClientProviderStatus.ERROR;
        throw validationError;
      }
    }

    // Start SSE connection for real-time updates
    if (this.enableRealtime) {
      this.startSseConnection();
    }

    this._status = ClientProviderStatus.READY;
    this.emit(ClientProviderEvents.Ready);
  }

  /**
   * Called by OpenFeature when the global evaluation context changes.
   */
  async onContextChange(oldContext: EvaluationContext, newContext: EvaluationContext): Promise<void> {
    this._currentContext = newContext;

    // Invalidate browser cache fully since user identity changed
    this.browserCache?.invalidate();

    // Forward context change to the underlying OFREP provider
    await this.ofrepProvider.onContextChange?.(oldContext, newContext);

    this.emit(ClientProviderEvents.ConfigurationChanged);
  }

  /**
   * Setup online/offline event handling.
   */
  private setupOfflineHandling(): void {
    if (typeof window === 'undefined' || !this.offlineMode) return;

    this.onlineHandler = () => {
      this._isOnline = true;
      console.info('[Flipswitch] Connection restored - refreshing flags');

      if (this.enableRealtime && this.sseClient) {
        this.sseClient.resume();
      }

      this.refreshFlags();
    };

    this.offlineHandler = () => {
      this._isOnline = false;
      console.warn('[Flipswitch] Connection lost - serving cached values');

      if (this.sseClient) {
        this.sseClient.pause();
      }

      this.stopPolling();

      if (this._status !== ClientProviderStatus.STALE) {
        this._status = ClientProviderStatus.STALE;
        this.emit(ClientProviderEvents.Stale);
      }
    };

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  /**
   * Setup visibility API handling.
   * Pauses SSE when tab is hidden, resumes when visible.
   */
  private setupVisibilityHandling(): void {
    if (typeof document === 'undefined' || !this.enableVisibilityHandling || this.visibilityHandler) return;

    this.visibilityHandler = () => {
      if (document.hidden) {
        this.sseClient?.pause();
      } else {
        this.sseClient?.resume();
      }
    };

    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /**
   * Refresh flags from the server.
   */
  private async refreshFlags(): Promise<void> {
    try {
      await this.ofrepProvider.onContextChange?.(this._currentContext, this._currentContext);

      if (this._status === ClientProviderStatus.STALE) {
        this._status = ClientProviderStatus.READY;
        this.emit(ClientProviderEvents.Ready);
      }

      this.emit(ClientProviderEvents.ConfigurationChanged);
    } catch (error) {
      console.warn('[Flipswitch] Failed to refresh flags:', error);
    }
  }

  /**
   * Called when the provider is shut down.
   */
  async onClose(): Promise<void> {
    // Cleanup SSE client
    this.sseClient?.close();
    this.sseClient = null;

    // Cleanup polling
    this.stopPolling();

    // Cleanup visibility handler
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    // Cleanup online/offline handlers
    if (typeof window !== 'undefined') {
      if (this.onlineHandler) {
        window.removeEventListener('online', this.onlineHandler);
        this.onlineHandler = null;
      }
      if (this.offlineHandler) {
        window.removeEventListener('offline', this.offlineHandler);
        this.offlineHandler = null;
      }
    }

    await this.ofrepProvider.onClose?.();
    this._status = ClientProviderStatus.NOT_READY;
  }

  /**
   * Stop the polling fallback.
   */
  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.isPollingFallbackActive = false;
    }
  }

  /**
   * Start polling fallback when SSE fails.
   */
  private startPollingFallback(): void {
    if (this.isPollingFallbackActive || !this.enablePollingFallback) return;

    console.info(`[Flipswitch] Starting polling fallback (interval: ${this.pollingInterval}ms)`);
    this.isPollingFallbackActive = true;

    this.pollingTimer = setInterval(async () => {
      if (!this._isOnline) return;

      try {
        await this.refreshFlags();
      } catch (error) {
        console.warn('[Flipswitch] Polling refresh failed:', error);
      }
    }, this.pollingInterval);
  }

  /**
   * Check if the provider is currently online.
   */
  isOnline(): boolean {
    return this._isOnline;
  }

  /**
   * Check if polling fallback is active.
   */
  isPollingActive(): boolean {
    return this.isPollingFallbackActive;
  }

  /**
   * Start the SSE connection for real-time updates.
   */
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

          this._status = ClientProviderStatus.STALE;
          this.emit(ClientProviderEvents.Stale);
        } else if (status === 'connected') {
          this.sseRetryCount = 0;

          if (this.isPollingFallbackActive) {
            console.info('[Flipswitch] SSE reconnected - stopping polling fallback');
            this.stopPolling();
          }

          if (this._status === ClientProviderStatus.STALE) {
            this._status = ClientProviderStatus.READY;
            this.emit(ClientProviderEvents.Ready);
          }
        }
      },
      this.telemetryHeaders,
    );

    // Setup visibility handling — pauses/resumes SSE when tab hidden/visible
    this.setupVisibilityHandling();

    this.sseClient.connect();
  }

  /**
   * Handle a flag change event from SSE.
   */
  private async handleFlagChange(event: FlagChangeEvent): Promise<void> {
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

    // Invalidate browser cache for the changed flag(s)
    if (this.browserCache) {
      if (event.flagKey) {
        this.browserCache.invalidate(event.flagKey);
      } else {
        this.browserCache.invalidate();
      }
    }

    // Trigger OFREP provider to refresh its cache
    try {
      await this.ofrepProvider.onContextChange?.(this._currentContext, this._currentContext);
    } catch (error) {
      console.warn('[Flipswitch] Failed to refresh flags after SSE event:', error);
    }

    // Emit configuration changed event
    if (event.flagKey) {
      this.emit(ClientProviderEvents.ConfigurationChanged, { flagsChanged: [event.flagKey] });
    } else {
      this.emit(ClientProviderEvents.ConfigurationChanged);
    }
  }

  /**
   * Emit an event through the OpenFeature event emitter.
   */
  private emit(event: ProviderEmittableEvents, context?: EventContext): void {
    this.events.emit(event, context);
  }

  // ===============================
  // Flag Resolution Methods - Delegated to OFREP Provider
  // ===============================

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext
  ): ResolutionDetails<boolean> {
    return this.ofrepProvider.resolveBooleanEvaluation(flagKey, defaultValue, context);
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext
  ): ResolutionDetails<string> {
    return this.ofrepProvider.resolveStringEvaluation(flagKey, defaultValue, context);
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext
  ): ResolutionDetails<number> {
    return this.ofrepProvider.resolveNumberEvaluation(flagKey, defaultValue, context);
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext
  ): ResolutionDetails<T> {
    return this.ofrepProvider.resolveObjectEvaluation(flagKey, defaultValue, context);
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
