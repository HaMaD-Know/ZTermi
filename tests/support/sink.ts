import { formatTable } from '../../src/terminal/help';
import type { OutputSink } from '../../src/terminal/types';

/** Records everything a command writes, by stream. */
export class RecordingSink implements OutputSink {
  readonly lines: { stream: string; text: string }[] = [];
  readonly actions: string[] = [];
  private buffer = '';

  write(text: string): void {
    this.buffer += text;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    for (const p of parts) this.lines.push({ stream: 'stdout', text: p });
  }
  writeln(text = ''): void {
    this.write(`${text}\n`);
  }
  error(text: string): void {
    this.lines.push({ stream: 'stderr', text });
  }
  info(text: string): void {
    this.lines.push({ stream: 'info', text });
  }
  warn(text: string): void {
    this.lines.push({ stream: 'warn', text });
  }
  success(text: string): void {
    this.lines.push({ stream: 'success', text });
  }
  muted(text: string): void {
    this.lines.push({ stream: 'muted', text });
  }
  table(rows: string[][], headers?: string[]): void {
    this.write(`${formatTable(rows, headers)}\n`);
  }
  action(label: string): void {
    this.actions.push(label);
  }

  text(stream?: string): string {
    const flushed = this.buffer ? [...this.lines, { stream: 'stdout', text: this.buffer }] : this.lines;
    return flushed
      .filter((l) => !stream || l.stream === stream)
      .map((l) => l.text)
      .join('\n');
  }
}
