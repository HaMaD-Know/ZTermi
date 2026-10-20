import type { Services } from '../../app/services';
import { toTerminiaError } from '../../core/errors';
import { formatDateTime } from '../../core/util';
import { APP_VERSION } from '../../commands/terminia';
import { button, clear, h } from '../dom';
import { icon } from '../icons';
import { confirmDialog, toast } from '../overlays';
import { field, page, segmented } from './common';

/** Settings: appearance, GitHub (build provider), remote hosts, build limits, security notes. */
export class SettingsView {
  readonly el: HTMLElement;
  private readonly appearance = h('div');
  private readonly github = h('div');
  private readonly remotes = h('div');
  private readonly builds = h('div');

  constructor(private readonly services: Services) {
    this.el = h(
      'section',
      { style: 'display:flex;flex-direction:column;flex:1;min-height:0', attrs: { 'aria-label': 'Settings' } },
      page(
        h('h2', null, 'Appearance'),
        this.appearance,
        h('h2', null, 'Build providers › GitHub'),
        this.github,
        h('h2', null, 'Remote PowerShell hosts'),
        this.remotes,
        h('h2', null, 'Builds and downloads'),
        this.builds,
        h('h2', null, 'Where things run'),
        this.targetsTable(),
        h('h2', null, 'Security'),
        this.securityNotes(),
        h('h2', null, 'About'),
        h('p', { class: 'muted' }, `Terminia ${APP_VERSION} · ${services.platform.kind === 'ios' ? 'iPad app' : 'browser preview'}`),
      ),
    );
    services.github.on('changed', () => this.renderGitHub());
    services.remote.on('changed', () => void this.renderRemotes());
    services.settings.on('changed', () => {
      this.renderAppearance();
      this.renderBuilds();
    });
  }

  show(): void {
    this.renderAppearance();
    this.renderGitHub();
    void this.renderRemotes();
    this.renderBuilds();
    void this.services.github.status().catch(() => undefined);
  }

