import { redact } from '../core/redact';

/**
 * Command history with shell-style navigation. Lines are redacted before they
 * are stored, so a token pasted into a command never ends up persisted.
 * A line starting with a space is not recorded (like HISTCONTROL=ignorespace).
 */
export class CommandHistory {
  private items: string[];
  private cursor = -1;
  private draft = '';

  constructor(
    initial: string[] = [],
    private readonly limit = 1000,
  ) {
    this.items = initial.slice(-limit);
  }

  add(line: string): void {
    this.reset();
    if (!line.trim() || line.startsWith(' ')) return;
    const clean = redact(line);
    if (this.items[this.items.length - 1] === clean) return;
    this.items.push(clean);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  all(): string[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
    this.reset();
  }

  reset(): void {
    this.cursor = -1;
    this.draft = '';
  }

  /** Arrow up. `current` is what the user has typed so far (kept as the draft). */
  previous(current: string, prefix = ''): string | null {
    if (this.cursor === -1) this.draft = current;
    for (let i = (this.cursor === -1 ? this.items.length : this.cursor) - 1; i >= 0; i--) {
      if (this.items[i]!.startsWith(prefix)) {
        this.cursor = i;
        return this.items[i]!;
      }
    }
    return null;
  }

  /** Arrow down; returns the draft after the newest entry. */
  next(prefix = ''): string | null {
    if (this.cursor === -1) return null;
    for (let i = this.cursor + 1; i < this.items.length; i++) {
      if (this.items[i]!.startsWith(prefix)) {
        this.cursor = i;
        return this.items[i]!;
      }
    }
    this.cursor = -1;
    return this.draft;
  }

  search(query: string, limit = 50): string[] {
    const q = query.toLowerCase();
    const out: string[] = [];
    for (let i = this.items.length - 1; i >= 0 && out.length < limit; i--) {
      const item = this.items[i]!;
      if (item.toLowerCase().includes(q) && !out.includes(item)) out.push(item);
    }
    return out;
  }
}
