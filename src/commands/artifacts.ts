import { installNote } from '../artifacts/artifacts';
import { TerminiaError } from '../core/errors';
import { displayPath } from '../core/paths';
import { formatBytes, formatDateTime } from '../core/util';
import type { CommandContext, CommandSpec } from '../terminal/types';
import { LOCAL } from '../terminal/types';
import { YES, confirm } from './common';

function find(ctx: CommandContext, ref: string | undefined) {
  const items = ctx.services.artifacts.downloads();
  if (!ref) {
    if (items[0]) return items[0];
    throw new TerminiaError('NOT_FOUND', 'No artifacts downloaded yet.', { hint: 'terminia ios download, or terminia android download' });
  }
  const item = items.find((i) => String(i.artifactId) === ref || i.name === ref || i.file.endsWith(`/${ref}`)) ?? items.find((i) => i.name.toLowerCase().startsWith(ref.toLowerCase()));
  if (!item) throw new TerminiaError('NOT_FOUND', `No downloaded artifact '${ref}'.`);
  return item;
}

const list: CommandSpec = {
  name: 'list',
  aliases: ['ls'],
  summary: 'List downloaded artifacts',
  target: LOCAL,
  async run(ctx) {
    const items = ctx.services.artifacts.downloads();
    if (!items.length) {
      ctx.out.info('No artifacts downloaded yet.');
      return;
    }
    ctx.out.table(
      items.map((i) => [i.name, i.kind, formatBytes(i.size), i.buildId, formatDateTime(i.downloadedAt), displayPath(i.file)]),
      ['Artifact', 'Kind', 'Size', 'Build', 'Downloaded', 'File'],
    );
  },
};

const save: CommandSpec = {
  name: 'save',
  summary: 'Save a downloaded artifact to a location you choose in Files',
  target: { kind: 'local', detail: 'document picker' },
  positionals: [{ name: 'artifact', description: 'Name or id (default: the latest download)' }],
  async run(ctx) {
    const item = find(ctx, ctx.args.positionals[0]);
    const note = installNote(item.kind);
    if (note) ctx.out.info(note);
    const saved = await ctx.services.artifacts.saveToFiles(item);
    ctx.out.info(saved ? `Saved ${item.name}.` : 'Cancelled.');
  },
};

const remove: CommandSpec = {
  name: 'remove',
  aliases: ['rm'],
  summary: 'Delete a downloaded artifact from Terminia › Artifacts',
  target: LOCAL,
  options: [YES],
  positionals: [{ name: 'artifact', description: 'Name or id', required: true }],
  async run(ctx) {
    const item = find(ctx, ctx.args.positionals[0]);
    if (!(await confirm(ctx, { title: 'Delete artifact?', message: `Delete ${displayPath(item.file)} from this iPad? It can be downloaded again until it expires on GitHub.`, confirmLabel: 'Delete', danger: true }))) return 1;
    await ctx.services.artifacts.remove(item);
    ctx.out.success(`Deleted ${item.name}.`);
    return 0;
  },
};

const open: CommandSpec = {
  name: 'open',
  summary: 'Show the Artifacts view',
  target: LOCAL,
  async run(ctx) {
    ctx.services.ui.openView('artifacts');
  },
};

export const artifactsGroup: CommandSpec = {
  name: 'artifacts',
  summary: 'Downloaded build artifacts (IPA, APK, AAB, archives)',
  target: LOCAL,
  subcommands: [list, save, remove, open],
};
