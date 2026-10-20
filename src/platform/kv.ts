import { Preferences } from '@capacitor/preferences';
import { redactDeep } from '../core/redact';
import { parse, type Validator } from '../core/validate';

/**
 * Key-value storage for NON-SECRET state only: settings, project index, build
 * history, connection profiles (without their tokens). On iOS, Preferences is
 * backed by UserDefaults. Secrets go through the Vault, never here.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class PreferencesStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    return (await Preferences.get({ key })).value;
  }

  async set(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value });
  }

  async remove(key: string): Promise<void> {
    await Preferences.remove({ key });
  }
}

export class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/** A typed JSON document in a KeyValueStore. Invalid stored data falls back to the default. */
export class JsonDocument<T> {
  constructor(
    private readonly store: KeyValueStore,
    private readonly key: string,
    private readonly validator: Validator<T>,
    private readonly fallback: () => T,
  ) {}

  async load(): Promise<T> {
    const raw = await this.store.get(this.key);
    if (!raw) return this.fallback();
    try {
      return parse(this.validator, JSON.parse(raw), this.key);
    } catch (error) {
      console.warn(`Ignoring invalid stored ${this.key}:`, (error as Error).message);
      return this.fallback();
    }
  }

  async save(value: T): Promise<void> {
    // Redaction is a second line of defence: nothing secret should be here at all.
    await this.store.set(this.key, JSON.stringify(redactDeep(value)));
  }
}
