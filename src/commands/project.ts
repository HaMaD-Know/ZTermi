import { TerminiaError } from '../core/errors';
import { displayPath } from '../core/paths';
import { formatBytes } from '../core/util';
import { describeTypes } from '../projects/detect';
import { bool, str } from '../terminal/args';
import type { CommandSpec } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { abs } from './common';

const PICKER = { kind: 'local', detail: 'document picker' } as const;

const list: CommandSpec = {
  name: 'list',
  aliases: ['ls'],
  summary: 'List projects (workspace and opened folders)',
  target: LOCAL,
  async run(ctx) {
    const projects = await ctx.services.projects.list();
    const current = ctx.services.projects.current();
    if (!projects.length) {
      ctx.out.info('No projects yet. Create one: terminia project new capacitor MyApp (see `terminia project templates`).');
      return;
    }
    ctx.out.table(
      projects.map((p) => [p.path === current?.path ? '*' : '', p.name, p.location === 'folder' ? 'opened folder' : 'workspace', displayPath(p.path)]),
      ['', 'Name', 'Location', 'Path'],
    );
  },
};

const templates: CommandSpec = {
  name: 'templates',
  summary: 'List project templates',
  target: LOCAL,
  async run(ctx) {
    ctx.out.table(ctx.services.projects.templates().map((t) => [t.id, t.name, t.description]), ['Template', 'Name', 'Description']);
  },
};

const create: CommandSpec = {
  name: 'new',
  aliases: ['create'],
  summary: 'Create a project from a template and open it',
  target: LOCAL,
  positionals: [
    { name: 'template', description: 'capacitor, web, node, python, powershell or empty', required: true, complete: 'template' },
    { name: 'name', description: 'Project name', required: true },
  ],
  examples: ['terminia project new capacitor MyApp', 'terminia project new python tools'],
  async run(ctx) {
    const [template, name] = ctx.args.positionals as [string, string];
    const project = await ctx.services.projects.create(template, name);
    await ctx.services.projects.open(project);
    ctx.session.setCwd(project.path);
    ctx.out.success(`Created ${project.name} from the ${template} template in ${displayPath(project.path)}`);
    ctx.out.info('Next: `terminia github use <owner>/<repo>` and `terminia ci install` to build it in the cloud.');
  },
};

const open: CommandSpec = {
  name: 'open',
  aliases: ['use'],
  summary: 'Make a project current and change into it',
  target: LOCAL,
  positionals: [{ name: 'project', description: 'Project name or path (default: the current directory)', complete: 'project' }],
  async run(ctx) {
    const ref = ctx.args.positionals[0];
    const project = ref ? await ctx.services.projects.resolve(ref, ctx.session.cwd()) : await ctx.services.projects.resolve(ctx.session.cwd());
    await ctx.services.projects.open(project);
    ctx.session.setCwd(project.path);
    ctx.out.success(`Opened ${project.name}`);
  },
};

const close: CommandSpec = {
  name: 'close',
  summary: 'Close the current project',
  target: LOCAL,
  async run(ctx) {
    await ctx.services.projects.close();
  },
};

const info: CommandSpec = {
  name: 'info',
  aliases: ['detect'],
  summary: 'Show project type, build targets and configuration',
  target: LOCAL,
  async run(ctx) {
    const project = ctx.services.projects.requireCurrent();
    const detection = await ctx.services.projects.detect(project);
    const config = await ctx.services.projects.config(project);
    ctx.out.writeln(`${project.name}  (${displayPath(project.path)})`);
    ctx.out.writeln(`  Type: ${describeTypes(detection.types)}`);
    if (detection.capacitor) ctx.out.writeln(`  Capacitor: ${detection.capacitor.version ?? '?'} · appId ${detection.capacitor.appId ?? '(not set)'} · webDir ${detection.capacitor.webDir ?? '?'}`);
    if (detection.packageManager) ctx.out.writeln(`  Package manager: ${detection.packageManager}${detection.hasLockfile ? '' : ' (no lockfile)'}`);
    ctx.out.writeln('  Build targets:');
    for (const t of detection.targets) {
      const line = `    ${t.viable ? '✓' : '✗'} ${t.platform}: ${t.reason}`;
      if (t.viable) ctx.out.success(line);
      else ctx.out.muted(line);
      for (const note of t.notes) ctx.out.muted(`        ${note}`);
    }
    if (detection.ambiguous) ctx.out.info('  Several targets are possible: name one explicitly (terminia build ios|android|web).');
    ctx.out.writeln(`  Repository: ${config.github.owner ? `${config.github.owner}/${config.github.repo}@${config.github.branch || '(default branch)'}` : '(not set - terminia github use <owner>/<repo>)'}`);
  },
};

