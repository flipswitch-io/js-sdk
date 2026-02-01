import {
  ClientProviderStatus,
  ClientProviderEvents,
  type EvaluationContext,
  type JsonValue,
  type ProviderMetadata,
  type ResolutionDetails,
} from '@openfeature/core';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import { SseClient } from './sse-client';
import { BrowserCache } from './browser-cache';
import type { FlipswitchOptions, FlagChangeEvent, SseConnectionStatus, FlipswitchEventHandlers, FlagEvaluation } from './types';
type EventHandler = () => void;

const DEFAULT_BASE_URL = 'https://api.flipswitch.io';
const SDK_VERSION = '0.1.2';
const DEFAULT_POLLING_INTERVAL = 30000; // 30 seconds
const DEFAULT_MAX_SSE_RETRIES = 5;

/**
 * Flipswitch OpenFeature provider with real-time SSE support.
 *
 * This provider wraps the OFREP provider for flag evaluation and adds
 * real-time updates via Server-Sent Events (SSE).
 *
 * @example
 * ```typescript
 * import { FlipswitchProvider } from '@flipswitch-io/sdk';
 * import { OpenFeature } from '@openfeature/web-sdk';
 *
 * // Only API key is required - defaults to https://api.flipswitch.io
 * const provider = new FlipswitchProvider({
 *   apiKey: 'your-api-key'
 * });
 *
 * await OpenFeature.setProviderAndWait(provider);
 * const client = OpenFeature.getClient();
 * const darkMode = await client.getBooleanValue('dark-mode', false);
 * ```
 */
export class FlipswitchProvider {
  readonly metadata: ProviderMetadata = {
    name: 'flipswitch',
  };

  readonly rulesFromFlagValue = false;

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

  private sseClient: SseClient | null = null;
  private _status: ClientProviderStatus = ClientProviderStatus.NOT_READY;
  private eventHandlers = new Map<ClientProviderEvents, Set<EventHandler>>();
  private userEventHandlers: FlipswitchEventHandlers = {};
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private sseRetryCount = 0;
  private isPollingFallbackActive = false;
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  private _isOnline = true;

  constructor(options: FlipswitchOptions, eventHandlers?: FlipswitchEventHandlers) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.enableRealtime = options.enableRealtime ?? true;
    this.fetchImpl = options.fetchImplementation ?? (typeof window !== 'undefined' ? fetch.bind(window) : fetch);
    this.userEventHandlers = eventHandlers ?? {};

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

    // Build headers array
    const headers: [string, string][] = [
      ['X-API-Key', this.apiKey],
      ['X-Flipswitch-SDK', this.getTelemetrySdkHeader()],
      ['X-Flipswitch-Runtime', this.getTelemetryRuntimeHeader()],
      ['X-Flipswitch-OS', this.getTelemetryOsHeader()],
      ['X-Flipswitch-Features', this.getTelemetryFeaturesHeader()],
    ];

