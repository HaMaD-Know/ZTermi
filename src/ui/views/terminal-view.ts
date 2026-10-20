import type { Services } from '../../app/services';
import { commonPrefix, type Candidate } from '../../terminal/completion';
import { EXIT } from '../../terminal/shell';
import type { OutputLine, SessionManager, TerminalEntry, TerminalSession } from '../../terminal/session';
import { needsContinuation } from '../../terminal/tokenizer';
import { formatDuration, formatTime } from '../../core/util';
import { button, clear, h, isTouchDevice } from '../dom';
import { icon } from '../icons';
import { toast } from '../overlays';

const MAX_RENDERED_LINES = 4000;
const KIND_ORDER = ['local', 'network', 'remote', 'cloud'] as const;

function entryKind(entry: TerminalEntry): string {
  if (entry.mode === 'remote') return 'remote';
  let best = 0;
  for (const t of entry.targets) best = Math.max(best, KIND_ORDER.indexOf(t.kind as (typeof KIND_ORDER)[number]));
  return KIND_ORDER[Math.max(0, best)]!;
}

class EntryView {
  readonly el: HTMLElement;
  private readonly lines: HTMLElement;
  private readonly meta: HTMLElement;
  private pending: OutputLine[] = [];
  private scheduled = false;
  private rendered = 0;

  constructor(
    readonly entry: TerminalEntry,
    private readonly onChange: () => void,
    private readonly cancel: () => void,
    private readonly copy: (text: string) => void,
  ) {
    this.meta = h('span', { class: 'entry-meta' });
    this.lines = h('div', { class: 'entry-lines' });
    this.el = h(
      'div',
      { class: `entry ${entryKind(entry)}`, dataset: { id: entry.id } },
      h('div', { class: 'entry-head' }, h('span', { class: 'entry-prompt' }, entry.prompt), h('span', { class: 'entry-input' }, entry.input), this.meta),
      this.lines,
    );
    const lines = entry.lines;
    if (lines.length > MAX_RENDERED_LINES) {
      this.lines.appendChild(h('div', { class: 'entry-collapsed' }, `${lines.length - MAX_RENDERED_LINES + entry.dropped} earlier lines are not shown. Use Copy to get the full output.`));
      this.pending = lines.slice(-MAX_RENDERED_LINES);
    } else {
      if (entry.dropped) this.lines.appendChild(h('div', { class: 'entry-collapsed' }, `${entry.dropped} earlier lines were dropped (output limit).`));
      this.pending = [...lines];
    }
    this.flush();
    this.updateMeta();
  }

  addLine(line: OutputLine): void {
    this.pending.push(line);
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    if (!this.pending.length) return;
    const fragment = document.createDocumentFragment();
    for (const line of this.pending) fragment.appendChild(renderLine(line));
    this.pending = [];
    this.lines.appendChild(fragment);
    this.rendered += fragment.childNodes.length;
    while (this.rendered > MAX_RENDERED_LINES + 500 && this.lines.firstChild) {
      this.lines.removeChild(this.lines.firstChild);
      this.rendered--;
    }
    this.onChange();
  }

  updateMeta(): void {
    const e = this.entry;
    this.el.className = `entry ${entryKind(e)}`;
    clear(this.meta);
    const labels = [...new Set(e.targets.map((t) => `${t.kind}|${t.label}`))];
    for (const item of labels) {
      const [kind, label] = item.split('|') as [string, string];
      this.meta.appendChild(h('span', { class: `target ${kind}`, title: 'Where this ran' }, label));
    }
    if (e.status === 'running') {
      this.meta.appendChild(h('span', null, icon('spinner', 13, 'spin')));
      this.meta.appendChild(button([icon('stop', 12), 'Stop'], () => this.cancel(), { kind: 'danger', title: 'Stop this command (Ctrl+C)' }));
    } else {
      const ok = e.exitCode === 0;
      this.meta.appendChild(h('span', { class: ok ? 'exit-ok' : 'exit-err', title: 'Exit code' }, ok ? '✓ 0' : e.exitCode === EXIT.CANCELLED ? '⊘ stopped' : `✗ ${e.exitCode}`));
      if (e.finishedAt) this.meta.appendChild(h('span', { title: 'Duration' }, formatDuration(e.finishedAt - e.startedAt)));
      this.meta.appendChild(
        button(icon('copy', 12), () => this.copy([`${e.prompt} ${e.input}`, ...e.lines.filter((l) => !l.action).map((l) => l.text)].join('\n')), { kind: 'ghost', title: 'Copy command and output' }),
      );
    }
    this.meta.appendChild(h('span', { title: new Date(e.startedAt).toString() }, formatTime(e.startedAt)));
  }
}

