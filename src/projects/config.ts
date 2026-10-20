import { TerminiaError } from '../core/errors';
import { parse, v, type Infer } from '../core/validate';

/**
 * Per-project build and repository configuration, stored in the project as
 * .terminia/config.json. It contains no secrets (signing material lives in
 * GitHub Actions secrets) and is safe to commit.
 */

export const IOS_EXPORT_METHODS = ['unsigned', 'development', 'ad-hoc', 'app-store', 'enterprise'] as const;
export type IosExportMethod = (typeof IOS_EXPORT_METHODS)[number];

export const ANDROID_OUTPUTS = ['apk', 'aab', 'both'] as const;
export const WEB_KINDS = ['web', 'node', 'python', 'custom'] as const;
export type WebKind = (typeof WEB_KINDS)[number];

const RUNNERS = ['linux', 'macos'] as const;

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

const envValidator = v.withDefault(v.record(v.string()), {});

const profileSchema = v.object({
  name: v.string(),
  target: v.oneOf(WEB_KINDS, 'custom'),
  command: v.withDefault(v.string(), ''),
  output: v.withDefault(v.string(), ''),
  runner: v.oneOf(RUNNERS, 'linux'),
  env: envValidator,
});

export const configSchema = v.object({
  version: v.withDefault(v.number(), 1),
  github: v.withDefault(
    v.object({
      owner: v.withDefault(v.string(), ''),
      repo: v.withDefault(v.string(), ''),
      branch: v.withDefault(v.string(), ''),
      projectPath: v.withDefault(v.string(), '.'),
      sync: v.oneOf(['commit', 'none'] as const, 'commit'),
      deleteRemoved: v.withDefault(v.boolean(), false),
    }),
    { owner: '', repo: '', branch: '', projectPath: '.', sync: 'commit', deleteRemoved: false },
  ),
  ios: v.withDefault(
    v.object({
      workflow: v.withDefault(v.string(), 'terminia-ios.yml'),
      configuration: v.oneOf(['debug', 'release'] as const, 'release'),
      exportMethod: v.oneOf(IOS_EXPORT_METHODS, 'unsigned'),
      scheme: v.withDefault(v.string(), ''),
      xcodeVersion: v.withDefault(v.string(), '26.5'),
      generateNative: v.withDefault(v.boolean(), true),
    }),
    { workflow: 'terminia-ios.yml', configuration: 'release', exportMethod: 'unsigned', scheme: '', xcodeVersion: '26.5', generateNative: true },
  ),
  android: v.withDefault(
    v.object({
      workflow: v.withDefault(v.string(), 'terminia-android.yml'),
      variant: v.oneOf(['debug', 'release'] as const, 'debug'),
      output: v.oneOf(ANDROID_OUTPUTS, 'apk'),
      module: v.withDefault(v.string(), 'app'),
      javaVersion: v.withDefault(v.string(), '21'),
      generateNative: v.withDefault(v.boolean(), true),
    }),
    { workflow: 'terminia-android.yml', variant: 'debug', output: 'apk', module: 'app', javaVersion: '21', generateNative: true },
  ),
  web: v.withDefault(
    v.object({
      workflow: v.withDefault(v.string(), 'terminia-build.yml'),
      kind: v.oneOf(WEB_KINDS, 'web'),
      command: v.withDefault(v.string(), ''),
      output: v.withDefault(v.string(), 'dist'),
      nodeVersion: v.withDefault(v.string(), '22'),
      pythonVersion: v.withDefault(v.string(), '3.12'),
    }),
    { workflow: 'terminia-build.yml', kind: 'web', command: '', output: 'dist', nodeVersion: '22', pythonVersion: '3.12' },
  ),
  deps: v.withDefault(
    v.object({ workflow: v.withDefault(v.string(), 'terminia-deps.yml') }),
    { workflow: 'terminia-deps.yml' },
  ),
  profiles: v.withDefault(v.array(profileSchema, { max: 50 }), []),
  remote: v.withDefault(
    v.object({ profile: v.withDefault(v.string(), ''), path: v.withDefault(v.string(), '') }),
    { profile: '', path: '' },
  ),
});

