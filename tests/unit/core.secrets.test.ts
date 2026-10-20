import { describe, expect, it } from 'vitest';
import { applyAllowlist, checkSecretFileName, parseSecretAllowlist, scanFile } from '../../src/core/secrets';
import { utf8 } from '../../src/core/hash';

describe('secret file detection', () => {
  it.each([
    ['.env', 'environment file (.env)'],
    ['config/.env.production', 'environment file (.env)'],
    ['ios/cert.p12', 'certificate with private key (PKCS#12)'],
    ['ios/App.mobileprovision', 'Apple provisioning profile'],
    ['AuthKey_ABC123.p8', 'App Store Connect / APNs private key'],
    ['android/release.jks', 'Java keystore (Android signing key)'],
    ['android/app/my.keystore', 'Android keystore (signing key)'],
    ['android/keystore.properties', 'Android signing configuration'],
    ['home/.ssh/id_ed25519', 'SSH private key'],
  ])('blocks %s', (path, reason) => {
    expect(checkSecretFileName(path)).toEqual({ path, severity: 'blocked', reason });
  });

  it('allows example environment files and ordinary files', () => {
    expect(checkSecretFileName('.env.example')).toBeNull();
    expect(checkSecretFileName('src/environment.ts')).toBeNull();
    expect(checkSecretFileName('ios/App/App/Info.plist')).toBeNull();
  });
});

describe('secret content detection', () => {
  it('finds private keys inside .pem files and tokens in source', () => {
    const pem = scanFile('certs/server.pem', utf8('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'));
    expect(pem[0]?.reason).toBe('private key file (.pem)');
    const token = scanFile('src/api.ts', utf8(`const t = '${'ghp_' + 'Z'.repeat(36)}';`));
    expect(token).toEqual([{ path: 'src/api.ts', severity: 'blocked', reason: 'GitHub token', line: 1 }]);
  });

  it('flags hard-coded passwords as suspicious but not type declarations', () => {
    expect(scanFile('src/db.js', utf8('const config = {\n  password: "hunter2-real"\n};'))[0]).toMatchObject({
      severity: 'suspicious',
      line: 2,
    });
    expect(scanFile('src/types.ts', utf8('interface Login { password: string }'))).toEqual([]);
  });

  it('detects npm auth tokens unless they come from the environment', () => {
    expect(scanFile('.npmrc', utf8('//registry.npmjs.org/:_authToken=abc123'))[0]?.severity).toBe('blocked');
    expect(scanFile('.npmrc', utf8('//registry.npmjs.org/:_authToken=${NPM_TOKEN}'))).toEqual([]);
  });

  it('skips binary files and lock files', () => {
    expect(scanFile('img/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))).toEqual([]);
    expect(scanFile('package-lock.json', utf8('"password": "not-a-secret-just-a-name"'))).toEqual([]);
  });

  it('allowlist only clears suspicious findings, never blocked ones', () => {
    const allowed = parseSecretAllowlist('# reviewed\n./src/db.js\n.env\n');
    const findings = [
      { path: 'src/db.js', severity: 'suspicious' as const, reason: 'hard-coded password' },
      { path: '.env', severity: 'blocked' as const, reason: 'environment file (.env)' },
    ];
    expect(applyAllowlist(findings, allowed)).toEqual([findings[1]]);
  });
});