function renderLine(line: OutputLine): HTMLElement {
  if (line.action) {
    const action = line.action;
    return h('div', { class: 'line-action' }, button(action.label, () => void Promise.resolve(action.run()).catch((error: unknown) => toast((error as Error).message, 'error'))));
  }
  const el = h('div', { class: `line ${line.stream}` }, h('span', { class: 'ts' }, formatTime(line.ts)), line.text);
  textOf.set(el, line.text);
  return el;
}

const textOf = new WeakMap<HTMLElement, string>();

interface SessionDom {
  root: HTMLElement;
  entries: Map<string, EntryView>;
}

/** The Terminal view: session tabs, command blocks, prompt and key bar. */
export class TerminalView {
  readonly el: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly outputHost: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly prompt: HTMLElement;
  private readonly mode: HTMLElement;
  private readonly runButton: HTMLButtonElement;
  private readonly completions: HTMLElement;
  private readonly inputArea: HTMLElement;
  private readonly searchBar: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLElement;
  private readonly keybar: HTMLElement;
  private readonly doms = new Map<string, SessionDom>();
  private readonly unsubscribe = new Map<string, (() => void)[]>();
  private hits: HTMLElement[] = [];
  private hitIndex = -1;
  private stickToBottom = true;

  constructor(
    private readonly services: Services,
    private readonly sessions: SessionManager,
  ) {
    this.tabs = h('div', { class: 'term-tabs', attrs: { role: 'tablist', 'aria-label': 'Terminal tabs' } });
    this.searchInput = h('input', {
      class: 'text-input',
      placeholder: 'Search output',
      attrs: { 'aria-label': 'Search terminal output', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' },
      onInput: () => this.search(),
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.nextHit(e.shiftKey ? -1 : 1);
        if (e.key === 'Escape') this.toggleSearch(false);
      },
    });
    this.searchCount = h('span', { class: 'muted small' });
    this.searchBar = h(
      'div',
      { class: 'term-search', hidden: true },
      icon('search', 15),
      this.searchInput,
      button(icon('arrowUp', 14), () => this.nextHit(-1), { kind: 'ghost', title: 'Previous match' }),
      button(icon('arrowDown', 14), () => this.nextHit(1), { kind: 'ghost', title: 'Next match' }),
      this.searchCount,
      button(icon('close', 14), () => this.toggleSearch(false), { kind: 'ghost', title: 'Close search' }),
    );
    this.outputHost = h('div', {
      class: 'term-output',
      attrs: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Terminal output' },
      onScroll: () => {
        const o = this.outputHost;
        this.stickToBottom = o.scrollHeight - o.scrollTop - o.clientHeight < 48;
      },
      onClick: () => {
        if (!window.getSelection()?.toString()) this.input.focus({ preventScroll: true });
      },
    });
    this.prompt = h('div', { class: 'term-prompt' });
    this.input = h('textarea', {
      class: 'term-input',
      rows: 1,
      attrs: { 'aria-label': 'Command', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go' },
      onKeydown: (e: KeyboardEvent) => this.onKey(e),
      onInput: () => this.autosize(),
    });
    this.runButton = button(icon('play', 15), () => this.submitOrStop(), { kind: 'primary', class: 'btn-icon', title: 'Run' });
    this.completions = h('div', { class: 'completions', hidden: true, attrs: { role: 'listbox', 'aria-label': 'Completions' } });
    this.mode = h('div', { class: 'term-mode' });
    this.keybar = h('div', { class: 'keybar', hidden: !isTouchDevice(), attrs: { 'aria-label': 'Extra keys' } }, this.keybarButtons());
    this.inputArea = h('div', { class: 'term-input-area' }, this.completions, h('div', { class: 'term-input-row' }, this.prompt, this.input, this.runButton), this.mode, this.keybar);
    this.el = h(
      'section',
      { class: 'term', attrs: { 'aria-label': 'Terminal' } },
      this.tabs,
      this.searchBar,
      this.outputHost,
      this.inputArea,
    );
    this.sessions.on('changed', () => this.renderTabs());
    this.sessions.on('active', (s) => this.showSession(s));
    this.services.settings.on('changed', (s) => this.applySettings(s.fontSize, s.showTimestamps));
    this.applySettings(this.services.settings.get().fontSize, this.services.settings.get().showTimestamps);
    for (const s of this.sessions.sessions) this.attach(s);
    this.renderTabs();
    this.showSession(this.sessions.active());
  }

  private keybarButtons(): HTMLElement[] {
    const key = (label: string, action: () => void, extra = '') => h('button', { type: 'button', class: extra, onPointerdown: (e: Event) => e.preventDefault(), onClick: action, attrs: { 'aria-label': label } }, label);
    const insert = (text: string) => () => this.insertText(text);
    return [
      key('Tab', () => void this.complete()),
      key('Esc', () => this.hideCompletions()),
      key('↑', () => this.history(-1)),
      key('↓', () => this.history(1)),
      key('←', () => this.moveCaret(-1)),
      key('→', () => this.moveCaret(1)),
      key('Ctrl-C', () => this.interrupt(), 'stop'),
      key('|', insert('|')),
      key('-', insert('-')),
      key('/', insert('/')),
      key('~', insert('~')),
      key('"', insert('"')),
      key("'", insert("'")),
      key(':', insert(':')),
      key('>', insert('>')),
    ];
  }

  private applySettings(fontSize: number, timestamps: boolean): void {
    this.el.style.setProperty('--term-size', `${fontSize}px`);
    this.outputHost.classList.toggle('show-ts', timestamps);
  }

  private attach(session: TerminalSession): void {
    const dom: SessionDom = { root: h('div', { class: 'term-session' }, h('div', { class: 'term-welcome' }, WELCOME)), entries: new Map() };
    this.doms.set(session.id, dom);
    for (const entry of session.entries) this.addEntry(session, entry);
    const offs = [
      session.on('start', (entry) => this.addEntry(session, entry)),
      session.on('line', ({ entry, line }) => dom.entries.get(entry.id)?.addLine(line)),
      session.on('end', (entry) => {
        dom.entries.get(entry.id)?.updateMeta();
        this.refreshInput();
        this.renderTabs();
      }),
      session.on('state', () => {
        const running = session.runningEntry();
        if (running) dom.entries.get(running.id)?.updateMeta();
        if (session === this.sessions.active()) this.refreshInput();
        this.renderTabs();
      }),
      session.on('cleared', () => {
        clear(dom.root);
        dom.entries.clear();
      }),
    ];
    this.unsubscribe.set(session.id, offs);
  }

  private addEntry(session: TerminalSession, entry: TerminalEntry): void {
    const dom = this.doms.get(session.id)!;
    const view = new EntryView(
      entry,
      () => this.scrollIfPinned(),
      () => session.cancel(),
      (text) => void this.services.platform.copyText(text).then(() => toast('Copied', 'success')),
    );
    dom.entries.set(entry.id, view);
    dom.root.appendChild(view.el);
    this.stickToBottom = true;
    this.scrollIfPinned();
    this.renderTabs();
  }

  private scrollIfPinned(): void {
    if (this.stickToBottom) this.outputHost.scrollTop = this.outputHost.scrollHeight;
  }

  private renderTabs(): void {
    clear(this.tabs);
    const active = this.sessions.active();
    for (const s of this.sessions.sessions) {
      if (!this.doms.has(s.id)) this.attach(s);
      const remote = s.remoteInfo();
      const tab = h(
        'button',
        {
          type: 'button',
          class: `term-tab${remote ? ' remote' : ''}`,
          attrs: { role: 'tab', 'aria-selected': String(s === active) },
          onClick: () => this.sessions.activate(s.id),
        },
        s.isRunning() ? h('span', { class: 'running', title: 'Running' }) : null,
        remote ? `${remote.name}` : s.title,
        this.sessions.sessions.length > 1
          ? h(
              'span',
              {
                class: 'close',
                attrs: { role: 'button', 'aria-label': `Close ${s.title}` },
                onClick: (e: Event) => {
                  e.stopPropagation();
                  this.closeSession(s);
                },
              },
              icon('close', 13),
            )
          : null,
      );
      this.tabs.appendChild(tab);
    }
    this.tabs.appendChild(button(icon('plus', 15), () => this.newTab(), { kind: 'ghost', class: 'btn-icon', title: 'New tab (⌘T)' }));
    this.tabs.appendChild(
      h(
        'div',
        { class: 'term-tools' },
        button(icon('search', 15), () => this.toggleSearch(), { kind: 'ghost', class: 'btn-icon', title: 'Search output (⌘F)' }),
        button(icon('copy', 15), () => void this.services.platform.copyText(this.sessions.active().transcript()).then(() => toast('Transcript copied', 'success')), { kind: 'ghost', class: 'btn-icon', title: 'Copy transcript' }),
        button(icon('clear', 15), () => this.sessions.active().clearScreen(), { kind: 'ghost', class: 'btn-icon', title: 'Clear (⌘K)' }),
      ),
    );
  }

  newTab(cwd?: string): void {
    this.sessions.create({ cwd: cwd ?? this.sessions.active().cwd() });
  }

  closeSession(session: TerminalSession = this.sessions.active()): void {
    for (const off of this.unsubscribe.get(session.id) ?? []) off();
    this.unsubscribe.delete(session.id);
    this.doms.delete(session.id);
    this.sessions.close(session.id);
  }

  private showSession(session: TerminalSession): void {
    const dom = this.doms.get(session.id) ?? (this.attach(session), this.doms.get(session.id)!);
    clear(this.outputHost);
    this.outputHost.appendChild(dom.root);
    this.stickToBottom = true;
    this.scrollIfPinned();
    this.renderTabs();
    this.refreshInput();
    if (this.searchInput.value) this.search();
  }

  private refreshInput(): void {
    const session = this.sessions.active();
    const remote = session.remoteInfo();
    this.prompt.textContent = session.prompt();
    this.inputArea.classList.toggle('remote', !!remote);
    clear(this.mode);
    if (remote) {
      this.mode.append(h('span', { class: 'target remote' }, `Remote PowerShell · ${remote.name}`), h('span', null, `Runs on ${remote.host}. Type exit to return to local; start a line with : to run it locally.`));
    } else {
      this.mode.append(h('span', { class: 'target local' }, 'Local iPad'), h('span', null, 'Enter runs · Shift+Enter adds a line · Tab completes · ↑↓ history · help lists commands'));
    }
    const running = session.isRunning();
    clear(this.runButton);
    this.runButton.append(icon(running ? 'stop' : 'play', 15));
    this.runButton.className = `btn btn-icon ${running ? 'btn-danger' : 'btn-primary'}`;
    this.runButton.title = running ? 'Stop (Ctrl+C)' : 'Run (Enter)';
    this.runButton.setAttribute('aria-label', this.runButton.title);
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** Puts text in the prompt (used by other views, e.g. "Open terminal here"). */
  prefill(text: string, run = false): void {
    this.input.value = text;
    this.autosize();
    if (run) void this.submit();
    else this.focus();
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight + 2, window.innerHeight * 0.4)}px`;
    this.hideCompletions();
  }

  private onKey(e: KeyboardEvent): void {
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const meta = e.metaKey || e.ctrlKey;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      if (needsContinuation(value)) return; // newline continues an unfinished command
      e.preventDefault();
      void this.submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      void this.complete();
    } else if (e.key === 'ArrowUp' && !value.slice(0, caret).includes('\n')) {
      e.preventDefault();
      this.history(-1);
    } else if (e.key === 'ArrowDown' && !value.slice(caret).includes('\n')) {
      e.preventDefault();
      this.history(1);
    } else if (e.key === 'Escape') {
      this.hideCompletions();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c' && this.input.selectionStart === this.input.selectionEnd) {
      e.preventDefault();
      this.interrupt();
    } else if ((e.ctrlKey && e.key.toLowerCase() === 'l') || (meta && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      this.sessions.active().clearScreen();
    } else if (meta && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.toggleSearch(true);
    }
  }

  private interrupt(): void {
    const session = this.sessions.active();
    if (session.cancel()) return;
    this.input.value = '';
    this.autosize();
  }

  private submitOrStop(): void {
    if (this.sessions.active().isRunning()) this.sessions.active().cancel();
    else void this.submit();
  }

  private async submit(): Promise<void> {
    const session = this.sessions.active();
    if (session.isRunning()) {
      toast('A command is running in this tab. Stop it, or open a new tab with ⌘T.', 'info');
      return;
    }
    const value = this.input.value;
    this.input.value = '';
    this.autosize();
    this.hideCompletions();
    session.historyNavigator.reset();
    this.refreshInput();
    await session.run(value);
    this.refreshInput();
  }

  private history(direction: -1 | 1): void {
    const nav = this.sessions.active().historyNavigator;
    const value = direction < 0 ? nav.previous(this.input.value) : nav.next();
    if (value === null) return;
    this.input.value = value;
    this.autosize();
    this.input.setSelectionRange(value.length, value.length);
  }

  private insertText(text: string): void {
    const start = this.input.selectionStart ?? this.input.value.length;
    const end = this.input.selectionEnd ?? start;
    this.input.setRangeText(text, start, end, 'end');
    this.input.focus({ preventScroll: true });
  }

  private moveCaret(delta: number): void {
    const pos = Math.max(0, Math.min(this.input.value.length, (this.input.selectionStart ?? 0) + delta));
    this.input.setSelectionRange(pos, pos);
    this.input.focus({ preventScroll: true });
  }

  private async complete(): Promise<void> {
    const session = this.sessions.active();
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const result = await session.complete(value, caret);
    const apply = (candidate: string, finished: boolean) => {
      const text = value.slice(0, result.start) + candidate + (finished ? ' ' : '');
      this.input.value = text + value.slice(result.end);
      this.input.setSelectionRange(text.length, text.length);
      this.input.focus({ preventScroll: true });
    };
    if (!result.candidates.length) {
      this.hideCompletions();
      return;
    }
    if (result.candidates.length === 1) {
      const only = result.candidates[0]!;
      apply(only.value, !only.isDirectory && !only.value.endsWith('/'));
      this.hideCompletions();
      return;
    }
    const prefix = commonPrefix(result.candidates.map((c) => c.value));
    if (prefix.length > result.end - result.start) apply(prefix, false);
    this.showCompletions(result.candidates, (c) => {
      apply(c.value, !c.isDirectory && !c.value.endsWith('/'));
      this.hideCompletions();
    });
  }

  private showCompletions(candidates: Candidate[], choose: (c: Candidate) => void): void {
    clear(this.completions);
    for (const c of candidates.slice(0, 80)) {
      this.completions.appendChild(
        h('button', { type: 'button', class: 'completion', attrs: { role: 'option' }, onPointerdown: (e: Event) => e.preventDefault(), onClick: () => choose(c), title: c.description }, c.value, c.description ? h('small', null, c.description.slice(0, 40)) : null),
      );
    }
    if (candidates.length > 80) this.completions.appendChild(h('span', { class: 'muted small' }, `${candidates.length - 80} more - type more letters`));
    this.completions.hidden = false;
  }

  private hideCompletions(): void {
    this.completions.hidden = true;
  }

  toggleSearch(open = this.searchBar.hidden): void {
    this.searchBar.hidden = !open;
    if (open) {
      this.searchInput.focus();
      this.searchInput.select();
      this.search();
    } else {
      this.searchInput.value = '';
      this.search();
      this.focus();
    }
  }

  private search(): void {
    for (const hit of this.hits) {
      const line = hit.closest('.line') as HTMLElement | null;
      if (line && textOf.has(line)) {
        const ts = line.querySelector('.ts');
        line.textContent = '';
        if (ts) line.appendChild(ts);
        line.appendChild(document.createTextNode(textOf.get(line)!));
      }
    }
    this.hits = [];
    this.hitIndex = -1;
    const query = this.searchInput.value;
    if (!query) {
      this.searchCount.textContent = '';
      return;
    }
    const needle = query.toLowerCase();
    const session = this.sessions.active();
    const root = this.doms.get(session.id)?.root;
    if (!root) return;
    for (const line of root.querySelectorAll<HTMLElement>('.line')) {
      const text = textOf.get(line);
      if (!text || !text.toLowerCase().includes(needle)) continue;
      const ts = line.querySelector('.ts');
      line.textContent = '';
      if (ts) line.appendChild(ts);
      let from = 0;
      const lower = text.toLowerCase();
      for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
        line.appendChild(document.createTextNode(text.slice(from, at)));
        const mark = h('mark', { class: 'hit' }, text.slice(at, at + query.length));
        line.appendChild(mark);
        this.hits.push(mark);
        from = at + query.length;
      }
      line.appendChild(document.createTextNode(text.slice(from)));
    }
    this.searchCount.textContent = this.hits.length ? `${this.hits.length} match${this.hits.length === 1 ? '' : 'es'}` : 'No matches';
    if (this.hits.length) this.nextHit(1);
  }

  private nextHit(direction: number): void {
    if (!this.hits.length) return;
    this.hits[this.hitIndex]?.classList.remove('current');
    this.hitIndex = (this.hitIndex + direction + this.hits.length) % this.hits.length;
    const hit = this.hits[this.hitIndex]!;
    hit.classList.add('current');
    hit.scrollIntoView({ block: 'center' });
    this.stickToBottom = false;
    this.searchCount.textContent = `${this.hitIndex + 1} of ${this.hits.length}`;
  }
}

const WELCOME = `Terminia — developer terminal for iPad
Local commands run on this iPad in Terminia's folders; they are not PowerShell. Type help to list them.
Real PowerShell runs on a computer you connect: remote connect <host>.
Builds run on GitHub Actions: terminia ios build, terminia android build.`;
