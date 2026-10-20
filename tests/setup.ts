import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// jsdom's window may not expose SubtleCrypto; Terminia hashes through Web Crypto.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
