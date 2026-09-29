import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Parses a boolean-ish env var. Only explicit truthy values ("1", "true", "yes", "on",
 * case-insensitive) enable the flag, so "0" / "false" / unset all disable it
 * (plain `!!value` would treat the string "0" as enabled).
 */
export function parseBooleanEnv(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
}

function parseEnvDump(dump: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of dump.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      env.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return env;
}

/**
 * Variables the container runtime sets per container rather than the user: Docker sets
 * HOSTNAME to the container id, so it changes whenever gitainer's container is recreated.
 */
const IGNORED_ENV_KEYS = new Set(["HOSTNAME"]);

/**
 * Keys that are new or have a different value in `current` than in `previous`, both
 * `env` dumps. Compared by key, not line order: moving a variable from the mounted
 * .env to Infisical changes where `env` prints it, but not its value.
 */
export function changedEnvKeys(previous: string, current: string): string[] {
  const previousEnv = parseEnvDump(previous);
  return [...parseEnvDump(current)]
    .filter(([key, value]) => !IGNORED_ENV_KEYS.has(key) && previousEnv.get(key) !== value)
    .map(([key]) => key);
}

/**
 * Writes an `env` dump readable only by its owner, as it holds every secret in plain
 * text. The chmod also tightens snapshots written before they were private, since
 * writing to an existing file keeps its mode.
 */
export function writeEnvSnapshot(path: string, dump: string) {
  writeFileSync(path, dump, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The `env` dump at `path`, or an empty one if it doesn't exist yet. */
export function readEnvSnapshot(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
