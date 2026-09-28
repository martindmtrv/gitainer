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
 * Keys that are new or have a different value in `current` than in `previous`, both
 * `env` dumps. Compared by key, not line order: moving a variable from the mounted
 * .env to Infisical changes where `env` prints it, but not its value.
 */
export function changedEnvKeys(previous: string, current: string): string[] {
  const previousEnv = parseEnvDump(previous);
  return [...parseEnvDump(current)]
    .filter(([key, value]) => previousEnv.get(key) !== value)
    .map(([key]) => key);
}

/**
 * Whether compose file contents reference `envVar` as `$VAR` or `${VAR}` (including
 * `${VAR:-default}` and similar). Only the whole name matches, so `$LOCAL_ECR_DIRECT`
 * is not a reference to `LOCAL_ECR`.
 */
export function referencesEnv(contents: string, envVar: string): boolean {
  const name = envVar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`).test(contents);
}
