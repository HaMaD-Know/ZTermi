import type { Services } from '../../app/services';
import { commonPrefix, type Candidate } from '../../terminal/completion';
import type { OutputLine, SessionManager, TerminalEntry, TerminalSession } from '../../terminal/session';
import { needsContinuation } from '../../terminal/tokenizer';
import { clear, h, isTouchDevice } from '../dom';
import { toast } from '../overlays';

const MAX_RENDERED_LINES = 4000;

/** One command and its output, rendered as plain console text. */
class EntryView {
  readonly el: HTMLElement;
  private readonly lines: HTMLElement;
  private pending: OutputLine[] = [];
  private scheduled = false;
  private rendered = 0;

  constructor(
    readonly entry: TerminalEntry,
    private readonly onChange: () => void,
  ) {
    this.lines = h('div', { class: 'entry-lines' });
    this.el = h('div', { class: 'entry' }, h('div', { class: 'entry-head' }, h('span', { class: 'entry-prompt' }, `${entry.prompt} `), entry.input), this.lines);
    const lines = entry.lines;
    if (entry.dropped || lines.length > MAX_RENDERED_LINES) {
      const hidden = Math.max(0, lines.length - MAX_RENDERED_LINES) + entry.dropped;
      this.lines.appendChild(h('div', { class: 'line system' }, `... ${hidden} earlier lines not shown`));
    }
    this.pending = lines.slice(-MAX_RENDERED_LINES);
    this.flush();
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
}

function renderLine(line: OutputLine): HTMLElement {
  if (line.action) {
    const action = line.action;
    return h(
      'div',
      { class: 'line' },
      h(
        'button',
        { type: 'button', class: 'line-link', onClick: () => void Promise.resolve(action.run()).catch((error: unknown) => toast((error as Error).message, 'error')) },
        `[${action.label}]`,
      ),
    );
  }
  const el = h('div', { class: `line ${line.stream}` }, line.text);
  textOf.set(el, line.text);
  return el;
}

const textOf = new WeakMap<HTMLElement, string>();

/**
 * The terminal: one plain console screen. Output and the prompt share the same
 * scrolling surface, and you type directly after the prompt, as in a desktop console.
 */
export class TerminalView {
  readonly el: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly history_: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly prompt: HTMLElement;
  private readonly inputLine: HTMLElement;
  private readonly completions: HTMLElement;
  private readonly searchBar: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly keybar: HTMLElement;
  private readonly entries = new Map<string, EntryView>();
  private offs: (() => void)[] = [];
  private hits: HTMLElement[] = [];
  private hitIndex = -1;
  private stickToBottom = true;

