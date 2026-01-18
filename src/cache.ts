import type { FlagChangeEvent } from './types';

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

/**
 * Simple in-memory cache for flag values with TTL support.
 * Automatically invalidated by SSE events.
 */
export class FlagCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Get a cached value if it exists and is not expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * Set a value in the cache.
   */
  set<T>(key: string, value: T): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
    });
  }

  /**
   * Invalidate a specific key or all keys.
   */
  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Handle a flag change event from SSE.
   * Invalidates the specific flag or all flags if flagKey is null.
   */
  handleFlagChange(event: FlagChangeEvent): void {
    if (event.flagKey) {
      this.invalidate(event.flagKey);
    } else {
      // Bulk invalidation
      this.invalidate();
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of entries in the cache.
   */
  size(): number {
    return this.cache.size;
  }
}
