import type { Services } from '../../app/services';
import { toTerminiaError } from '../../core/errors';
import type { ManifestInfo } from '../../deps/manifests';
import { button, clear, h } from '../dom';
import { icon } from '../icons';
import { confirmDialog, toast } from '../overlays';
import { emptyState, field, page, select, targetChip } from './common';

/**
 * Dependencies: what each manifest declares and what the lockfile pins.
 * Adding/removing edits the manifest on the iPad; installing runs the real
 * package manager on a GitHub Actions runner or a remote host (in a terminal
 * tab, so the output streams live).
 */
export class DepsView {
  readonly el: HTMLElement;
  private readonly host = h('div');
  private where: 'github' | string = 'github';

  constructor(
    private readonly services: Services,
    private readonly runInTerminal: (command: string) => void,
  ) {
    this.el = h('section', { style: 'display:flex;flex-direction:column;flex:1;min-height:0', attrs: { 'aria-label': 'Dependencies' } }, page(this.host));
    services.projects.on('current', () => void this.render());
  }

  show(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    clear(this.host);
    const project = this.services.projects.current();
    if (!project) {
      this.host.appendChild(emptyState('No project open', 'Open a project to see its dependencies.', button('Open Projects', () => this.services.ui.openView('projects'), { kind: 'primary' })));
      return;
    }
    let manifests: ManifestInfo[];
    try {
      manifests = await this.services.deps.list(project);
    } catch (error) {
      this.host.appendChild(h('div', { class: 'note err' }, toTerminiaError(error).message));
      return;
    }
    const profiles = await this.services.remote.profiles();
    const whereOptions = [{ value: 'github', label: 'GitHub Actions runner' }, ...profiles.map((p) => ({ value: p.name, label: `Remote host ${p.name}` }))];
    if (!whereOptions.some((o) => o.value === this.where)) this.where = 'github';
    const where = select(whereOptions, this.where, (v) => {
      this.where = v;
      void this.render();
    }, 'Where installs run');
    const onFlag = this.where === 'github' ? '' : ` --on remote --remote ${this.where}`;

    this.host.append(
      h('h2', null, `Dependencies of ${project.name}`),
      h('p', null, 'The iPad has no Node.js, Python or CocoaPods. Terminia reads and edits manifests here, and runs the real package manager where you choose. Nothing is installed on the iPad.'),
      h(
        'div',
        { class: 'field-row', style: 'align-items:end' },
        field('Installs run on', where),
        h('div', { style: 'padding-bottom:12px' }, targetChip(this.where === 'github' ? { kind: 'cloud', provider: 'GitHub Actions', runner: 'Linux', purpose: 'package manager' } : { kind: 'remote', profile: this.where, host: '' })),
      ),
    );

    if (!manifests.length) {
      this.host.appendChild(emptyState('No dependency manifests', 'Terminia reads package.json, requirements.txt, pyproject.toml, build.gradle, Podfile, Package.swift and PowerShell module manifests.'));
      return;
    }

    for (const m of manifests) {
      const ecosystemFlag = ` --ecosystem ${m.ecosystem}`;
      const runnable = m.ecosystem !== 'powershell';
      this.host.append(
        h('h2', null, `${m.ecosystem} · ${m.manifest}`),
        h('p', { class: 'small muted' }, `${m.lockfile ? `Locked by ${m.lockfile}.` : 'No lockfile.'} Installs run with ${m.owner}.`),
        ...m.notes.map((n) => h('div', { class: 'note', style: 'margin-bottom:8px' }, n)),
      );
      if (m.dependencies.length) {
        const table = h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'Package'), h('th', null, 'Declared'), h('th', null, 'Locked'), h('th', null, 'Type'), h('th', null, ''))),
          h(
            'tbody',
            null,
            m.dependencies.map((d) =>
              h(
                'tr',
                null,
                h('td', { class: 'mono' }, d.name),
                h('td', { class: 'mono' }, d.spec),
                h('td', { class: 'mono' }, d.locked ?? '—'),
                h('td', null, d.group),
                h(
                  'td',
                  null,
                  m.editable
                    ? button(icon('trash', 13), () => void this.remove(m, d.name), { kind: 'ghost', class: 'btn-icon', title: `Remove ${d.name}` })
                    : null,
                ),
              ),
            ),
          ),
        );
        this.host.appendChild(h('div', { class: 'rows', style: 'padding:0' }, table));
      } else this.host.appendChild(h('p', { class: 'muted' }, 'No dependencies declared.'));

      const actions = h('div', { class: 'field-row', style: 'margin-top:12px' });
      if (m.editable) {
        const spec = h('input', { class: 'text-input mono', placeholder: m.ecosystem === 'pip' ? 'requests>=2.31' : 'lodash or lodash@^4', attrs: { 'aria-label': 'Package to add', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' } });
        const dev = h('input', { type: 'checkbox' });
        actions.append(
          field('Add package', spec),
          ...(m.ecosystem !== 'pip' ? [h('label', { class: 'check', style: 'padding-bottom:12px' }, dev, 'Development')] : []),
          h('div', { style: 'padding-bottom:12px' }, button([icon('plus', 14), 'Add'], () => void this.add(m, spec.value, dev.checked), { kind: 'primary' })),
        );
      }
      if (runnable) {
        actions.append(
          h(
            'div',
            { style: 'padding-bottom:12px;display:flex;gap:8px' },
            button([icon('download', 14), 'Install'], () => this.runInTerminal(`terminia deps install${ecosystemFlag}${onFlag}`)),
            m.editable ? button([icon('refresh', 14), 'Update'], () => this.runInTerminal(`terminia deps update${ecosystemFlag}${onFlag}`)) : null,
            !m.editable ? button([icon('search', 14), 'Resolve on builder'], () => this.runInTerminal(`terminia deps resolve${ecosystemFlag}`)) : null,
          ),
        );
      } else {
        actions.append(h('p', { class: 'small muted' }, 'PowerShell modules install on a remote PowerShell host: remote connect <host>, then Install-Module <name> -Scope CurrentUser.'));
      }
      this.host.appendChild(actions);
    }
  }

  private async add(m: ManifestInfo, spec: string, dev: boolean): Promise<void> {
    const specs = spec.trim().split(/\s+/).filter(Boolean);
    if (!specs.length) return;
    try {
      const result = await this.services.deps.add(specs, { ecosystem: m.ecosystem, dev });
      const lines = result.edit.changes.map((c) => `${c.name} ${c.to}${c.from ? ` (was ${c.from})` : ''}`);
      await this.render();
      const install = await confirmDialog({
        title: `Added to ${result.manifest.manifest}`,
        message: 'The package is declared but not installed. Install now to resolve it and update the lockfile?',
        details: [...lines, ...result.lookups.map((l) => `${l.name}: latest ${l.latest} from ${l.registry}`)],
        confirmLabel: 'Install now',
      });
      if (install) this.runInTerminal(`terminia deps install --ecosystem ${m.ecosystem}${this.where === 'github' ? '' : ` --on remote --remote ${this.where}`}`);
    } catch (error) {
      toast(toTerminiaError(error).message, 'error');
    }
  }

  private async remove(m: ManifestInfo, name: string): Promise<void> {
    if (!(await confirmDialog({ title: `Remove ${name}?`, message: `${name} is removed from ${m.manifest}. Run Install afterwards to update the lockfile.`, confirmLabel: 'Remove', danger: true }))) return;
    try {
      await this.services.deps.remove([name], { ecosystem: m.ecosystem });
      await this.render();
    } catch (error) {
      toast(toTerminiaError(error).message, 'error');
    }
  }
}
