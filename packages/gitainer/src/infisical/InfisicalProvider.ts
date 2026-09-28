import { InfisicalSDK, type Secret } from "@infisical/sdk";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

let lastCached: { path: string, json: string } | undefined = undefined;

let client: InfisicalSDK | undefined = undefined;

export async function getInfisicalProvider() {
  if (client) {
    return client;
  }

  try {
    const newClient = new InfisicalSDK({
      siteUrl: process.env.INFISICAL_URL as string,
    });

    // Authenticate with Infisical
    await newClient.auth().universalAuth.login({
      clientId: process.env.INFISICAL_CLIENT_ID as string,
      clientSecret: process.env.INFISICAL_CLIENT_SECRET as string,
    });

    client = newClient;
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

  console.log("== fetching Infisical secrets ==");

  try {
    const client = await getInfisicalProvider();

    const result = await client.secrets().listSecrets({
      environment: process.env.INFISICAL_PROJECT_ENVIRONMENT as string,
      projectId: process.env.INFISICAL_PROJECT_ID as string,
    });

    return result.secrets;
  } catch (e) {
    console.error("Failed to fetch secrets from Infisical:", e);
    return undefined;
  }
}

function getCachePath(): string | undefined {
  return process.env.GITAINER_DATA ? `${process.env.GITAINER_DATA}/infisicalCache.json` : undefined;
}

// keep the last fetched secrets on disk, so a restart while Infisical is unreachable
// (e.g. its reverse proxy is down) doesn't leave stacks without their variables
function writeCache(env: Record<string, string>) {
  const cachePath = getCachePath();
  const json = JSON.stringify(env);
  if (!cachePath || (lastCached?.path === cachePath && lastCached.json === json && existsSync(cachePath))) {
    return;
  }

  try {
    writeFileSync(`${cachePath}.tmp`, json, { mode: 0o600 });
    renameSync(`${cachePath}.tmp`, cachePath);
    lastCached = { path: cachePath, json };
  } catch (e) {
    console.error("Failed to write Infisical cache:", e);
  }
}

function readCache(): Record<string, string> | undefined {
  const cachePath = getCachePath();
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

export async function updateProcessEnv(): Promise<boolean> {
  const secrets = await getSecrets();

  if (secrets && secrets.length > 0) {
    console.log("== updating process.env from Infisical ==");
    const newEnv: Record<string, string> = {};

    secrets.forEach(secret => {
      let value = secret.secretValue;
      if (value.includes('\n')) {
        console.warn(`[Infisical] Secret "${secret.secretKey}" contains newlines. Flattening to single line.`);
        value = value.replace(/\n/g, ' ');
      }
      newEnv[secret.secretKey] = value;
    });

    writeCache(newEnv);
    Object.assign(process.env, newEnv);
    return true;
  }

  // Infisical unreachable: apply the last fetched secrets the same way a live fetch
  // would, so the env matches the last successful fetch. After a live fetch in this
  // process the cache already matches process.env and nothing changes
  if (!secrets) {
    const changed = Object.entries(readCache() ?? {}).filter(([key, value]) => process.env[key] !== value);

    if (changed.length > 0) {
      console.log(`== Infisical unavailable, loading ${changed.length} cached secret(s) ==`);
      Object.assign(process.env, Object.fromEntries(changed));
      return true;
    }
  }

  return false;
}
