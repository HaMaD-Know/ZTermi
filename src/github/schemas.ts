import { v, type Infer } from '../core/validate';

/** Shapes of the GitHub REST responses Terminia uses (only the fields it reads). */

const str = v.string();
const optStr = v.nullable(v.string());
const num = v.number();

export const userSchema = v.object({
  login: str,
  id: num,
  name: optStr,
  avatar_url: v.withDefault(v.string(), ''),
  html_url: v.withDefault(v.string(), ''),
});
export type GitHubUser = Infer<typeof userSchema>;

export const repoSchema = v.object({
  id: num,
  name: str,
  full_name: str,
  private: v.boolean(),
  html_url: str,
  default_branch: v.withDefault(v.string(), 'main'),
  archived: v.withDefault(v.boolean(), false),
  pushed_at: optStr,
  owner: v.object({ login: str }),
  permissions: v.optional(
    v.object({
      admin: v.withDefault(v.boolean(), false),
      push: v.withDefault(v.boolean(), false),
      pull: v.withDefault(v.boolean(), false),
    }),
  ),
});
export type GitHubRepo = Infer<typeof repoSchema>;
export const repoListSchema = v.array(repoSchema);

export const branchSchema = v.object({ name: str, commit: v.object({ sha: str }), protected: v.withDefault(v.boolean(), false) });
export const branchListSchema = v.array(branchSchema);

export const workflowSchema = v.object({
  id: num,
  name: str,
  path: str,
  state: str,
  html_url: v.withDefault(v.string(), ''),
});
export type GitHubWorkflow = Infer<typeof workflowSchema>;
export const workflowListSchema = v.object({ total_count: num, workflows: v.array(workflowSchema) });

export const RUN_STATUSES = ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending', 'action_required'] as const;

export const runSchema = v.object({
  id: num,
  name: optStr,
  display_title: v.withDefault(v.string(), ''),
  run_number: num,
  run_attempt: v.withDefault(v.number(), 1),
  event: str,
  status: v.nullable(v.string()),
  conclusion: v.nullable(v.string()),
  head_branch: optStr,
  head_sha: str,
  html_url: str,
  created_at: str,
  updated_at: str,
  run_started_at: optStr,
  workflow_id: num,
  path: v.withDefault(v.string(), ''),
});
export type GitHubRun = Infer<typeof runSchema>;
export const runListSchema = v.object({ total_count: num, workflow_runs: v.array(runSchema) });

const stepSchema = v.object({
  name: str,
  status: str,
  conclusion: v.nullable(v.string()),
  number: num,
  started_at: optStr,
  completed_at: optStr,
});

export const jobSchema = v.object({
  id: num,
  run_id: num,
  name: str,
  status: str,
  conclusion: v.nullable(v.string()),
  started_at: optStr,
  completed_at: optStr,
  html_url: v.nullable(v.string()),
  runner_name: optStr,
  labels: v.withDefault(v.array(v.string()), []),
  steps: v.withDefault(v.array(stepSchema), []),
});
export type GitHubJob = Infer<typeof jobSchema>;
export const jobListSchema = v.object({ total_count: num, jobs: v.array(jobSchema) });

export const artifactSchema = v.object({
  id: num,
  name: str,
  size_in_bytes: num,
  archive_download_url: str,
  expired: v.boolean(),
  created_at: optStr,
  expires_at: optStr,
  updated_at: optStr,
  digest: v.optional(v.nullable(v.string())),
  workflow_run: v.optional(v.nullable(v.object({ id: v.optional(v.number()), head_branch: v.optional(v.nullable(v.string())), head_sha: v.optional(v.nullable(v.string())) }))),
});
export type GitHubArtifact = Infer<typeof artifactSchema>;
export const artifactListSchema = v.object({ total_count: num, artifacts: v.array(artifactSchema) });

export const annotationSchema = v.object({
  path: v.withDefault(v.string(), ''),
  start_line: v.withDefault(v.number(), 0),
  annotation_level: v.withDefault(v.string(), 'notice'),
  title: v.nullable(v.string()),
  message: v.withDefault(v.string(), ''),
  raw_details: v.nullable(v.string()),
});
export type GitHubAnnotation = Infer<typeof annotationSchema>;
export const annotationListSchema = v.array(annotationSchema);

export const gitRefSchema = v.object({ ref: str, object: v.object({ sha: str, type: str }) });
export const gitCommitSchema = v.object({ sha: str, tree: v.object({ sha: str }), html_url: v.withDefault(v.string(), ''), message: v.withDefault(v.string(), '') });
export const gitTreeSchema = v.object({
  sha: str,
  truncated: v.withDefault(v.boolean(), false),
  tree: v.array(
    v.object({
      path: str,
      mode: str,
      type: str,
      sha: str,
      size: v.optional(v.number()),
    }),
    { max: 500_000 },
  ),
});
export type GitTree = Infer<typeof gitTreeSchema>;
export const blobCreatedSchema = v.object({ sha: str });
export const treeCreatedSchema = v.object({ sha: str });
export const contentPutSchema = v.object({ commit: v.object({ sha: str }) });

export const contentFileSchema = v.object({ type: str, path: str, sha: str, size: v.withDefault(v.number(), 0) });

export const dispatchResultSchema = v.object({
  workflow_run_id: v.optional(v.number()),
  run_url: v.optional(v.string()),
  html_url: v.optional(v.string()),
});

export const secretListSchema = v.object({ total_count: num, secrets: v.array(v.object({ name: str })) });

export const blobSchema = v.object({ content: v.string(), encoding: v.string(), size: v.number() });

export const commitListSchema = v.array(
  v.object({
    sha: str,
    html_url: str,
    commit: v.object({ message: str, author: v.nullable(v.object({ name: v.withDefault(v.string(), ''), date: v.withDefault(v.string(), '') })) }),
  }),
);
