/**
 * Browser-based cache for flag values using localStorage.
 * Provides persistence across page reloads and offline support.
 */

const CACHE_PREFIX = 'flipswitch:flags:';
const CACHE_META_KEY = 'flipswitch:cache-meta';

interface CachedFlag {
  value: unknown;
  timestamp: number;
  variant?: string;
  reason?: string;
}

interface CacheMeta {
  lastUpdated: number;
  version: number;
}

/**
 * Browser cache for persisting flag values to localStorage.
 * Falls back gracefully when localStorage is unavailable.
 */
export class BrowserCache {
  private readonly storage: Storage | null;
  private readonly cacheVersion = 1;

  constructor() {
    this.storage = this.getStorage();
  }

  /**
   * Get storage instance if available.
   */
  private getStorage(): Storage | null {
    if (typeof window === 'undefined') return null;

    try {
      const testKey = '__flipswitch_test__';
      window.localStorage.setItem(testKey, 'test');
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    } catch {
      // localStorage not available (private browsing, storage full, etc.)
      return null;
    }
  }

  /**
   * Check if browser cache is available.
   */
  isAvailable(): boolean {
    return this.storage !== null;
  }

  /**
   * Get a cached flag value.
   */
  get(flagKey: string): CachedFlag | null {
    if (!this.storage) return null;

    try {
      const key = CACHE_PREFIX + flagKey;
      const item = this.storage.getItem(key);
      if (!item) return null;

      const cached: CachedFlag = JSON.parse(item);
      return cached;
    } catch {
      return null;
    }
  }

  /**
   * Set a cached flag value.
   */
  set(flagKey: string, value: unknown, variant?: string, reason?: string): void {
    if (!this.storage) return;

    try {
      const key = CACHE_PREFIX + flagKey;
      const cached: CachedFlag = {
        value,
        timestamp: Date.now(),
        variant,
        reason,
      };
      this.storage.setItem(key, JSON.stringify(cached));
      this.updateMeta();
    } catch {
      // Storage full or other error - fail silently
    }
  }

  /**
   * Set multiple cached flag values at once.
   */
  setAll(flags: Array<{ key: string; value: unknown; variant?: string; reason?: string }>): void {
    if (!this.storage) return;

    try {
      for (const flag of flags) {
        const cacheKey = CACHE_PREFIX + flag.key;
        const cached: CachedFlag = {
          value: flag.value,
          timestamp: Date.now(),
          variant: flag.variant,
          reason: flag.reason,
        };
        this.storage.setItem(cacheKey, JSON.stringify(cached));
      }
      this.updateMeta();
    } catch {
      // Storage full or other error - fail silently
    }
  }

  /**
   * Get all cached flags.
   */
  getAll(): Map<string, CachedFlag> {
    const result = new Map<string, CachedFlag>();
    if (!this.storage) return result;

    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith(CACHE_PREFIX)) {
          const flagKey = key.slice(CACHE_PREFIX.length);
          const item = this.storage.getItem(key);
          if (item) {
            const cached: CachedFlag = JSON.parse(item);
            result.set(flagKey, cached);
          }
        }
      }
    } catch {
      // Error reading storage - return what we have
    }

    return result;
  }

  /**
   * Invalidate a specific flag or all flags.
   */
  invalidate(flagKey?: string): void {
    if (!this.storage) return;

    try {
      if (flagKey) {
        this.storage.removeItem(CACHE_PREFIX + flagKey);
      } else {
        // Remove all cached flags
        const keysToRemove: string[] = [];
        for (let i = 0; i < this.storage.length; i++) {
          const key = this.storage.key(i);
          if (key?.startsWith(CACHE_PREFIX)) {
            keysToRemove.push(key);
          }
        }
        for (const key of keysToRemove) {
          this.storage.removeItem(key);
        }
      }
      this.updateMeta();
    } catch {
      // Error clearing storage - fail silently
    }
  }

  /**
   * Update cache metadata.
   */
  private updateMeta(): void {
    if (!this.storage) return;

    try {
      const meta: CacheMeta = {
        lastUpdated: Date.now(),
        version: this.cacheVersion,
      };
      this.storage.setItem(CACHE_META_KEY, JSON.stringify(meta));
    } catch {
      // Error updating meta - fail silently
    }
  }

  /**
   * Get cache metadata.
   */
  getMeta(): CacheMeta | null {
    if (!this.storage) return null;

    try {
      const item = this.storage.getItem(CACHE_META_KEY);
      if (!item) return null;
      return JSON.parse(item);
    } catch {
      return null;
    }
  }

  /**
   * Get the age of a cached flag in milliseconds.
   */
  getAge(flagKey: string): number | null {
    const cached = this.get(flagKey);
    if (!cached) return null;
    return Date.now() - cached.timestamp;
  }

  /**
   * Check if a cached flag is stale based on max age.
   */
  isStale(flagKey: string, maxAgeMs: number): boolean {
    const age = this.getAge(flagKey);
    if (age === null) return true;
    return age > maxAgeMs;
  }

  /**
   * Clear all Flipswitch data from localStorage.
   */
  clear(): void {
    if (!this.storage) return;

    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key?.startsWith('flipswitch:')) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        this.storage.removeItem(key);
      }
    } catch {
      // Error clearing storage - fail silently
    }
  }
}
