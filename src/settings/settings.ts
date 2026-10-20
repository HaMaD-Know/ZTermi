import { v, type Infer } from '../core/validate';
import { Emitter } from '../core/util';
import { JsonDocument, type KeyValueStore } from '../platform/kv';

/**
 * App settings. Non-secret only: tokens live in the Vault. The GitHub OAuth
 * client id is public by design (device flow does not use a client secret).
 */
const settingsSchema = v.object({
  theme: v.oneOf(['dark', 'light', 'system'] as const, 'dark'),
  fontSize: v.withDefault(v.number(), 14),
  showTimestamps: v.withDefault(v.boolean(), false),
  sidebarCollapsed: v.withDefault(v.boolean(), false),
  githubClientId: v.withDefault(v.string(), ''),
  pollIntervalSeconds: v.withDefault(v.number(), 6),
  maxArtifactMegabytes: v.withDefault(v.number(), 2048),
});

export type Settings = Infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontSize: 14,
  showTimestamps: false,
  sidebarCollapsed: false,
  githubClientId: '',
  pollIntervalSeconds: 6,
  maxArtifactMegabytes: 2048,
};

function sanitize(s: Settings): Settings {
  return {
    ...s,
    fontSize: Math.min(24, Math.max(10, Math.round(s.fontSize))),
    pollIntervalSeconds: Math.min(60, Math.max(3, Math.round(s.pollIntervalSeconds))),
    maxArtifactMegabytes: Math.min(8192, Math.max(16, Math.round(s.maxArtifactMegabytes))),
    githubClientId: /^[A-Za-z0-9._-]{0,64}$/.test(s.githubClientId.trim()) ? s.githubClientId.trim() : '',
  };
}

export class SettingsService extends Emitter<{ changed: Settings }> {
  private doc: JsonDocument<Settings>;
  private current: Settings = { ...DEFAULT_SETTINGS };

  constructor(store: KeyValueStore) {
    super();
    this.doc = new JsonDocument(store, 'terminia.settings', settingsSchema, () => ({ ...DEFAULT_SETTINGS }));
  }

  async load(): Promise<Settings> {
    this.current = sanitize({ ...DEFAULT_SETTINGS, ...(await this.doc.load()) });
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.current = sanitize({ ...this.current, ...patch });
    await this.doc.save(this.current);
    this.emit('changed', this.current);
    return this.current;
  }
}