    // Create underlying OFREP provider for flag evaluation
    // Note: OFREPWebProvider automatically appends /ofrep/v1 to the baseUrl
    // Disable OFREP polling - we use SSE for real-time updates instead
    this.ofrepProvider = new OFREPWebProvider({
      baseUrl: this.baseUrl,
      fetchImplementation: this.fetchImpl,
      headers,
      pollInterval: 0, // Disable polling - SSE handles real-time updates
    });
  }

  private getTelemetrySdkHeader(): string {
    return `javascript/${SDK_VERSION}`;
  }

  private getTelemetryRuntimeHeader(): string {
    // Detect runtime environment
    if (typeof process !== 'undefined' && process.versions?.node) {
      return `node/${process.versions.node}`;
    }
    if (typeof navigator !== 'undefined') {
      // Browser - extract browser info from userAgent
      const ua = navigator.userAgent;
      if (ua.includes('Chrome')) {
        const match = ua.match(/Chrome\/(\d+)/);
        return `chrome/${match?.[1] ?? 'unknown'}`;
      }
      if (ua.includes('Firefox')) {
        const match = ua.match(/Firefox\/(\d+)/);
        return `firefox/${match?.[1] ?? 'unknown'}`;
      }
      if (ua.includes('Safari') && !ua.includes('Chrome')) {
        const match = ua.match(/Version\/(\d+)/);
        return `safari/${match?.[1] ?? 'unknown'}`;
      }
      return 'browser/unknown';
    }
    return 'unknown/unknown';
  }

  private getTelemetryOsHeader(): string {
    // Detect OS
    if (typeof process !== 'undefined' && process.platform) {
      const platform = process.platform;
      const arch = process.arch;
      const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : platform;
      return `${os}/${arch}`;
    }
    if (typeof navigator !== 'undefined') {
      const ua = navigator.userAgent.toLowerCase();
      let os = 'unknown';
      let arch = 'unknown';

      if (ua.includes('mac')) os = 'darwin';
      else if (ua.includes('win')) os = 'windows';
      else if (ua.includes('linux')) os = 'linux';
      else if (ua.includes('android')) os = 'android';
      else if (ua.includes('iphone') || ua.includes('ipad')) os = 'ios';

      // Try to detect architecture
      if (ua.includes('arm64') || ua.includes('aarch64')) arch = 'arm64';
      else if (ua.includes('x64') || ua.includes('x86_64') || ua.includes('amd64')) arch = 'amd64';

      return `${os}/${arch}`;
    }
    return 'unknown/unknown';
  }

  private getTelemetryFeaturesHeader(): string {
    return `sse=${this.enableRealtime}`;
  }

  private getTelemetryHeaders(): Record<string, string> {
    return {
      'X-Flipswitch-SDK': this.getTelemetrySdkHeader(),
      'X-Flipswitch-Runtime': this.getTelemetryRuntimeHeader(),
      'X-Flipswitch-OS': this.getTelemetryOsHeader(),
      'X-Flipswitch-Features': this.getTelemetryFeaturesHeader(),
    };
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
    } catch (error) {
      // OFREP provider may fail on init, try a bulk evaluation to validate API key
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/ofrep/v1/evaluate/flags`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            ...this.getTelemetryHeaders(),
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
   * Setup online/offline event handling.
   */
  private setupOfflineHandling(): void {
    if (typeof window === 'undefined' || !this.offlineMode) return;

    this.onlineHandler = () => {
      this._isOnline = true;
      console.info('[Flipswitch] Connection restored - refreshing flags');

      // Reconnect SSE if it was disconnected
      if (this.enableRealtime && this.sseClient) {
        this.sseClient.resume();
      }

      // Refresh flags
      this.refreshFlags();
    };

    this.offlineHandler = () => {
      this._isOnline = false;
      console.warn('[Flipswitch] Connection lost - serving cached values');

      // Pause SSE to avoid connection errors
      if (this.sseClient) {
        this.sseClient.pause();
      }

      // Stop polling if active
      this.stopPolling();

      // Mark as stale but keep serving cached values
      if (this._status !== ClientProviderStatus.STALE) {
        this._status = ClientProviderStatus.STALE;
        this.emit(ClientProviderEvents.Stale);
      }
    };

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  /**
   * Refresh flags from the server.
   */
  private async refreshFlags(): Promise<void> {
    try {
      await this.ofrepProvider.onContextChange?.(undefined, {});

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
    const telemetryHeaders = this.getTelemetryHeadersMap();
    this.sseClient = new SseClient(
      this.baseUrl,
      this.apiKey,
      (event: FlagChangeEvent) => {
        this.handleFlagChange(event);
      },
      (status: SseConnectionStatus) => {
        this.userEventHandlers.onConnectionStatusChange?.(status);

        if (status === 'error') {
          this.sseRetryCount++;

          // Check if we should fall back to polling
          if (this.sseRetryCount >= this.maxSseRetries && this.enablePollingFallback) {
            console.warn(`[Flipswitch] SSE failed after ${this.sseRetryCount} retries - falling back to polling`);
            this.startPollingFallback();
          }

          this._status = ClientProviderStatus.STALE;
          this.emit(ClientProviderEvents.Stale);
        } else if (status === 'connected') {
          // SSE connected - reset retry count and stop polling fallback
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
      telemetryHeaders,
      this.enableVisibilityHandling
    );

    this.sseClient.connect();
  }

  /**
   * Get telemetry headers as a map.
   */
  private getTelemetryHeadersMap(): Record<string, string> {
    return {
      'X-Flipswitch-SDK': this.getTelemetrySdkHeader(),
      'X-Flipswitch-Runtime': this.getTelemetryRuntimeHeader(),
      'X-Flipswitch-OS': this.getTelemetryOsHeader(),
      'X-Flipswitch-Features': this.getTelemetryFeaturesHeader(),
    };
  }

  /**
   * Handle a flag change event from SSE.
   * Triggers OFREP cache refresh, updates browser cache, and emits PROVIDER_CONFIGURATION_CHANGED.
   */
  private async handleFlagChange(event: FlagChangeEvent): Promise<void> {
    this.userEventHandlers.onFlagChange?.(event);

    // Invalidate browser cache for the changed flag(s)
    if (this.browserCache) {
      if (event.flagKey) {
        this.browserCache.invalidate(event.flagKey);
      } else {
        // Full invalidation
        this.browserCache.invalidate();
      }
    }

    // Trigger OFREP provider to refresh its cache
    // The onContextChange method forces the provider to re-fetch flags
    try {
      await this.ofrepProvider.onContextChange?.(undefined, {});
    } catch (error) {
      // Log but don't fail - the stale data is still usable
      console.warn('[Flipswitch] Failed to refresh flags after SSE event:', error);
    }

    // Emit configuration changed event - OpenFeature clients will re-evaluate flags
    this.emit(ClientProviderEvents.ConfigurationChanged);
  }

  /**
   * Emit an event to registered handlers.
   */
  private emit(event: ClientProviderEvents): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      Array.from(handlers).forEach(handler => handler());
    }
  }

  /**
   * Register an event handler.
   */
  onProviderEvent?(event: ClientProviderEvents, handler: EventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
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
  // Bulk Flag Evaluation (Direct HTTP - OFREP providers don't expose bulk API)
  // ===============================

  /**
   * Transform OpenFeature context to OFREP context format.
   */
  private transformContext(context: EvaluationContext): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (context.targetingKey) {
      result.targetingKey = context.targetingKey;
    }

    // Copy all context properties
    for (const [key, value] of Object.entries(context)) {
      if (key !== 'targetingKey') {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Infer the type of a value.
   */
  private inferType(value: unknown): FlagEvaluation['valueType'] {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    const t = typeof value;
    if (t === 'boolean' || t === 'string' || t === 'number' || t === 'object') {
      return t;
    }
    return 'unknown';
  }

  /**
   * Get flag type from metadata or infer from value.
   */
  private getFlagType(flag: { value?: unknown; metadata?: { flagType?: string } }): FlagEvaluation['valueType'] {
    // Prefer metadata.flagType if available (especially useful for disabled flags)
    if (flag.metadata?.flagType) {
      const metaType = flag.metadata.flagType;
      if (metaType === 'boolean' || metaType === 'string' || metaType === 'integer' || metaType === 'decimal') {
        return metaType === 'integer' || metaType === 'decimal' ? 'number' : metaType;
      }
    }
    // Fall back to inferring from value
    return this.inferType(flag.value);
  }

  /**
   * Format a value for display.
   */
  formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /**
   * Evaluate all flags for the given context.
   * Returns a list of all flag evaluations with their keys, values, types, and reasons.
   *
   * Note: This method makes direct HTTP calls since OFREP providers don't expose
   * the bulk evaluation API.
   *
   * @param context The evaluation context
   * @returns List of flag evaluations
   */
  async evaluateAllFlags(context: EvaluationContext): Promise<FlagEvaluation[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/ofrep/v1/evaluate/flags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          ...this.getTelemetryHeaders(),
        },
        body: JSON.stringify({
          context: this.transformContext(context),
        }),
      });

      if (!response.ok) {
        console.error(`Failed to evaluate all flags: ${response.status}`);
        return [];
      }

      const result = await response.json();
      const flags: FlagEvaluation[] = [];

      if (result.flags && Array.isArray(result.flags)) {
        for (const flag of result.flags) {
          if (flag.key) {
            flags.push({
              key: flag.key,
              value: flag.value,
              valueType: this.getFlagType(flag),
              reason: flag.reason ?? null,
              variant: flag.variant ?? null,
            });
          }
        }
      }

      return flags;
    } catch (error) {
      console.error('Error evaluating all flags:', error);
      return [];
    }
  }

  /**
   * Evaluate a single flag and return its evaluation result.
   *
   * Note: This method makes direct HTTP calls for demo purposes.
   * For standard flag evaluation, use the OpenFeature client methods.
   *
   * @param flagKey The flag key to evaluate
   * @param context The evaluation context
   * @returns The flag evaluation, or null if the flag doesn't exist
   */
  async evaluateFlag(flagKey: string, context: EvaluationContext): Promise<FlagEvaluation | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/ofrep/v1/evaluate/flags/${flagKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          ...this.getTelemetryHeaders(),
        },
        body: JSON.stringify({
          context: this.transformContext(context),
        }),
      });

      if (!response.ok) {
        return null;
      }

      const result = await response.json();

      return {
        key: result.key ?? flagKey,
        value: result.value,
        valueType: this.getFlagType(result),
        reason: result.reason ?? null,
        variant: result.variant ?? null,
      };
    } catch (error) {
      console.error(`Error evaluating flag '${flagKey}':`, error);
      return null;
    }
  }
}
