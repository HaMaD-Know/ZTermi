export const DEFAULT_EXEC: string[];
export function defaultConfigPath(): string;
export function loadConfig(file?: string): Record<string, unknown>;
export function saveConfig(file: string, config: Record<string, unknown>): void;
export function initConfig(
  file: string,
  options?: { force?: boolean; listen?: { host: string; port: number }; roots?: string[]; powershell?: string },
): { config: Record<string, unknown> & { roots: string[] }; token: string };
export function rotateToken(file: string): string;
export function parseListen(value: string): { host: string; port: number };