const exportProject: CommandSpec = {
  name: 'export',
  summary: 'Export the project as a zip (secrets and ignored files are left out)',
  target: PICKER,
  options: [
    { name: 'include-ignored', type: 'boolean', description: 'Also include files matched by .gitignore (secrets are still excluded)' },
    { name: 'save', short: 's', type: 'boolean', description: 'Show "Save to Files" afterwards' },
  ],
  async run(ctx) {
    const project = ctx.services.projects.requireCurrent();
    const result = await ctx.services.projects.exportArchive(project, { includeIgnored: bool(ctx.args, 'include-ignored'), signal: ctx.signal });
    ctx.out.success(`Exported ${result.included} file(s) to ${displayPath(result.path)} (${formatBytes(result.zip.byteLength)})`);
    if (result.ignored) ctx.out.muted(`${result.ignored} ignored item(s) left out.`);
    for (const f of result.excluded) ctx.out.warn(`Left out ${f.path}: ${f.reason}`);
    for (const f of result.tooLarge) ctx.out.warn(`Left out ${f}: larger than 100 MB`);
    ctx.out.action('Save to Files…', async () => void (await ctx.services.projects.saveToFiles(result.path)));
    if (bool(ctx.args, 'save')) await ctx.services.projects.saveToFiles(result.path);
  },
};

const importProject: CommandSpec = {
  name: 'import',
  summary: 'Import a project from a zip file you pick in Files',
  target: PICKER,
  options: [{ name: 'name', type: 'string', description: 'Project name (default: the archive name)' }],
  async run(ctx) {
    const project = await ctx.services.projects.importArchiveFromPicker(str(ctx.args, 'name'));
    if (!project) {
      ctx.out.info('Import cancelled.');
      return;
    }
    await ctx.services.projects.open(project);
    ctx.session.setCwd(project.path);
    ctx.out.success(`Imported ${project.name}`);
  },
};

const importFolder: CommandSpec = {
  name: 'import-folder',
  summary: 'Copy a folder you pick in Files into the workspace',
  target: PICKER,
  async run(ctx) {
    const project = await ctx.services.projects.importFolderCopy();
    if (!project) {
      ctx.out.info('Import cancelled.');
      return;
    }
    await ctx.services.projects.open(project);
    ctx.session.setCwd(project.path);
    ctx.out.success(`Copied ${project.name} into the workspace (the original folder is unchanged).`);
  },
};

const openFolder: CommandSpec = {
  name: 'open-folder',
  summary: 'Open a folder in place (iCloud Drive, On My iPad, providers) with the document picker',
  description: 'Terminia gets access only to the folder you choose. iOS keeps a bookmark, so the folder reopens after a restart unless it was moved, deleted or its storage provider signed out - then choose it again.',
  target: PICKER,
  async run(ctx) {
    const project = await ctx.services.projects.openFolder();
    if (!project) {
      ctx.out.info('Cancelled.');
      return;
    }
    await ctx.services.projects.open(project);
    ctx.session.setCwd(project.path);
    ctx.out.success(`Opened folder ${project.name} at ${project.path}`);
  },
};

const folders: CommandSpec = {
  name: 'folders',
  summary: 'List folders opened in place and their access state',
  target: LOCAL,
  async run(ctx) {
    const list = await ctx.services.projects.folders();
    if (!list.length) {
      ctx.out.info(ctx.services.platform.documents.supportsFolders ? 'No folders opened. Use `terminia project open-folder`.' : 'Opening folders in place needs the iPad app.');
      return;
    }
    ctx.out.table(
      list.map((f) => [f.name, f.available ? (f.open ? 'open' : 'not open') : 'unavailable - choose it again', f.stale ? 'bookmark refreshed' : '', f.mountPath ?? '']),
      ['Folder', 'Access', 'Note', 'Path'],
    );
  },
};

const forget: CommandSpec = {
  name: 'forget-folder',
  summary: 'Stop using an opened folder (its files are not touched)',
  target: LOCAL,
  positionals: [{ name: 'folder', description: 'Folder name or /folders/<name> path', required: true }],
  async run(ctx) {
    const ref = ctx.args.positionals[0]!;
    const list = await ctx.services.projects.folders();
    const folder = list.find((f) => f.name.toLowerCase() === ref.toLowerCase() || f.mountPath === abs(ctx, ref));
    if (!folder) throw new TerminiaError('NOT_FOUND', `No opened folder '${ref}'.`);
    await ctx.services.projects.closeFolder(folder.id, true);
    ctx.out.success(`Forgot ${folder.name}. Its files were not changed.`);
  },
};

export const projectGroup: CommandSpec = {
  name: 'project',
  aliases: ['projects'],
  summary: 'Create, open, import and export projects',
  target: LOCAL,
  subcommands: [list, create, open, close, info, templates, exportProject, importProject, importFolder, openFolder, folders, forget],
};