  private renderAppearance(): void {
    const s = this.services.settings.get();
    clear(this.appearance);
    const size = h('span', { class: 'mono', style: 'min-width:4ch;text-align:center' }, String(s.fontSize));
    const timestamps = h('input', { type: 'checkbox', checked: s.showTimestamps, onChange: () => void this.services.settings.update({ showTimestamps: timestamps.checked }) });
    this.appearance.append(
      field('Theme', segmented([{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Match iPad' }], s.theme, (theme) => void this.services.settings.update({ theme }), 'Theme')),
      field(
        'Terminal and editor text size',
        h(
          'div',
          { style: 'display:flex;align-items:center;gap:6px' },
          button('−', () => void this.services.settings.update({ fontSize: s.fontSize - 1 }), { title: 'Smaller text', class: 'btn-icon' }),
          size,
          button('+', () => void this.services.settings.update({ fontSize: s.fontSize + 1 }), { title: 'Larger text', class: 'btn-icon' }),
        ),
      ),
      h('label', { class: 'check' }, timestamps, 'Show timestamps in terminal output'),
    );
  }

  private renderGitHub(): void {
    const status = this.services.github.lastStatus();
    const settings = this.services.settings.get();
    const native = this.services.platform.isNative;
    clear(this.github);
    const state = status.connected
      ? h('p', null, h('span', { class: 'dot ok', style: 'display:inline-block;margin-right:8px' }), `Connected as ${status.user?.login}${status.scopes?.length ? ` (scopes: ${status.scopes.join(', ')})` : ''}`)
      : status.credential
        ? h('p', null, h('span', { class: 'dot err', style: 'display:inline-block;margin-right:8px' }), `Stored credential did not work: ${status.error ?? 'not checked yet'}`)
        : h('p', { class: 'muted' }, 'Not connected. Terminia uses GitHub to sync projects, run builds on GitHub Actions and download their artifacts.');
    const clientId = h('input', { class: 'text-input mono', value: settings.githubClientId, placeholder: 'Ov23li…', attrs: { 'aria-label': 'GitHub OAuth client id', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' } });
    const run = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        const e = toTerminiaError(error);
        if (e.code !== 'CANCELLED') toast(e.hint ? `${e.message} ${e.hint}` : e.message, 'error');
      }
    };
    this.github.append(
      state,
      h(
        'div',
        { class: 'field-row', style: 'margin-bottom:12px' },
        button([icon('branch', 15), 'Sign in with GitHub'], () =>
          void run(async () => {
            let sheet: { close(): void } | null = null;
            try {
              const s = await this.services.github.loginWithDevice((code) => (sheet = this.services.ui.showDeviceCode(code)));
              toast(`Connected as ${s.user?.login}`, 'success');
            } finally {
              (sheet as { close(): void } | null)?.close();
            }
          }),
        { kind: 'primary', disabled: !native || !settings.githubClientId, title: !native ? 'Device sign-in needs the iPad app' : !settings.githubClientId ? 'Enter an OAuth client id first' : undefined },
        ),
        button([icon('key', 15), 'Use a token'], () => void run(async () => toast(`Connected as ${(await this.services.github.loginWithToken()).user?.login}`, 'success'))),
        status.credential ? button('Check connection', () => void run(() => this.services.github.status())) : null,
        status.credential
          ? button('Disconnect', () =>
              void run(async () => {
                if (await confirmDialog({ title: 'Disconnect GitHub?', message: 'The token is removed from this iPad. Revoke it on github.com if you no longer use it.', confirmLabel: 'Disconnect', danger: true })) await this.services.github.logout();
              }),
            { kind: 'danger' })
          : null,
      ),
      h(
        'div',
        { class: 'field-row' },
        field('OAuth client id (for device sign-in)', clientId, 'From your own GitHub OAuth App or GitHub App with device flow enabled. It is public; no client secret is used.'),
        h('div', { style: 'padding-bottom:30px' }, button('Save', () => void this.services.settings.update({ githubClientId: clientId.value }).then(() => toast('Saved', 'success')))),
      ),
      h(
        'div',
        { class: 'note' },
        h('strong', null, 'Permissions Terminia needs. '),
        'Fine-grained token: Actions (read and write), Contents (read and write), Workflows (read and write), Metadata (read), and optionally Secrets (read) so Terminia can tell you whether signing is configured. OAuth: the repo and workflow scopes. ',
        native ? 'The token is stored in the iOS Keychain and is only sent to api.github.com.' : 'Browser preview: the token stays in memory for this tab only.',
      ),
    );
  }

  private async renderRemotes(): Promise<void> {
    clear(this.remotes);
    const profiles = await this.services.remote.profiles();
    this.remotes.appendChild(h('p', { class: 'section-note' }, 'Real PowerShell runs on a computer you control through the Terminia agent (agent/terminia-agent.mjs). Each host has its own token, stored in the Keychain and sent only to that host.'));
    if (profiles.length) {
      const rows = h('div', { class: 'rows', style: 'margin-bottom:12px' });
      for (const p of profiles) {
        rows.appendChild(
          h(
            'div',
            { class: 'row' },
            icon('server', 18),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, p.name), h('div', { class: 'row-sub' }, `${p.url} · ${p.pinSha256 ? 'certificate pinned' : p.url.startsWith('https:') ? 'HTTPS' : 'plain HTTP (private network)'} · ${p.lastConnectedAt ? `last connected ${formatDateTime(p.lastConnectedAt)}` : 'never connected'}`)),
            h(
              'div',
              { class: 'row-actions' },
              button('Test', () =>
                void this.services.remote
                  .test(p.id)
                  .then((info) => toast(`${info.hostname}: PowerShell ${info.powershell.edition} ${info.powershell.version}`, 'success'))
                  .catch((e: unknown) => toast(toTerminiaError(e).message, 'error')),
              ),
              button('New token', () => void this.services.remote.promptToken(p).then(() => toast('Token updated', 'success')).catch((e: unknown) => toast(toTerminiaError(e).message, 'error'))),
              button(icon('trash', 14), () =>
                void confirmDialog({ title: `Remove ${p.name}?`, message: 'The profile and its token are removed from this iPad.', confirmLabel: 'Remove', danger: true }).then((ok) => (ok ? this.services.remote.remove(p.id) : undefined)),
              { kind: 'ghost', class: 'btn-icon', title: `Remove ${p.name}` }),
            ),
          ),
        );
      }
      this.remotes.appendChild(rows);
    }
    const name = h('input', { class: 'text-input', placeholder: 'devbox', attrs: { 'aria-label': 'Host name', autocapitalize: 'off', autocorrect: 'off' } });
    const url = h('input', { class: 'text-input mono', placeholder: 'https://devbox.tailnet.ts.net:8765', attrs: { 'aria-label': 'Agent URL', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' } });
    const pin = h('input', { class: 'text-input mono', placeholder: 'optional SHA-256 printed by the agent', attrs: { 'aria-label': 'Certificate fingerprint', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' } });
    this.remotes.append(
      h('div', { class: 'field-row' }, field('Name', name), field('Agent URL', url)),
      field('Certificate fingerprint', pin, 'Pins the agent certificate (HTTPS only). Leave empty for certificates the iPad already trusts.'),
      button([icon('plus', 14), 'Add host'], () =>
        void this.services.remote
          .add(name.value.trim(), url.value.trim(), { pinSha256: pin.value.trim() || undefined })
          .then((p) => toast(`Added ${p.name}`, 'success'))
          .catch((e: unknown) => {
            const err = toTerminiaError(e);
            if (err.code !== 'CANCELLED') toast(err.hint ? `${err.message} ${err.hint}` : err.message, 'error');
          }),
      { kind: 'primary' }),
    );
  }

  private renderBuilds(): void {
    const s = this.services.settings.get();
    clear(this.builds);
    const interval = h('input', { class: 'text-input', type: 'number', min: 3, max: 60, value: String(s.pollIntervalSeconds), onChange: () => void this.services.settings.update({ pollIntervalSeconds: Number(interval.value) }) });
    const max = h('input', { class: 'text-input', type: 'number', min: 16, max: 8192, value: String(s.maxArtifactMegabytes), onChange: () => void this.services.settings.update({ maxArtifactMegabytes: Number(max.value) }) });
    this.builds.append(
      h('div', { class: 'field-row' }, field('Check build status every (seconds)', interval, 'Terminia slows down automatically on network errors and rate limits.'), field('Largest artifact to download (MB)', max)),
    );
  }

  private targetsTable(): HTMLElement {
    const rows: [string, string, string][] = [
      ['local', 'Local iPad', 'Files in Terminia’s folder and in folders you open, the editor, archives, project detection and the built-in commands. These are not PowerShell.'],
      ['network', 'Network', 'Read-only lookups: GitHub API, npm registry, PyPI.'],
      ['remote', 'Remote PowerShell host', 'Real PowerShell on your own computer through the Terminia agent.'],
      ['cloud', 'GitHub Actions', 'Temporary build machines: macOS for iOS (Xcode, signing), Linux for Android (Gradle) and web builds, and package installs.'],
    ];
    return h(
      'div',
      { class: 'rows' },
      rows.map(([kind, label, text]) => h('div', { class: 'row' }, h('span', { class: `target ${kind}`, style: 'min-width:12ch;justify-content:center' }, label), h('div', { class: 'row-main small', style: 'white-space:normal' }, text))),
    );
  }

  private securityNotes(): HTMLElement {
    const vault = this.services.platform.vault.storage === 'keychain' ? 'the iOS Keychain (this device only)' : 'memory for this browser tab only';
    return h(
      'div',
      { class: 'note' },
      `Tokens are kept in ${vault} and attached to requests by native code, only for the host each one belongs to. Project uploads skip .env files, signing keys, keystores, provisioning profiles and anything that looks like a token. Signing certificates belong in GitHub Actions secrets, never in the project.`,
    );
  }
}
