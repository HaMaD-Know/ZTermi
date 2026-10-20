// @vitest-environment node
/**
 * End-to-end flows against the MOCK GitHub API in tests/support/fake-github.ts.
 * These exercise Terminia's real client, sync, build manager, artifact and
 * dependency code - they are not real cloud builds.
 */
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { FakeGitHub, type RunScript } from '../support/fake-github';
import { createHarness, type Harness } from '../support/harness';

const enc = (s: string) => new TextEncoder().encode(s);
const IPA = zipSync({ 'Payload/MyApp.app/Info.plist': enc('<plist/>'), 'Payload/MyApp.app/MyApp': new Uint8Array([1, 2, 3, 4]) });
const APK = zipSync({ 'AndroidManifest.xml': enc('<manifest/>'), 'classes.dex': new Uint8Array([100, 101, 120]) });

async function setup(options: { secrets?: string[]; prepare?: boolean; repoFiles?: Record<string, string> } = {}): Promise<{ gh: FakeGitHub; h: Harness }> {
  const gh = new FakeGitHub();
  gh.addRepo('ada', 'myapp', { secrets: options.secrets, files: options.repoFiles });
  const h = createHarness({ fetch: gh.fetch });
  h.vault.store({ id: 'github', label: 'GitHub', kind: 'github-classic', allowedOrigins: ['https://api.github.com'] }, gh.token);
  expect((await h.run('terminia project new capacitor MyApp')).code).toBe(0);
  expect((await h.run('terminia github use ada/myapp')).code).toBe(0);
  expect((await h.run('terminia ci install')).code).toBe(0);
  if (options.prepare !== false) {
    const prepared = await h.run('terminia github prepare --yes');
    expect(prepared.code, prepared.all).toBe(0);
  }
  return { gh, h };
}

function script(partial: Partial<RunScript>): RunScript {
  return { outcome: 'success', pollsUntilRunning: 1, pollsUntilDone: 3, artifacts: [], ...partial };
}

