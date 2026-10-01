import { InfisicalSDK, type Secret } from "@infisical/sdk";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// what gitainer needs to reach Infisical, so these can come from the bootstrap cache
// instead of a mounted .env once one fetch has succeeded. They can also be stored in
// Infisical itself, but are only switched to once they log in and fetch successfully,
// so process.env always holds the ones in use
export const BOOTSTRAP_KEYS = [
  "INFISICAL_URL",
  "INFISICAL_CLIENT_ID",
  "INFISICAL_CLIENT_SECRET",
  "INFISICAL_PROJECT_ID",
  "INFISICAL_PROJECT_ENVIRONMENT",
];

// env gitainer's own processes (ssh, docker, git) run with. The container sets these for
// gitainer itself, so a secret of the same name can only break them: e.g. a host's
// SSH_AUTH_SOCK points at a socket that doesn't exist in the container, and ssh to a remote
// host then fails with "Permission denied (publickey)". Secrets with these names are ignored
export const PROTECTED_KEYS = ["SSH_AUTH_SOCK", "HOME", "USER", "PATH", "HOSTNAME"];

// keys Infisical has set in process.env, each with the value it replaced (from gitainer's
// `environment:` or .env), so a key deleted from Infisical can be unset again
const appliedKeys = new Map<string, string | undefined>();

/** The keys in process.env whose value currently comes from Infisical. */
export function infisicalKeys(): string[] {
  return [...appliedKeys.keys()];
}

// protected keys already warned about, with their value, so polls don't warn every minute
const warnedProtected = new Map<string, string>();

// last JSON written to each cache file, to skip rewriting it on every poll
const lastWritten = new Map<string, string>();

// Infisical settings from Infisical that failed to connect, so they aren't retried
// (and logged) on every poll until Infisical provides different ones
let rejectedSettings: string | undefined = undefined;

let client: InfisicalSDK | undefined = undefined;

function currentSettings(): Record<string, string> {
  return Object.fromEntries(
    BOOTSTRAP_KEYS.filter(key => process.env[key]).map(key => [key, process.env[key] as string]),
  );
}

async function connect(settings: Record<string, string>): Promise<InfisicalSDK> {
  const newClient = new InfisicalSDK({
    siteUrl: settings.INFISICAL_URL,
  });

  // Authenticate with Infisical
  await newClient.auth().universalAuth.login({
    clientId: settings.INFISICAL_CLIENT_ID,
    clientSecret: settings.INFISICAL_CLIENT_SECRET,
  });

  return newClient;
}

async function listSecrets(client: InfisicalSDK, settings: Record<string, string>): Promise<Secret[]> {
  const result = await client.secrets().listSecrets({
    environment: settings.INFISICAL_PROJECT_ENVIRONMENT,
    projectId: settings.INFISICAL_PROJECT_ID,
  });

  return result.secrets;
}

export async function getInfisicalProvider() {
  if (client) {
    return client;
  }

  try {
    client = await connect(currentSettings());
    return client;
  } catch (e) {
    console.error("Failed to initialize or authenticate Infisical SDK:", e);
    throw e;
  }
}

export async function getSecrets(): Promise<Secret[] | undefined> {
  if (!process.env.INFISICAL_URL) {
    return undefined;
  }

  try {
    return await listSecrets(await getInfisicalProvider(), currentSettings());
  } catch (e) {
    console.error("Failed to fetch secrets from Infisical:", e);
    // log in again on the next poll, in case the session expired or was revoked
    client = undefined;
    return undefined;
  }
}

/**
 * Logs in and fetches secrets with `settings`, and makes that the client used from now
 * on if both work. Returns whether it switched; the current client is kept otherwise.
 */
export async function switchSettings(settings: Record<string, string>): Promise<boolean> {
  try {
    const newClient = await connect(settings);
    await listSecrets(newClient, settings);
    client = newClient;
    return true;
  } catch (e) {
    console.error("Failed to connect to Infisical with the Infisical settings stored in it:", e);
    return false;
  }
}

function getCachePath(): string | undefined {
  return process.env.GITAINER_DATA ? `${process.env.GITAINER_DATA}/infisicalCache.json` : undefined;
}

function getBootstrapPath(): string | undefined {
  return process.env.GITAINER_DATA ? `${process.env.GITAINER_DATA}/infisicalBootstrap.json` : undefined;
}

function writeCache(cachePath: string | undefined, env: Record<string, string>) {
  const json = JSON.stringify(env);
  if (!cachePath || (lastWritten.get(cachePath) === json && existsSync(cachePath))) {
    return;
  }

  try {
    writeFileSync(`${cachePath}.tmp`, json, { mode: 0o600 });
    renameSync(`${cachePath}.tmp`, cachePath);
    lastWritten.set(cachePath, json);
  } catch (e) {
    console.error("Failed to write Infisical cache:", e);
  }
}

function readCache(cachePath: string | undefined): Record<string, string> | undefined {
  if (!cachePath) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to read Infisical cache:", e);
    }
    return undefined;
  }
}