export type ProjectConfig = Infer<typeof configSchema>;
export type BuildProfile = ProjectConfig['profiles'][number];

export function defaultConfig(): ProjectConfig {
  return parse(configSchema, {}, 'project configuration');
}

export const CONFIG_PATH = '.terminia/config.json';

/** Parses and validates .terminia/config.json content, with actionable errors. */
export function parseConfig(text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TerminiaError('VALIDATION', `${CONFIG_PATH} is not valid JSON: ${(error as Error).message}`);
  }
  const config = parse(configSchema, raw, CONFIG_PATH);
  validateConfig(config);
  return config;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$|.*\/$)[A-Za-z0-9._/-]{1,200}$/;
const WORKFLOW = /^[A-Za-z0-9_.-]{1,100}\.ya?ml$/;

export function validateConfig(config: ProjectConfig): void {
  const problems: string[] = [];
  const { github } = config;
  if (github.owner && !NAME.test(github.owner)) problems.push(`github.owner '${github.owner}' is not a valid owner name`);
  if (github.repo && !NAME.test(github.repo)) problems.push(`github.repo '${github.repo}' is not a valid repository name`);
  if (github.branch && !BRANCH.test(github.branch)) problems.push(`github.branch '${github.branch}' is not a valid branch name`);
  if (github.projectPath.includes('..') || github.projectPath.startsWith('/')) problems.push('github.projectPath must be a relative path inside the repository');
  for (const [key, workflow] of [
    ['ios.workflow', config.ios.workflow],
    ['android.workflow', config.android.workflow],
    ['web.workflow', config.web.workflow],
    ['deps.workflow', config.deps.workflow],
  ] as const) {
    if (!WORKFLOW.test(workflow)) problems.push(`${key} must be a workflow file name such as terminia-ios.yml`);
  }
  if (!/^\d+(\.\d+){0,2}$/.test(config.ios.xcodeVersion)) problems.push(`ios.xcodeVersion '${config.ios.xcodeVersion}' is not a version number`);
  if (!/^\d{2}$/.test(config.android.javaVersion)) problems.push(`android.javaVersion '${config.android.javaVersion}' must be a major version such as 21`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.android.module)) problems.push('android.module must be a Gradle module name such as app');
  if (config.ios.scheme && !/^[A-Za-z0-9 _.-]{1,100}$/.test(config.ios.scheme)) problems.push('ios.scheme contains unsupported characters');
  for (const profile of config.profiles) {
    if (!NAME.test(profile.name)) problems.push(`profile name '${profile.name}' is not valid`);
    for (const [key, value] of Object.entries(profile.env)) {
      if (!ENV_NAME.test(key)) problems.push(`profile '${profile.name}': environment variable name '${key}' is not valid`);
      if (/[\r\n]/.test(value)) problems.push(`profile '${profile.name}': ${key} must be a single line`);
    }
    if (profile.output.includes('..') || profile.output.startsWith('/')) problems.push(`profile '${profile.name}': output must be a relative path`);
  }
  if (problems.length) {
    throw new TerminiaError('VALIDATION', `Invalid ${CONFIG_PATH}:\n  - ${problems.join('\n  - ')}`);
  }
}

export function serializeConfig(config: ProjectConfig): string {
  validateConfig(config);
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function repoSlug(config: ProjectConfig): string | null {
  return config.github.owner && config.github.repo ? `${config.github.owner}/${config.github.repo}` : null;
}

export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(slug.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''));
  if (!match) throw new TerminiaError('INVALID_ARGUMENT', `'${slug}' is not a repository. Use owner/name.`);
  return { owner: match[1]!, repo: match[2]! };
}