describe('iOS build through GitHub Actions (mock API)', () => {
  it('syncs, dispatches with the template inputs, follows the run and downloads the real IPA', async () => {
    const { gh, h } = await setup();
    gh.nextScript = script({
      artifacts: [{ name: 'MyApp-release-unsigned.ipa', data: IPA, zipped: true }],
      result: { platform: 'ios', file: 'MyApp-release-unsigned.ipa', signed: false },
    });
    const build = await h.run('terminia ios build --yes');
    expect(build.code, build.all).toBe(0);
    expect(build.all).toContain('Build succeeded');

    const repo = gh.repos.get('ada/myapp')!;
    const run = repo.runs[0]!;
    const record = h.services.builds.latest('ios')!;
    expect(record.status).toBe('succeeded');
    expect(run.title).toContain(record.id);
    expect(run.inputs).toMatchObject({ configuration: 'release', export_method: 'unsigned', project_path: '.', generate_native: 'true', terminia_build_id: record.id });
    expect(record.result).toMatchObject({ platform: 'ios', signed: false });
    // The synced project is on GitHub, the build ran on that commit.
    expect(gh.fileAt('ada/myapp', 'main', 'capacitor.config.json')).toContain('"webDir": "www"');
    expect(run.headSha).toBe(record.commitSha);

    const download = await h.run('terminia ios download');
    expect(download.code, download.all).toBe(0);
    expect(download.all).toContain("matches GitHub's digest");
    expect(download.all).toContain('Unsigned IPA');
    const item = h.services.artifacts.downloads()[0]!;
    expect(item.kind).toBe('ipa');
    expect(item.file).toBe('/workspace/Artifacts/ios-run1/MyApp-release-unsigned.ipa');
    // The wrapper zip was removed: the stored file IS the IPA.
    expect(new Uint8Array(await h.services.vfs.readBytes(item.file))).toEqual(IPA);

    expect((await h.run('terminia artifacts save')).code).toBe(0);
    expect(h.documents.exported).toEqual(['workspace:Artifacts/ios-run1/MyApp-release-unsigned.ipa']);
  });

  it('uses the run id returned by the dispatch API when available', async () => {
    const { gh, h } = await setup();
    gh.dispatchMode = 'run-details';
    gh.nextScript = script({});
    expect((await h.run('terminia ios build --yes --no-follow')).code).toBe(0);
    expect(gh.requests.some((r) => r.path.includes('/actions/workflows/terminia-ios.yml/runs'))).toBe(false);
    expect(h.services.builds.latest('ios')!.runId).toBe(gh.repos.get('ada/myapp')!.runs[0]!.id);
  });

  it('stops at "waiting for signing configuration" without dispatching when secrets are missing', async () => {
    const { gh, h } = await setup();
    const r = await h.run('terminia ios build --export ad-hoc --yes');
    expect(r.code).toBe(1);
    expect(r.all).toContain('Waiting for signing configuration');
    expect(r.all).toContain('IOS_CERTIFICATE_P12_BASE64');
    expect(h.services.builds.latest('ios')!.status).toBe('waiting_for_signing');
    expect(gh.repos.get('ada/myapp')!.runs).toHaveLength(0);
  });

  it('dispatches a signed export when the secrets exist', async () => {
    const { gh, h } = await setup({ secrets: ['IOS_CERTIFICATE_P12_BASE64', 'IOS_CERTIFICATE_PASSWORD', 'IOS_PROVISIONING_PROFILE_BASE64'] });
    gh.nextScript = script({});
    expect((await h.run('terminia ios build --export ad-hoc --yes --no-follow')).code).toBe(0);
    expect(gh.repos.get('ada/myapp')!.runs[0]!.inputs.export_method).toBe('ad-hoc');
  });

  it('reports a failed build with the error annotation and real logs', async () => {
    const { gh, h } = await setup();
    gh.nextScript = script({ outcome: 'failure', failure: { title: 'xcodebuild-device failed (exit 65)', message: "error: No such module 'Capacitor'" } });
    const r = await h.run('terminia ios build --yes');
    expect(r.code).toBe(1);
    const record = h.services.builds.latest('ios')!;
    expect(record.status).toBe('failed');
    expect(record.error?.message).toContain("No such module 'Capacitor'");
    const logs = await h.run('terminia ios logs');
    expect(logs.out).toContain('building...');
    expect(logs.all).toContain('▸ Run build');
    expect(logs.err).toContain("No such module 'Capacitor'");
  });

  it('cancels a running build through the API', async () => {
    const { gh, h } = await setup();
    gh.nextScript = script({ pollsUntilDone: 1000 });
    expect((await h.run('terminia ios build --yes --no-follow')).code).toBe(0);
    const id = h.services.builds.latest('ios')!.id;
    expect((await h.run('terminia ios cancel')).code).toBe(0);
    await h.services.builds.waitFor(id, () => undefined);
    expect(h.services.builds.get(id)!.status).toBe('cancelled');
  });

  it('refuses an expired artifact and a corrupted download', async () => {
    const { gh, h } = await setup();
    gh.nextScript = script({ artifacts: [{ name: 'old.ipa', data: IPA, zipped: true, expired: true }] });
    await h.run('terminia ios build --yes');
    expect((await h.run('terminia ios download')).err).toContain('expired');

    gh.nextScript = script({ artifacts: [{ name: 'bad.ipa', data: IPA, zipped: false, digest: 'wrong' }] });
    await h.run('terminia ios build --yes');
    expect((await h.run('terminia ios download')).err).toContain('integrity check');
    expect(h.services.artifacts.downloads()).toHaveLength(0);
  });

  it('shows history and status from stored records', async () => {
    const { gh, h } = await setup();
    gh.nextScript = script({});
    await h.run('terminia ios build --yes');
    expect((await h.run('terminia ios history')).out).toMatch(/Succeeded\s+#1\s+release · unsigned/);
    expect((await h.run('terminia ios status')).out).toContain('Succeeded');
  });
});

describe('Android build (mock API)', () => {
  it('requires signing for release and builds a debug APK uploaded without zipping', async () => {
    const { gh, h } = await setup();
    const release = await h.run('terminia android build --variant release --yes');
    expect(release.all).toContain('ANDROID_KEYSTORE_BASE64');
    expect(gh.repos.get('ada/myapp')!.runs).toHaveLength(0);

    gh.nextScript = script({ artifacts: [{ name: 'app-debug.apk', data: APK, zipped: false }] });
    const debug = await h.run('terminia android build --variant debug --yes');
    expect(debug.code, debug.all).toBe(0);
    expect(gh.repos.get('ada/myapp')!.runs[0]!.inputs).toMatchObject({ variant: 'debug', output: 'apk', module: 'app', java_version: '21' });
    const download = await h.run('terminia android download');
    expect(download.all).toContain('cannot be installed on an iPad');
    expect(h.services.artifacts.downloads()[0]!.kind).toBe('apk');
  });
});

describe('project sync (mock API)', () => {
  it('never uploads secrets and lists what was blocked', async () => {
    const { gh, h } = await setup();
    // The template's .gitignore already excludes .env and *.p12; remove it to prove the scanner blocks them on its own.
    await h.services.vfs.remove('/workspace/MyApp/.gitignore');
    await h.services.vfs.writeText('/workspace/MyApp/.env', 'API_KEY=abc123456');
    await h.services.vfs.writeBytes('/workspace/MyApp/ios/cert.p12', new Uint8Array([1, 2, 3]));
    await h.services.vfs.writeText('/workspace/MyApp/www/config.js', `const token = '${'ghp_' + 'Q'.repeat(36)}';`);
    await h.services.vfs.writeText('/workspace/MyApp/www/ok.js', 'export const ok = true;\n');
    const preview = await h.run('terminia git status');
    expect(preview.out).toContain('www/ok.js');
    expect(preview.out).toMatch(/\.env: environment file/);
    expect(preview.out).toMatch(/ios\/cert\.p12: certificate with private key/);
    expect(preview.out).toMatch(/www\/config\.js: GitHub token/);
    expect((await h.run('terminia git sync --yes')).code).toBe(0);
    expect(gh.fileAt('ada/myapp', 'main', 'www/ok.js')).toContain('ok = true');
    for (const p of ['.env', 'ios/cert.p12', 'www/config.js']) expect(gh.fileAt('ada/myapp', 'main', p)).toBeNull();
  });

  it('shows a diff against GitHub and leaves remote-only files unless --delete', async () => {
    const { gh, h } = await setup({ repoFiles: { 'README.md': '# old\n', 'legacy/notes.md': 'old notes\n' } });
    await h.services.vfs.writeText('/workspace/MyApp/www/app.js', "console.log('changed');\n");
    const diff = await h.run('terminia git diff www/app.js');
    expect(diff.all).toContain("+console.log('changed');");
    expect((await h.run('terminia git sync --yes')).code).toBe(0);
    // legacy/notes.md exists only on GitHub: kept by default, deleted only with --delete.
    expect(gh.fileAt('ada/myapp', 'main', 'legacy/notes.md')).toBe('old notes\n');
    expect((await h.run('terminia git status')).out).toContain('Kept on GitHub (not in this project): 1 file(s)');
    expect((await h.run('terminia git sync --delete --yes')).code).toBe(0);
    expect(gh.fileAt('ada/myapp', 'main', 'legacy/notes.md')).toBeNull();
  });

  it('refuses to overwrite a branch that moved after the preview (no force push)', async () => {
    const { gh, h } = await setup();
    await h.services.vfs.writeText('/workspace/MyApp/www/app.js', 'v2\n');
    const { planSync, executeSync } = await import('../../src/github/sync');
    const gh2 = h.services.github.client();
    const plan = await planSync(gh2, h.services.vfs, '/workspace/MyApp', { owner: 'ada', repo: 'myapp', branch: 'main' });
    gh.addRepo('ada', 'tmp');
    // Someone else pushes to main in between.
    const repo = gh.repos.get('ada/myapp')!;
    const head = repo.refs.get('main')!;
    const other = [...repo.commits.keys()].find((k) => k !== head)!;
    repo.refs.set('main', other);
    await expect(executeSync(gh2, h.services.vfs, '/workspace/MyApp', plan, { message: 'x' })).rejects.toThrow(/changed on GitHub after the preview/);
  });

  it('initialises an empty repository through the contents API', async () => {
    const gh = new FakeGitHub();
    gh.addRepo('ada', 'fresh', { empty: true });
    const h = createHarness({ fetch: gh.fetch });
    h.vault.store({ id: 'github', label: 'GitHub', kind: 'github-classic', allowedOrigins: ['https://api.github.com'] }, gh.token);
    await h.run('terminia project new web Site');
    await h.run('terminia github use ada/fresh');
    const sync = await h.run('terminia git sync --yes');
    expect(sync.code, sync.all).toBe(0);
    expect(gh.fileAt('ada/fresh', 'main', 'index.html')).toContain('<h1>Site</h1>');
    expect(gh.fileAt('ada/fresh', 'main', 'README.md')).toContain('# Site');
  });

  it('blocks a build when the workflow is not on the default branch', async () => {
    const { h } = await setup({ prepare: false });
    const r = await h.run('terminia ios build --branch feature --yes');
    expect(r.code).toBe(1);
    expect(r.all).toContain('terminia github prepare');
  });
});

describe('GitHub errors (mock API)', () => {
  it('explains a rejected credential', async () => {
    const gh = new FakeGitHub();
    gh.addRepo('ada', 'myapp');
    const h = createHarness({ fetch: gh.fetch });
    h.vault.store({ id: 'github', label: 'GitHub', kind: 'github-classic', allowedOrigins: ['https://api.github.com'] }, 'ghp_wrong_token_000000000000000000000000');
    const r = await h.run('terminia github repos');
    expect(r.err).toContain('rejected the credential');
    expect(r.info).toContain('terminia github login');
  });

  it('retries server errors and secondary rate limits for reads', async () => {
    const { gh, h } = await setup();
    gh.failNext(/^\/user\/repos$/, 502);
    gh.failNext(/^\/user\/repos$/, 403, { headers: { 'retry-after': '1' }, body: { message: 'You have exceeded a secondary rate limit' } });
    const r = await h.run('terminia github repos');
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain('ada/myapp');
  });

  it('does not retry a dispatch and reports the provider error', async () => {
    const { gh, h } = await setup();
    gh.failNext(/dispatches$/, 500, { method: 'POST' });
    const r = await h.run('terminia ios build --yes');
    expect(r.code).toBe(1);
    expect(r.err).toContain('GitHub is having problems (500)');
    expect(gh.requests.filter((q) => q.path.endsWith('/dispatches'))).toHaveLength(1);
  });
});

describe('dependency installs on GitHub Actions (mock API)', () => {
  it('runs npm on a runner and applies the lockfile it produced after confirmation', async () => {
    const { gh, h } = await setup();
    const lock = `${JSON.stringify({ name: 'myapp', lockfileVersion: 3, packages: { 'node_modules/@capacitor/core': { version: '8.5.3' } } }, null, 2)}\n`;
    const result = zipSync({
      'deps-result/report.json': enc(JSON.stringify({ ecosystem: 'npm', operation: 'install', packages: [], changed: ['package-lock.json'] })),
      'deps-result/files/package-lock.json': enc(lock),
      'logs/npm-install.log': enc('added 12 packages'),
    });
    gh.nextScript = script({ artifacts: [{ name: 'terminia-deps-result', data: result, zipped: false }] });
    const r = await h.run('terminia deps install --yes');
    expect(r.code, r.all).toBe(0);
    const run = gh.repos.get('ada/myapp')!.runs[0]!;
    expect(run.workflowFile).toBe('terminia-deps.yml');
    expect(run.inputs).toMatchObject({ ecosystem: 'npm', operation: 'install', packages: '' });
    expect((await h.services.vfs.readText('/workspace/MyApp/package-lock.json')).text).toBe(lock);
    const list = await h.run('terminia deps list');
    expect(list.out).toMatch(/@capacitor\/core\s+8\.5\.3\s+8\.5\.3/);
  });

  it('validates package names before anything is dispatched', async () => {
    const { gh, h } = await setup();
    const r = await h.run('terminia deps update "git+https://evil.example/x.git" --yes');
    expect(r.code).toBe(2);
    expect(gh.repos.get('ada/myapp')!.runs).toHaveLength(0);
  });
});
