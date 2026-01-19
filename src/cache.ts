import type { FlagChangeEvent } from './types';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Simple in-memory cache for flag values with TTL support.
 */
export class FlagCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;

  /**
   * Create a new FlagCache.
   * @param ttlMs Time-to-live in milliseconds (default: 5 minutes)
   */
  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Get a value from the cache.
   * Returns undefined if the key doesn't exist or has expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
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
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Invalidate a specific key or all keys if no key is provided.
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
      this.invalidate();
    }
  }
}