function withoutProtected(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => {
    if (!PROTECTED_KEYS.includes(key)) {
      return true;
    }
    if (warnedProtected.get(key) !== value) {
      console.warn(`[Infisical] Ignoring secret "${key}": it would override the ${key} gitainer itself runs with. Delete it from Infisical.`);
      warnedProtected.set(key, value);
    }
    return false;
  }));
}

function applyEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    if (!appliedKeys.has(key)) {
      appliedKeys.set(key, process.env[key]);
    }
    process.env[key] = value;
  }
}

/**
 * Handles keys that were in Infisical (set by it in this process, or in the cache from the
 * last fetch) but aren't in `fetched`. Ones Infisical set in this process are unset. A value
 * from gitainer's `environment:` or .env isn't touched, but is warned about: it's what stacks
 * get once the key is gone from Infisical, e.g. after a restart.
 */
function unsetDeleted(fetched: Record<string, string>, previousCache: Record<string, string>) {
  const known = new Set([...appliedKeys.keys(), ...Object.keys(previousCache)]);
  const deleted = [...known].filter(key =>
    !(key in fetched) && !PROTECTED_KEYS.includes(key) && !BOOTSTRAP_KEYS.includes(key));

  for (const key of deleted) {
    if (appliedKeys.has(key)) {
      const replaced = appliedKeys.get(key);
      appliedKeys.delete(key);
      delete process.env[key];
      if (replaced === undefined) {
        console.log(`== "${key}" was deleted from Infisical, unset it ==`);
      } else {
        console.warn(`[Infisical] "${key}" was deleted from Infisical, so it's unset now, but gitainer's environment or .env also sets it: that value comes back on the next restart. Remove it there too if it's no longer needed.`);
      }
    } else if (process.env[key] !== undefined) {
      console.warn(`[Infisical] "${key}" was deleted from Infisical, but gitainer's environment or .env still sets it, so that value is used. Remove it there too if it's no longer needed.`);
    }
  }
}

// fill in any unset Infisical settings from the last config that fetched successfully.
// Explicitly set ones win, so a rotated client secret can still be passed in
function applyBootstrapCache() {
  const missing = Object.entries(readCache(getBootstrapPath()) ?? {})
    .filter(([key]) => BOOTSTRAP_KEYS.includes(key) && !process.env[key]);

  if (missing.length > 0) {
    console.log(`== loading ${missing.map(([key]) => key).join(", ")} from the Infisical bootstrap cache ==`);
    Object.assign(process.env, Object.fromEntries(missing));
  }
}

// switch to Infisical settings that Infisical itself provides, once they're verified
async function applyInfisicalSettings(fromInfisical: Record<string, string>) {
  const current = currentSettings();
  const changed = Object.keys(fromInfisical).filter(key => current[key] !== fromInfisical[key]);
  if (changed.length === 0) {
    return;
  }

  const next = { ...current, ...fromInfisical };
  const nextJson = JSON.stringify(next);
  if (nextJson === rejectedSettings) {
    return;
  }

  if (await switchSettings(next)) {
    console.log(`== switched to ${changed.join(", ")} from Infisical ==`);
    Object.assign(process.env, next);
    rejectedSettings = undefined;
  } else {
    console.error(`Keeping the current ${changed.join(", ")}, the ones in Infisical failed to connect`);
    rejectedSettings = nextJson;
  }
}

export async function updateProcessEnv(): Promise<boolean> {
  applyBootstrapCache();

  const secrets = await getSecrets();

  if (secrets && secrets.length > 0) {
    const newEnv: Record<string, string> = {};
    const settingsFromInfisical: Record<string, string> = {};

    secrets.forEach(secret => {
      let value = secret.secretValue;
      if (value.includes('\n')) {
        console.warn(`[Infisical] Secret "${secret.secretKey}" contains newlines. Flattening to single line.`);
        value = value.replace(/\n/g, ' ');
      }
      if (BOOTSTRAP_KEYS.includes(secret.secretKey)) {
        settingsFromInfisical[secret.secretKey] = value;
      } else {
        newEnv[secret.secretKey] = value;
      }
    });

    const fetched = withoutProtected(newEnv);
    unsetDeleted(fetched, readCache(getCachePath()) ?? {});

    // keep the last fetched secrets on disk, so a restart while Infisical is unreachable
    // (e.g. its reverse proxy is down) doesn't leave stacks without their variables
    writeCache(getCachePath(), fetched);
    applyEnv(fetched);

    await applyInfisicalSettings(settingsFromInfisical);
    // these settings just worked, so keep them for starting without a .env
    writeCache(getBootstrapPath(), currentSettings());
    return true;
  }

  // Infisical unreachable: apply the last fetched secrets the same way a live fetch
  // would, so the env matches the last successful fetch. After a live fetch in this
  // process the cache already matches process.env and nothing changes
  if (!secrets) {
    // Infisical settings only ever change through a verified switch
    // a cache written before protected keys were ignored may still hold them
    const changed = Object.entries(withoutProtected(readCache(getCachePath()) ?? {}))
      .filter(([key, value]) => !BOOTSTRAP_KEYS.includes(key) && process.env[key] !== value);

    if (changed.length > 0) {
      console.log(`== Infisical unavailable, loading ${changed.length} cached secret(s) ==`);
      applyEnv(Object.fromEntries(changed));
      return true;
    }
  }

  return false;
}
