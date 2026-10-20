import { TerminiaError } from '../core/errors';

/**
 * Tokenizer for Terminia's LOCAL command line.
 *
 * The syntax borrows PowerShell's quoting so it feels familiar - single quotes
 * are literal ('' is a quote), double quotes allow backtick escapes (`n, `t,
 * `", ``), a backtick outside quotes escapes the next character, and # starts
 * a comment - but it is NOT PowerShell. Supported operators are | ; && || and
 * the redirections > >> 2> 2>> 2>&1.
 *
 * PowerShell-only syntax (variables, $(...) subexpressions, script blocks,
 * @() arrays, background &) is detected and reported as unsupported instead of
 * being half-interpreted. Real PowerShell runs on a remote host.
 */

export type Operator = '|' | ';' | '&&' | '||' | '>' | '>>' | '2>' | '2>>' | '2>&1' | 'newline';

export interface WordToken {
  kind: 'word';
  value: string;
  /** True when any part of the word was quoted or escaped. */
  quoted: boolean;
  start: number;
  end: number;
}

export interface OpToken {
  kind: 'op';
  op: Operator;
  start: number;
  end: number;
}

export type Token = WordToken | OpToken;

export interface UnsupportedSyntax {
  feature: string;
  position: number;
}

export interface TokenizeResult {
  tokens: Token[];
  incomplete: boolean;
  incompleteReason?: 'quote' | 'escape' | 'operator';
  unsupported: UnsupportedSyntax[];
}

const BACKTICK_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', e: '\x1b' };

