import { config } from '../config';
import { DEFAULT_SETTINGS, type UiSettings } from '../types';

export interface SettingsStore {
  load(): Promise<UiSettings>;
  save(s: UiSettings): Promise<void>;
}

const KEY = 'spoofer:studio:ui_settings';

/**
 * Fallback: the studio app keeps all state in memory only (parity with the
 * original PowerShell app which resets every launch). Used when no Redis
 * is configured.
 */
export class MemorySettingsStore implements SettingsStore {
  async load(): Promise<UiSettings> {
    return { ...DEFAULT_SETTINGS };
  }
  async save(_s: UiSettings): Promise<void> {
    // no-op
  }
}

/**
 * Optional Redis-backed persistence, used when REDIS_URL is set. The
 * application otherwise behaves exactly like the original (defaults on
 * every launch).
 */
export class RedisSettingsStore implements SettingsStore {
  private redis: import('ioredis').Redis | null = null;
  private ready = false;

  constructor(url: string) {
    void this.connect(url);
  }

  private async connect(url: string): Promise<void> {
    try {
      const { Redis } = await import('ioredis');
      const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
      client.on('error', () => {
        /* keep quiet; store falls back to defaults */
      });
      await client.ping();
      this.redis = client;
      this.ready = true;
    } catch {
      this.ready = false;
      this.redis = null;
    }
  }

  async load(): Promise<UiSettings> {
    if (!this.ready || !this.redis) return { ...DEFAULT_SETTINGS };
    try {
      const raw = await this.redis.get(KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw) as Partial<UiSettings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(s: UiSettings): Promise<void> {
    if (!this.ready || !this.redis) return;
    try {
      await this.redis.set(KEY, JSON.stringify(s));
    } catch {
      // persistence is best-effort
    }
  }
}

export function createSettingsStore(): SettingsStore {
  if (config.redisUrl) {
    return new RedisSettingsStore(config.redisUrl);
  }
  return new MemorySettingsStore();
}