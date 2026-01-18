import type {
  EvaluationContext,
  JsonValue,
  Logger,
  ProviderMetadata,
  ResolutionDetails,
} from '@openfeature/core';
import { ErrorCode } from '@openfeature/core';
import { SseClient } from './sse-client';
import { FlagCache } from './cache';
import type { FlipswitchOptions, FlagChangeEvent, SseConnectionStatus, FlipswitchEventHandlers, FlagEvaluation } from './types';

type ProviderStatus = 'NOT_READY' | 'READY' | 'ERROR' | 'STALE';
type ProviderEvent = 'PROVIDER_READY' | 'PROVIDER_ERROR' | 'PROVIDER_STALE' | 'PROVIDER_CONFIGURATION_CHANGED';
type EventHandler = () => void;

const DEFAULT_BASE_URL = 'https://api.flipswitch.dev';

/**
 * Flipswitch OpenFeature provider with real-time SSE support.
 *
 * This provider wraps OFREP-compatible flag evaluation with
 * automatic cache invalidation via Server-Sent Events.
 *
 * @example
 * ```typescript
 * import { FlipswitchProvider } from '@flipswitch/sdk';
 * import { OpenFeature } from '@openfeature/web-sdk';
 *
 * // Only API key is required - defaults to https://api.flipswitch.dev
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
  private readonly cache: FlagCache;
  private sseClient: SseClient | null = null;
  private _status: ProviderStatus = 'NOT_READY';
  private eventHandlers = new Map<ProviderEvent, Set<EventHandler>>();
  private userEventHandlers: FlipswitchEventHandlers = {};

  constructor(options: FlipswitchOptions, eventHandlers?: FlipswitchEventHandlers) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.enableRealtime = options.enableRealtime ?? true;
    this.fetchImpl = options.fetchImplementation ?? (typeof window !== 'undefined' ? fetch.bind(window) : fetch);
    this.cache = new FlagCache(options.pollingInterval ?? 30000);
    this.userEventHandlers = eventHandlers ?? {};
  }

  get status(): ProviderStatus {
    return this._status;
  }

  /**
   * Initialize the provider.
   * Validates the API key and starts SSE connection if real-time is enabled.
   */
  async initialize(_context?: EvaluationContext): Promise<void> {
    this._status = 'NOT_READY';

    // Validate API key by making a bulk evaluation request
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
    } catch (error) {
      this._status = 'ERROR';
      throw error;
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
    this.cache.clear();
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
   */
  private handleFlagChange(event: FlagChangeEvent): void {
    this.cache.handleFlagChange(event);
    this.userEventHandlers.onFlagChange?.(event);
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
  // Flag Resolution Methods
  // ===============================

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolveFlag<boolean>(flagKey, defaultValue, context, 'boolean');
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<string>> {
    return this.resolveFlag<string>(flagKey, defaultValue, context, 'string');
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<number>> {
    return this.resolveFlag<number>(flagKey, defaultValue, context, 'number');
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    _logger: Logger
  ): Promise<ResolutionDetails<T>> {
    return this.resolveFlag<T>(flagKey, defaultValue, context, 'object');
  }

  /**
   * Core flag resolution logic using OFREP.
   */
  private async resolveFlag<T>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    expectedType: 'boolean' | 'string' | 'number' | 'object'
  ): Promise<ResolutionDetails<T>> {
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
        if (response.status === 404) {
          return {
            value: defaultValue,
            reason: 'ERROR',
            errorCode: ErrorCode.FLAG_NOT_FOUND,
            errorMessage: `Flag '${flagKey}' not found`,
          };
        }

        const errorBody = await response.text();
        return {
          value: defaultValue,
          reason: 'ERROR',
          errorCode: ErrorCode.GENERAL,
          errorMessage: `OFREP error: ${response.status} - ${errorBody}`,
        };
      }

      const result = await response.json();

      // Validate type matches expected
      const actualType = typeof result.value;
      if (expectedType === 'object') {
        if (actualType !== 'object' || result.value === null) {
          return {
            value: defaultValue,
            reason: 'ERROR',
            errorCode: ErrorCode.TYPE_MISMATCH,
            errorMessage: `Expected object but got ${actualType}`,
          };
        }
      } else if (actualType !== expectedType) {
        return {
          value: defaultValue,
          reason: 'ERROR',
          errorCode: ErrorCode.TYPE_MISMATCH,
          errorMessage: `Expected ${expectedType} but got ${actualType}`,
        };
      }

      return {
        value: result.value as T,
        variant: result.variant,
        reason: result.reason || 'TARGETING_MATCH',
        flagMetadata: result.metadata,
      };
    } catch (error) {
      return {
        value: defaultValue,
        reason: 'ERROR',
        errorCode: ErrorCode.GENERAL,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

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
  // Bulk Flag Evaluation
  // ===============================

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