export function tokenize(input: string): TokenizeResult {
  const tokens: Token[] = [];
  const unsupported: UnsupportedSyntax[] = [];
  let i = 0;
  let word = '';
  let wordStart = -1;
  let quoted = false;
  let incomplete = false;
  let incompleteReason: TokenizeResult['incompleteReason'];

  const startWord = (pos: number) => {
    if (wordStart === -1) wordStart = pos;
  };
  const endWord = (pos: number) => {
    if (wordStart !== -1) {
      tokens.push({ kind: 'word', value: word, quoted, start: wordStart, end: pos });
      word = '';
      wordStart = -1;
      quoted = false;
    }
  };
  const op = (o: Operator, start: number, length: number) => {
    endWord(start);
    tokens.push({ kind: 'op', op: o, start, end: start + length });
    i = start + length;
  };
  const flagDollar = (pos: number, inQuotes: boolean) => {
    const next = input[pos + 1] ?? '';
    if (/[A-Za-z_{(?]/.test(next)) {
      unsupported.push({
        feature: next === '(' ? 'subexpression $( )' : inQuotes ? 'variable expansion in double quotes' : 'variables ($name)',
        position: pos,
      });
    }
  };

  while (i < input.length) {
    const c = input[i]!;
    const atWordStart = wordStart === -1;

    if (c === ' ' || c === '\t' || c === '\r') {
      endWord(i);
      i++;
      continue;
    }
    if (c === '\n') {
      op('newline', i, 1);
      continue;
    }
    if (c === '#' && atWordStart) {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (c === '|') {
      op(input[i + 1] === '|' ? '||' : '|', i, input[i + 1] === '|' ? 2 : 1);
      continue;
    }
    if (c === ';') {
      op(';', i, 1);
      continue;
    }
    if (c === '&') {
      if (input[i + 1] === '&') {
        op('&&', i, 2);
        continue;
      }
      unsupported.push({ feature: atWordStart ? 'call/background operator &' : 'operator &', position: i });
      endWord(i);
      i++;
      continue;
    }
    if (c === '2' && atWordStart && input[i + 1] === '>') {
      if (input.startsWith('2>&1', i)) op('2>&1', i, 4);
      else if (input[i + 2] === '>') op('2>>', i, 3);
      else op('2>', i, 2);
      continue;
    }
    if (c === '>') {
      op(input[i + 1] === '>' ? '>>' : '>', i, input[i + 1] === '>' ? 2 : 1);
      continue;
    }
    if (c === '<') {
      unsupported.push({ feature: 'input redirection <', position: i });
      endWord(i);
      i++;
      continue;
    }
    if (atWordStart && (c === '(' || c === ')' || c === '{' || c === '}')) {
      unsupported.push({ feature: c === '{' || c === '}' ? 'script blocks { }' : 'parentheses ( )', position: i });
      i++;
      continue;
    }
    if (atWordStart && c === '@' && (input[i + 1] === '(' || input[i + 1] === '{')) {
      unsupported.push({ feature: input[i + 1] === '(' ? 'array subexpression @( )' : 'hash table @{ }', position: i });
      i += 2;
      continue;
    }
    if (c === "'") {
      startWord(i);
      quoted = true;
      i++;
      let closed = false;
      while (i < input.length) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            word += "'";
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        word += input[i];
        i++;
      }
      if (!closed) {
        incomplete = true;
        incompleteReason = 'quote';
      }
      continue;
    }
    if (c === '"') {
      startWord(i);
      quoted = true;
      i++;
      let closed = false;
      while (i < input.length) {
        const d = input[i]!;
        if (d === '`' && i + 1 < input.length) {
          const e = input[i + 1]!;
          word += BACKTICK_ESCAPES[e] ?? e;
          i += 2;
          continue;
        }
        if (d === '"') {
          if (input[i + 1] === '"') {
            word += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        if (d === '$') flagDollar(i, true);
        word += d;
        i++;
      }
      if (!closed) {
        incomplete = true;
        incompleteReason = 'quote';
      }
      continue;
    }
    if (c === '`') {
      if (i + 1 >= input.length) {
        incomplete = true;
        incompleteReason = 'escape';
        i++;
        continue;
      }
      const e = input[i + 1]!;
      if (e === '\n') {
        // Line continuation.
        i += 2;
        continue;
      }
      startWord(i);
      quoted = true;
      word += e;
      i += 2;
      continue;
    }
    if (c === '$') flagDollar(i, false);
    startWord(i);
    word += c;
    i++;
  }
  endWord(input.length);

  const last = [...tokens].reverse().find((t) => !(t.kind === 'op' && t.op === 'newline'));
  if (!incomplete && last?.kind === 'op' && (last.op === '|' || last.op === '&&' || last.op === '||')) {
    incomplete = true;
    incompleteReason = 'operator';
  }
  return { tokens, incomplete, incompleteReason, unsupported };
}

export type RedirectOp = '>' | '>>' | '2>' | '2>>' | '2>&1';

export interface Redirect {
  op: RedirectOp;
  target?: string;
}

export interface SimpleCommand {
  argv: string[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: SimpleCommand[];
}

export interface SequenceItem {
  /** How this pipeline is joined to the previous one (null for the first). */
  connector: ';' | '&&' | '||' | null;
  pipeline: Pipeline;
}

export interface Script {
  items: SequenceItem[];
}

/**
 * Parses a complete command line. Throws UNSUPPORTED for PowerShell-only
 * syntax and INVALID_ARGUMENT for malformed operators.
 */
export function parseScript(input: string): Script {
  const result = tokenize(input);
  if (result.unsupported.length) {
    const features = [...new Set(result.unsupported.map((u) => u.feature))].join(', ');
    throw new TerminiaError('UNSUPPORTED', `Not supported by Terminia's local shell: ${features}.`, {
      hint: "That is PowerShell syntax. Local commands run on the iPad and are not PowerShell. Connect a real PowerShell host with `remote connect <profile>` (see `help remote`).",
    });
  }
  if (result.incomplete) throw new TerminiaError('INVALID_ARGUMENT', 'The command is incomplete (unclosed quote or trailing operator).');

  const items: SequenceItem[] = [];
  let connector: SequenceItem['connector'] = null;
  let commands: SimpleCommand[] = [];
  let current: SimpleCommand = { argv: [], redirects: [] };
  let pendingRedirect: Redirect | null = null;

  const finishCommand = (position: string) => {
    if (pendingRedirect) throw new TerminiaError('INVALID_ARGUMENT', `Missing file name after '${pendingRedirect.op}'.`);
    if (current.argv.length === 0) {
      if (current.redirects.length) throw new TerminiaError('INVALID_ARGUMENT', 'Redirection without a command.');
      if (position === 'pipe') throw new TerminiaError('INVALID_ARGUMENT', "Empty command before '|'.");
      return;
    }
    commands.push(current);
    current = { argv: [], redirects: [] };
  };
  const finishPipeline = (next: SequenceItem['connector']) => {
    finishCommand('end');
    if (commands.length) {
      items.push({ connector: items.length ? connector : null, pipeline: { commands } });
    } else if (next === '&&' || next === '||') {
      throw new TerminiaError('INVALID_ARGUMENT', `Missing command before '${next}'.`);
    }
    commands = [];
    connector = next;
  };

  for (const token of result.tokens) {
    if (token.kind === 'word') {
      if (pendingRedirect) {
        pendingRedirect.target = token.value;
        current.redirects.push(pendingRedirect);
        pendingRedirect = null;
      } else current.argv.push(token.value);
      continue;
    }
    switch (token.op) {
      case '|':
        if (current.argv.length === 0 && commands.length === 0) throw new TerminiaError('INVALID_ARGUMENT', "Missing command before '|'.");
        finishCommand('pipe');
        break;
      case ';':
      case 'newline':
        finishPipeline(';');
        break;
      case '&&':
      case '||':
        finishPipeline(token.op);
        break;
      case '2>&1':
        current.redirects.push({ op: '2>&1' });
        break;
      default:
        if (pendingRedirect) throw new TerminiaError('INVALID_ARGUMENT', `Missing file name after '${pendingRedirect.op}'.`);
        pendingRedirect = { op: token.op };
    }
  }
  finishPipeline(null);
  return { items };
}

/** Quotes a value for display or completion so it tokenizes back to itself. */
export function quoteArg(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** True when a line looks like it wants more input (unclosed quote, trailing pipe or backtick). */
export function needsContinuation(input: string): boolean {
  return tokenize(input).incomplete;
}
