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

/**
 * The environment as a snapshot for changedEnvKeys(): `KEY=value` entries, each ended by a NUL
 * rather than a newline, since a value can span lines (a PEM certificate from Infisical).
 */
export function envSnapshot(env: Record<string, string | undefined> = process.env): string {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}\0`)
    .join("");
}

// a snapshot without any NUL is an `env` dump, one entry per line, as written before envSnapshot()
function parseEnvDump(dump: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const entry of dump.split(dump.includes("\0") ? "\0" : "\n")) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      env.set(entry.slice(0, separator), entry.slice(separator + 1));
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
 * env snapshots. Compared by key, not line order: moving a variable from the mounted
 * .env to Infisical changes where `env` prints it, but not its value.
 */
export function changedEnvKeys(previous: string, current: string): string[] {
  const previousEnv = parseEnvDump(previous);
  return [...parseEnvDump(current)]
    .filter(([key, value]) => !IGNORED_ENV_KEYS.has(key) && previousEnv.get(key) !== value)
    .map(([key]) => key);
}

/**
 * Writes an env snapshot readable only by its owner, as it holds every secret in plain
 * text. The chmod also tightens snapshots written before they were private, since
 * writing to an existing file keeps its mode.
 */
export function writeEnvSnapshot(path: string, dump: string) {
  writeFileSync(path, dump, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The env snapshot at `path`, or an empty one if it doesn't exist yet. */
export function readEnvSnapshot(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
