/** Line diff (Myers' O(ND) algorithm) and unified-diff formatting, used by `terminia git diff`. */

export type DiffOp = { type: 'equal' | 'insert' | 'delete'; line: string };

export const MAX_DIFF_LINES = 20_000;

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max > MAX_DIFF_LINES) throw new Error(`Too large to diff (${max} lines).`);
  const offset = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }
  // Backtrack from the end through the saved V arrays.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'insert', line: b[y - 1]! });
      else ops.push({ type: 'delete', line: a[x - 1]! });
      x = prevX;
      y = prevY;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'equal', line: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Unified diff with `context` lines around each change. */
export function unifiedDiff(oldText: string, newText: string, oldName: string, newName: string, context = 3): string {
  const split = (t: string) => (t === '' ? [] : t.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));
  const ops = diffLines(split(oldText), split(newText));
  if (!ops.some((o) => o.type !== 'equal')) return '';
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < ops.length) {
    if (ops[i]!.type === 'equal') {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    // Start a hunk `context` lines before this change.
    const start = Math.max(0, i - context);
    let oldStart = oldLine - (i - start);
    let newStart = newLine - (i - start);
    let end = i;
    let lastChange = i;
    while (end < ops.length && end - lastChange <= context * 2) {
      if (ops[end]!.type !== 'equal') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let j = start; j < end; j++) {
      const op = ops[j]!;
      if (op.type === 'equal') {
        lines.push(` ${op.line}`);
        oldCount++;
        newCount++;
      } else if (op.type === 'delete') {
        lines.push(`-${op.line}`);
        oldCount++;
      } else {
        lines.push(`+${op.line}`);
        newCount++;
      }
    }
    if (oldCount === 0) oldStart--;
    if (newCount === 0) newStart--;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines);
    for (let j = i; j < end; j++) {
      if (ops[j]!.type !== 'insert') oldLine++;
      if (ops[j]!.type !== 'delete') newLine++;
    }
    i = end;
  }
  return out.join('\n');
}