  constructor(
    private readonly services: Services,
    private readonly sessions: SessionManager,
  ) {
    this.searchInput = h('input', {
      class: 'term-search-input',
      placeholder: 'Find',
      attrs: { 'aria-label': 'Find in output', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' },
      onInput: () => this.search(),
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') this.nextHit(e.shiftKey ? -1 : 1);
        if (e.key === 'Escape') this.toggleSearch(false);
      },
    });
    this.searchBar = h('div', { class: 'term-search', hidden: true }, this.searchInput);
    this.history_ = h('div', { class: 'term-history' });
    this.prompt = h('span', { class: 'term-prompt' });
    this.input = h('textarea', {
      class: 'term-input',
      rows: 1,
      attrs: { 'aria-label': 'Command', autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go' },
      onKeydown: (e: KeyboardEvent) => this.onKey(e),
      onInput: () => this.autosize(),
    });
    this.completions = h('div', { class: 'completions', hidden: true, attrs: { role: 'listbox', 'aria-label': 'Completions' } });
    this.inputLine = h('div', { class: 'term-line' }, this.prompt, this.input);
    this.screen = h(
      'div',
      {
        class: 'term-screen',
        attrs: { role: 'log', 'aria-label': 'Terminal' },
        onScroll: () => {
          const s = this.screen;
          this.stickToBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 48;
        },
        onClick: () => {
          if (!window.getSelection()?.toString()) this.focus();
        },
      },
      h('div', { class: 'term-banner' }, BANNER),
      this.history_,
      this.inputLine,
      this.completions,
    );
    this.keybar = h('div', { class: 'keybar', hidden: !isTouchDevice(), attrs: { 'aria-label': 'Extra keys' } }, this.keybarButtons());
    this.el = h('section', { class: 'term' }, this.searchBar, this.screen, this.keybar);
    this.services.settings.on('changed', (s) => this.el.style.setProperty('--term-size', `${s.fontSize}px`));
    this.el.style.setProperty('--term-size', `${this.services.settings.get().fontSize}px`);
    this.sessions.on('active', (s) => this.show(s));
    this.show(this.sessions.active());
  }

  private keybarButtons(): HTMLElement[] {
    const key = (label: string, action: () => void) => h('button', { type: 'button', onPointerdown: (e: Event) => e.preventDefault(), onClick: action, attrs: { 'aria-label': label } }, label);
    const insert = (text: string) => () => this.insertText(text);
    return [
      key('Tab', () => void this.complete()),
      key('Esc', () => this.hideCompletions()),
      key('↑', () => this.history(-1)),
      key('↓', () => this.history(1)),
      key('←', () => this.moveCaret(-1)),
      key('→', () => this.moveCaret(1)),
      key('^C', () => this.interrupt()),
      ...['|', '-', '/', '~', '"', "'", ':', '>'].map((c) => key(c, insert(c))),
    ];
  }

  private show(session: TerminalSession): void {
    for (const off of this.offs) off();
    this.entries.clear();
    clear(this.history_);
    for (const entry of session.entries) this.addEntry(entry);
    this.offs = [
      session.on('start', (entry) => this.addEntry(entry)),
      session.on('line', ({ entry, line }) => this.entries.get(entry.id)?.addLine(line)),
      session.on('end', () => this.refreshInput()),
      session.on('state', () => this.refreshInput()),
      session.on('cleared', () => {
        this.entries.clear();
        clear(this.history_);
        this.screen.querySelector('.term-banner')?.remove();
      }),
    ];
    this.refreshInput();
    this.stickToBottom = true;
    this.scrollIfPinned();
  }

  private addEntry(entry: TerminalEntry): void {
    const view = new EntryView(entry, () => this.scrollIfPinned());
    this.entries.set(entry.id, view);
    this.history_.appendChild(view.el);
    this.stickToBottom = true;
    this.scrollIfPinned();
  }

  private scrollIfPinned(): void {
    if (this.stickToBottom) this.screen.scrollTop = this.screen.scrollHeight;
  }

  /** While a command runs only the prompt text is hidden; typing ahead is kept, like a console. */
  private refreshInput(): void {
    const session = this.sessions.active();
    const running = session.isRunning();
    this.prompt.textContent = running ? '' : `${session.prompt()} `;
    if (!running) {
      this.scrollIfPinned();
      if (this.el.isConnected && document.activeElement !== this.searchInput) this.focus();
    }
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  newTab(cwd?: string): void {
    const session = this.sessions.create({ cwd: cwd ?? this.sessions.active().cwd() });
    this.sessions.activate(session.id);
  }

  closeSession(): void {
    if (this.sessions.sessions.length > 1) this.sessions.close(this.sessions.active().id);
  }

  /** Puts text on the prompt line (used by other screens, e.g. "Open terminal here"). */
  prefill(text: string, run = false): void {
    this.input.value = text;
    this.autosize();
    if (run) void this.submit();
    else this.focus();
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${this.input.scrollHeight}px`;
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
      if (!this.completions.hidden) this.hideCompletions();
      else {
        this.input.value = '';
        this.autosize();
      }
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

  /** Ctrl+C: stops the running command, or discards the current line. */
  interrupt(): void {
    if (this.sessions.active().cancel()) return;
    if (this.input.value) {
      this.input.value = '';
      this.autosize();
    }
  }

  private async submit(): Promise<void> {
    const session = this.sessions.active();
    if (session.isRunning()) return; // the typed text stays; Enter runs it once the command ends
    const value = this.input.value;
    this.input.value = '';
    this.autosize();
    session.historyNavigator.reset();
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
    this.focus();
  }

  private moveCaret(delta: number): void {
    const pos = Math.max(0, Math.min(this.input.value.length, (this.input.selectionStart ?? 0) + delta));
    this.input.setSelectionRange(pos, pos);
    this.focus();
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
      this.focus();
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

  /** Candidates are listed under the prompt as plain text, like a shell does. */
  private showCompletions(candidates: Candidate[], choose: (c: Candidate) => void): void {
    clear(this.completions);
    for (const c of candidates.slice(0, 80)) {
      this.completions.appendChild(
        h('button', { type: 'button', class: 'completion', attrs: { role: 'option' }, onPointerdown: (e: Event) => e.preventDefault(), onClick: () => choose(c), title: c.description }, c.value),
      );
    }
    if (candidates.length > 80) this.completions.appendChild(h('span', { class: 'completion more' }, `... ${candidates.length - 80} more`));
    this.completions.hidden = false;
    this.scrollIfPinned();
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
      if (line && textOf.has(line)) line.textContent = textOf.get(line)!;
    }
    this.hits = [];
    this.hitIndex = -1;
    const query = this.searchInput.value;
    if (!query) return;
    const needle = query.toLowerCase();
    for (const line of this.history_.querySelectorAll<HTMLElement>('.line')) {
      const text = textOf.get(line);
      if (!text || !text.toLowerCase().includes(needle)) continue;
      line.textContent = '';
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
  }
}

const BANNER = `Terminia
Type help for commands.`;
