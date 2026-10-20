// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { workflowInputs, type BuildRequest } from '../../src/build/plan';
import { TEMPLATE_FILES, WORKFLOW_FILES, compareTemplate, installTemplates, templateStatus, workflowTemplate } from '../../src/github/workflows';
import { defaultConfig } from '../../src/projects/config';
import { MemoryFsBackend } from '../../src/fs/backend';
import { Vfs } from '../../src/fs/vfs';

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Workflow {
  name: string;
  'run-name': string;
  permissions: Record<string, string>;
  on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[]; default?: unknown }> } };
  jobs: Record<string, { 'runs-on': string; steps: Step[]; env?: Record<string, string> }>;
}

const workflows = Object.values(WORKFLOW_FILES).map((file) => {
  const template = workflowTemplate(file);
  if (!template) throw new Error(`missing template ${file}`);
  return { file, doc: parseYaml(template.content) as Workflow, text: template.content };
});

const ALLOWED_ACTIONS = new Set(['actions/checkout@v7', 'actions/setup-node@v7', 'actions/setup-python@v7', 'actions/upload-artifact@v7', 'actions/cache@v6']);

describe('workflow templates', () => {
  it.each(workflows.map((w) => [w.file, w] as const))('%s is dispatchable, minimal and injection-safe', (_file, { doc, text }) => {
    expect(doc.permissions).toEqual({ contents: 'read' });
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).length).toBeLessThanOrEqual(10);
    expect(inputs.terminia_build_id).toBeDefined();
    expect(doc['run-name']).toContain('${{ inputs.terminia_build_id }}');
    for (const job of Object.values(doc.jobs)) {
      for (const step of job.steps) {
        if (step.uses) expect(ALLOWED_ACTIONS.has(step.uses), `unvetted action ${step.uses}`).toBe(true);
        // Untrusted values only reach scripts through env:, never through ${{ }} inside run:.
        if (step.run) expect(step.run).not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
        if (step.run) expect(step.run).not.toMatch(/\$\{\{\s*secrets\./);
      }
    }
    // Every CI script a workflow calls ships with Terminia.
    for (const match of text.matchAll(/\.terminia\/ci\/([a-z0-9-]+\.(?:sh|mjs))/g)) {
      expect(TEMPLATE_FILES.some((t) => t.path === `.terminia/ci/${match[1]}`), match[1]).toBe(true);
    }
  });

  it('accepts exactly the inputs Terminia sends, with valid choices', () => {
    const config = defaultConfig();
    const requests: BuildRequest[] = [
      { kind: 'build', platform: 'ios', overrides: { configuration: 'debug', exportMethod: 'ad-hoc' } },
      { kind: 'build', platform: 'ios' },
      { kind: 'build', platform: 'android', overrides: { variant: 'release', output: 'both' } },
      { kind: 'build', platform: 'web', overrides: { kind: 'python', runner: 'macos' } },
      { kind: 'deps', platform: 'web', deps: { ecosystem: 'cocoapods', operation: 'install', packages: [], dev: false } },
      { kind: 'deps', platform: 'web', deps: { ecosystem: 'npm', operation: 'add', packages: ['lodash@^4'], dev: true } },
    ];
    for (const request of requests) {
      const mapped = workflowInputs(request, config, 'abc123def456');
      const doc = workflows.find((w) => w.file === mapped.workflow)!.doc;
      const declared = doc.on.workflow_dispatch.inputs;
      for (const [key, value] of Object.entries(mapped.inputs)) {
        expect(declared[key], `${mapped.workflow} does not declare ${key}`).toBeDefined();
        if (declared[key]!.type === 'choice') expect(declared[key]!.options).toContain(String(value));
        if (declared[key]!.type === 'boolean') expect(typeof value).toBe('boolean');
      }
    }
  });

  it('runs iOS on macOS and Android on Linux, and only signs with secrets via env', () => {
    const ios = workflows.find((w) => w.file === 'terminia-ios.yml')!;
    const android = workflows.find((w) => w.file === 'terminia-android.yml')!;
    expect(ios.doc.jobs.build!['runs-on']).toBe('macos-26');
    expect(android.doc.jobs.build!['runs-on']).toBe('ubuntu-24.04');
    const importStep = ios.doc.jobs.build!.steps.find((s) => s.run?.includes('ios-import-signing.sh'))!;
    expect(importStep.env?.IOS_CERTIFICATE_P12_BASE64).toBe('${{ secrets.IOS_CERTIFICATE_P12_BASE64 }}');
    const upload = ios.doc.jobs.build!.steps.find((s) => s.with?.name === '${{ steps.build.outputs.ipa_name }}')!;
    expect(upload.with?.['if-no-files-found']).toBe('error');
  });

  it.skipIf(spawnSync('bash', ['--version']).status !== 0)('all CI shell scripts parse with bash -n', () => {
    for (const t of TEMPLATE_FILES.filter((t) => t.path.endsWith('.sh'))) {
      const result = spawnSync('bash', ['-n'], { input: t.content, encoding: 'utf8' });
      expect(result.status, `${t.path}: ${result.stderr}`).toBe(0);
    }
  });

  it('installs into a project and reports edited files without overwriting them', async () => {
    const backend = new MemoryFsBackend('workspace');
    const vfs = new Vfs([{ path: '/workspace', backend, label: 'w', kind: 'workspace' }]);
    await vfs.mkdir('/workspace/app', { recursive: true });
    const first = await installTemplates(vfs, '/workspace/app');
    expect(first.written.length).toBe(TEMPLATE_FILES.length);
    const ios = '/workspace/app/.github/workflows/terminia-ios.yml';
    await vfs.writeText(ios, `${(await vfs.readText(ios)).text}\n# my edit\n`);
    const second = await installTemplates(vfs, '/workspace/app');
    expect(second.written).toEqual([]);
    expect(second.skipped.map((s) => [s.path, s.state])).toEqual([['.github/workflows/terminia-ios.yml', 'modified']]);
    expect((await templateStatus(vfs, '/workspace/app')).find((s) => s.path.endsWith('terminia-ios.yml'))!.state).toBe('modified');
    const forced = await installTemplates(vfs, '/workspace/app', { force: true });
    expect(forced.written).toEqual(['.github/workflows/terminia-ios.yml']);
  });

  it('classifies template versions', () => {
    const t = TEMPLATE_FILES[0]!;
    expect(compareTemplate(t, null).state).toBe('missing');
    expect(compareTemplate(t, t.content.replace(/\n/g, '\r\n')).state).toBe('current');
    expect(compareTemplate(t, t.content.replace(` v${t.version}`, ' v0')).state).toBe('outdated');
    expect(compareTemplate(t, 'name: something else\n').state).toBe('foreign');
  });
});
