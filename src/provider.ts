import type {
  EvaluationContext,
  JsonValue,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/core';
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import { SseClient } from './sse-client';
import type { FlipswitchOptions, FlagChangeEvent, SseConnectionStatus, FlipswitchEventHandlers, FlagEvaluation } from './types';

type ProviderStatus = 'NOT_READY' | 'READY' | 'ERROR' | 'STALE';
type ProviderEvent = 'PROVIDER_READY' | 'PROVIDER_ERROR' | 'PROVIDER_STALE' | 'PROVIDER_CONFIGURATION_CHANGED';
type EventHandler = () => void;

const DEFAULT_BASE_URL = 'https://api.flipswitch.io';

/**
 * Flipswitch OpenFeature provider with real-time SSE support.
 *
 * This provider wraps the OFREP provider for flag evaluation and adds
 * real-time updates via Server-Sent Events (SSE).
 *
 * @example
 * ```typescript
 * import { FlipswitchProvider } from '@flipswitch/sdk';
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
  private sseClient: SseClient | null = null;
  private _status: ProviderStatus = 'NOT_READY';
  private eventHandlers = new Map<ProviderEvent, Set<EventHandler>>();
  private userEventHandlers: FlipswitchEventHandlers = {};

  constructor(options: FlipswitchOptions, eventHandlers?: FlipswitchEventHandlers) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.enableRealtime = options.enableRealtime ?? true;
    this.fetchImpl = options.fetchImplementation ?? (typeof window !== 'undefined' ? fetch.bind(window) : fetch);
    this.userEventHandlers = eventHandlers ?? {};

    // Create underlying OFREP provider for flag evaluation
    this.ofrepProvider = new OFREPWebProvider({
      baseUrl: this.baseUrl + '/ofrep/v1',
      fetchImplementation: this.fetchImpl,
      headers: [['X-API-Key', this.apiKey]],
    });
  }

  get status(): ProviderStatus {
    return this._status;
  }

  /**
   * Initialize the provider.
   * Validates the API key and starts SSE connection if real-time is enabled.
   */
  async initialize(context?: EvaluationContext): Promise<void> {
    this._status = 'NOT_READY';

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
          },
          body: JSON.stringify({
            context: { targetingKey: '_init_' },
          }),
        });

        if (response.status === 401 || response.status === 403) {
          this._status = 'ERROR';
          throw new Error('Invalid API key');
        }

        if (!response.ok && response.status !== 404) {
          this._status = 'ERROR';
          throw new Error(`Failed to connect to Flipswitch: ${response.status}`);
        }
      } catch (validationError) {
        this._status = 'ERROR';
        throw validationError;
      }
    }

    // Start SSE connection for real-time updates
    if (this.enableRealtime) {
      this.startSseConnection();
    }

    this._status = 'READY';
    this.emit('PROVIDER_READY');
  }

  /**
   * Called when the provider is shut down.
   */
  async onClose(): Promise<void> {
    this.sseClient?.close();
    this.sseClient = null;
    await this.ofrepProvider.onClose?.();
    this._status = 'NOT_READY';
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
        this.userEventHandlers.onConnectionStatusChange?.(status);

        if (status === 'error') {
          this._status = 'STALE';
          this.emit('PROVIDER_STALE');
        } else if (status === 'connected' && this._status === 'STALE') {
          this._status = 'READY';
          this.emit('PROVIDER_READY');
        }
      }
    );

    this.sseClient.connect();
  }

  /**
   * Handle a flag change event from SSE.
   * Emits PROVIDER_CONFIGURATION_CHANGED to trigger re-evaluation.
   */
  private handleFlagChange(event: FlagChangeEvent): void {
    this.userEventHandlers.onFlagChange?.(event);
    // Emit configuration changed event - OpenFeature clients will re-evaluate flags
    this.emit('PROVIDER_CONFIGURATION_CHANGED');
  }

  /**
   * Emit an event to registered handlers.
   */
  private emit(event: ProviderEvent): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      Array.from(handlers).forEach(handler => handler());
    }
  }

  /**
   * Register an event handler.
   */
  onProviderEvent?(event: ProviderEvent, handler: EventHandler): void {
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
