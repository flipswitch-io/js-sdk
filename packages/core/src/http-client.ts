import type { EvaluationContext } from '@openfeature/core';
import type { FlagEvaluation } from './types';

/**
 * HTTP client for direct Flipswitch flag evaluation.
 * Used by both web and server providers for bulk/single flag evaluation
 * outside of the standard OpenFeature interface.
 */
export class FlipswitchHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch,
    private readonly telemetryHeaders: Record<string, string>,
  ) {}

  /**
   * Evaluate all flags for the given context.
   */
  async evaluateAllFlags(context: EvaluationContext): Promise<FlagEvaluation[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/ofrep/v1/evaluate/flags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          ...this.telemetryHeaders,
        },
        body: JSON.stringify({
          context: transformContext(context),
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
              valueType: getFlagType(flag),
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
   */
  async evaluateFlag(flagKey: string, context: EvaluationContext): Promise<FlagEvaluation | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/ofrep/v1/evaluate/flags/${flagKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          ...this.telemetryHeaders,
        },
        body: JSON.stringify({
          context: transformContext(context),
        }),
      });

      if (!response.ok) {
        return null;
      }

      const result = await response.json();

      return {
        key: result.key ?? flagKey,
        value: result.value,
        valueType: getFlagType(result),
        reason: result.reason ?? null,
        variant: result.variant ?? null,
      };
    } catch (error) {
      console.error(`Error evaluating flag '${flagKey}':`, error);
      return null;
    }
  }
}

/**
 * Transform OpenFeature context to OFREP context format.
 */
export function transformContext(context: EvaluationContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (context.targetingKey) {
    result.targetingKey = context.targetingKey;
  }

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
export function inferType(value: unknown): FlagEvaluation['valueType'] {
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
export function getFlagType(flag: { value?: unknown; metadata?: { flagType?: string } }): FlagEvaluation['valueType'] {
  if (flag.metadata?.flagType) {
    const metaType = flag.metadata.flagType;
    if (metaType === 'boolean' || metaType === 'string' || metaType === 'integer' || metaType === 'decimal') {
      return metaType === 'integer' || metaType === 'decimal' ? 'number' : metaType;
    }
  }
  return inferType(flag.value);
}

/**
 * Format a value for display.
 */
export function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
