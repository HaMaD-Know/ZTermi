import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED, clearRegisteredSecrets, redact, redactDeep, registerSecret } from '../../src/core/redact';

// Test fixtures are assembled at runtime so this file itself never contains a
// string that looks like a real credential to scanners.
const ghp = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const fineGrained = 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';

describe('secret redaction', () => {
  afterEach(() => clearRegisteredSecrets());

  it('redacts GitHub tokens of every format', () => {
    expect(redact(`token is ${ghp} ok`)).toBe(`token is ${REDACTED} ok`);
    expect(redact(fineGrained)).toBe(REDACTED);
    expect(redact('gho_' + 'x'.repeat(36))).toBe(REDACTED);
  });

  it('redacts Authorization headers and bearer tokens but keeps the scheme', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redact('authorization=token abc123def456')).toBe(`authorization=token ${REDACTED}`);
  });

  it('redacts private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    const out = redact(`key:\n${pem}\nafter`);
    expect(out).not.toContain('MIIEow');
    expect(out).toContain(REDACTED);
    expect(out).toContain('after');
  });

  it('redacts credentials in URLs and signed query parameters', () => {
    expect(redact('https://user:hunter22@github.com/a/b.git')).toBe(`https://${REDACTED}@github.com/a/b.git`);
    const signed = 'https://blob.core.windows.net/x.zip?sv=2025&sig=AbCdEf%2Bsecret&se=2026';
    expect(redact(signed)).toBe(`https://blob.core.windows.net/x.zip?sv=2025&sig=${REDACTED}&se=2026`);
  });

  it('redacts password-like assignments', () => {
    expect(redact('storePassword=superSecret1')).toBe(`storePassword=${REDACTED}`);
    expect(redact('"password": "p4ssw0rd!"')).toBe(`"password": "${REDACTED}"`);
    expect(redact(`AWS_ACCESS_KEY_ID=${awsKey}`)).toContain(REDACTED);
  });

  it('leaves ordinary output alone', () => {
    const text = 'Compiling App.swift\n** BUILD SUCCEEDED **\nInstalled 42 packages in 3s';
    expect(redact(text)).toBe(text);
  });

  it('redacts registered literal secrets and nested objects', () => {
    registerSecret('my-agent-token-123');
    expect(redact('sent my-agent-token-123 to host')).toBe(`sent ${REDACTED} to host`);
    expect(redactDeep({ headers: { Authorization: 'x' }, note: `t=${ghp}` })).toEqual({
      headers: { Authorization: REDACTED },
      note: `t=${REDACTED}`,
    });
  });
});
