import { TerminiaError } from '../core/errors';
import { suggest } from '../core/util';

/**
 * Option parsing for Terminia commands. Accepts GNU style (--name value,
 * --name=value, --no-flag, -n value, -rf) and PowerShell style
 * (-Name value, -Name:value, -Force), case-insensitively for long names.
 */

export type CompletionKind = 'path' | 'directory' | 'file' | 'project' | 'remote-profile' | 'build' | 'artifact' | 'repo' | 'template' | 'none';

export interface OptionSpec {
  name: string;
  short?: string;
  aliases?: string[];
  type: 'string' | 'boolean' | 'number' | 'enum';
  values?: readonly string[];
  description: string;
  valueName?: string;
  repeatable?: boolean;
  complete?: CompletionKind;
}

export interface PositionalSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
  complete?: CompletionKind;
  values?: readonly string[];
}

export type OptionValue = string | boolean | number | string[];

export interface ParsedArgs {
  options: Record<string, OptionValue | undefined>;
  positionals: string[];
  /** Arguments after a literal `--`, untouched. */
  rest: string[];
  /** True when `--` was present. */
  hasRest: boolean;
}

export function findOption(specs: OptionSpec[], token: string): OptionSpec | undefined {
  const name = token.toLowerCase();
  return specs.find((s) => s.name.toLowerCase() === name || s.aliases?.some((a) => a.toLowerCase() === name));
}

function coerce(spec: OptionSpec, raw: string, flag: string): OptionValue {
  switch (spec.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new TerminiaError('INVALID_ARGUMENT', `${flag} expects a number, got '${raw}'.`);
      return n;
    }
    case 'enum': {
      const match = spec.values?.find((v) => v.toLowerCase() === raw.toLowerCase());
      if (!match) {
        throw new TerminiaError('INVALID_ARGUMENT', `${flag} must be one of: ${spec.values?.join(', ')} (got '${raw}').`);
      }
      return match;
    }
    case 'boolean': {
      if (/^(true|yes|1|\$true)$/i.test(raw)) return true;
      if (/^(false|no|0|\$false)$/i.test(raw)) return false;
      throw new TerminiaError('INVALID_ARGUMENT', `${flag} expects true or false, got '${raw}'.`);
    }
    default:
      return raw;
  }
}

function assign(out: ParsedArgs, spec: OptionSpec, value: OptionValue): void {
  if (spec.repeatable) {
    const list = (out.options[spec.name] as string[] | undefined) ?? [];
    list.push(String(value));
    out.options[spec.name] = list;
  } else out.options[spec.name] = value;
}

function isNegativeNumber(token: string): boolean {
  return /^-\d+(\.\d+)?$/.test(token);
}

export function parseArgs(argv: string[], options: OptionSpec[] = [], positionals: PositionalSpec[] = []): ParsedArgs {
  const out: ParsedArgs = { options: {}, positionals: [], rest: [], hasRest: false };
  let i = 0;
  const unknown = (flag: string): never => {
    const names = options.flatMap((o) => [`--${o.name}`, ...(o.short ? [`-${o.short}`] : [])]);
    const hint = suggest(flag, names);
    throw new TerminiaError('INVALID_ARGUMENT', `Unknown option '${flag}'.${hint ? ` Did you mean '${hint}'?` : ''}`);
  };
  const takeValue = (spec: OptionSpec, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined) {
      throw new TerminiaError('INVALID_ARGUMENT', `${flag} needs a value${spec.values ? ` (${spec.values.join(', ')})` : ''}.`);
    }
    i++;
    return value;
  };

  for (; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      out.hasRest = true;
      out.rest = argv.slice(i + 1);
      break;
    }
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      let spec = findOption(options, name);
      if (!spec && name.toLowerCase().startsWith('no-')) {
        const negated = findOption(options, name.slice(3));
        if (negated?.type === 'boolean' && eq === -1) {
          assign(out, negated, false);
          continue;
        }
      }
      if (!spec) spec = unknown(`--${name}`);
      if (spec.type === 'boolean') assign(out, spec, eq === -1 ? true : coerce(spec, token.slice(eq + 1), `--${spec.name}`));
      else assign(out, spec, coerce(spec, eq === -1 ? takeValue(spec, `--${spec.name}`) : token.slice(eq + 1), `--${spec.name}`));
      continue;
    }
    if (token.startsWith('-') && token.length > 1 && !isNegativeNumber(token)) {
      const body = token.slice(1);
      const colon = body.indexOf(':');
      const longName = colon === -1 ? body : body.slice(0, colon);
      // PowerShell style: -Configuration Release, -Force, -Variant:debug
      const longSpec = longName.length > 1 ? findOption(options, longName) : undefined;
      if (longSpec) {
        if (longSpec.type === 'boolean') assign(out, longSpec, colon === -1 ? true : coerce(longSpec, body.slice(colon + 1), `-${longSpec.name}`));
        else assign(out, longSpec, coerce(longSpec, colon === -1 ? takeValue(longSpec, `-${longSpec.name}`) : body.slice(colon + 1), `-${longSpec.name}`));
        continue;
      }
      // Short flags, possibly combined: -rf, -n 5
      for (let j = 0; j < body.length; j++) {
        const spec = options.find((o) => o.short === body[j]);
        if (!spec) unknown(`-${body[j]}`);
        if (spec!.type === 'boolean') {
          assign(out, spec!, true);
          continue;
        }
        const inline = body.slice(j + 1);
        assign(out, spec!, coerce(spec!, inline || takeValue(spec!, `-${spec!.short}`), `-${spec!.short}`));
        break;
      }
      continue;
    }
    out.positionals.push(token);
  }

  const required = positionals.filter((p) => p.required).length;
  if (out.positionals.length < required) {
    const missing = positionals.filter((p) => p.required)[out.positionals.length];
    throw new TerminiaError('INVALID_ARGUMENT', `Missing required argument <${missing?.name ?? 'argument'}>.`);
  }
  const variadic = positionals.some((p) => p.variadic);
  if (!variadic && out.positionals.length > positionals.length) {
    throw new TerminiaError('INVALID_ARGUMENT', `Unexpected argument '${out.positionals[positionals.length]}'.`);
  }
  positionals.forEach((p, index) => {
    const value = out.positionals[index];
    if (value !== undefined && p.values && !p.values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      throw new TerminiaError('INVALID_ARGUMENT', `<${p.name}> must be one of: ${p.values.join(', ')} (got '${value}').`);
    }
  });
  return out;
}

export function str(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  return typeof value === 'string' ? value : value === undefined ? undefined : String(value);
}

export function bool(args: ParsedArgs, name: string): boolean {
  return args.options[name] === true;
}

export function num(args: ParsedArgs, name: string): number | undefined {
  const value = args.options[name];
  return typeof value === 'number' ? value : undefined;
}

export function list(args: ParsedArgs, name: string): string[] {
  const value = args.options[name];
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
}
