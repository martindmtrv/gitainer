const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Parses a boolean-ish env var. Only explicit truthy values ("1", "true", "yes", "on",
 * case-insensitive) enable the flag, so "0" / "false" / unset all disable it
 * (plain `!!value` would treat the string "0" as enabled).
 */
export function parseBooleanEnv(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
}
