import { Registry } from '../terminal/registry';
import { builtinCommands } from './builtin';
import { FILE_COMMANDS } from './files';
import { remoteGroup } from './remote';
import { terminia } from './terminia';

/** The full command table of the local shell. */
export function createRegistry(): Registry {
  const registry = new Registry();
  registry.register(...builtinCommands(registry), ...FILE_COMMANDS, terminia, remoteGroup);
  return registry;
}
