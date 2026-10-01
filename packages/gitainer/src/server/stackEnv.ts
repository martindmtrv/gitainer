import { createHash } from "node:crypto";
import { composeVariables } from "../docker/DockerClient";
import type { EventStore } from "../store/EventStore";

/**
 * The env a stack was deployed with: a hash of the value of each variable it reads, or null for
 * one that wasn't set. Hashes rather than values, so the history database holds no secrets.
 */
export type EnvFingerprint = Record<string, string | null>;

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function envFingerprint(variables: string[], env: Record<string, string | undefined> = process.env): EnvFingerprint {
  return Object.fromEntries(variables.map(name => [name, env[name] === undefined ? null : hashValue(env[name] as string)]));
}

/**
 * The variables in `variables` whose value isn't the one the stack was deployed with. A variable
 * the stack didn't read back then is left out: it came with a compose change, not an env change.
 */
export function staleVariables(deployed: EnvFingerprint, variables: string[], env: Record<string, string | undefined> = process.env): string[] {
  const current = envFingerprint(variables, env);
  return variables.filter(name => name in deployed && deployed[name] !== current[name]);
}

/**
 * Remembers the env `stackName` was just deployed with, so a later change to it can be told as
 * the stack running with stale values. Never throws: it runs right after a deploy that succeeded.
 */
export async function recordDeployedEnv(store: EventStore | undefined, stackName: string, composeString: string): Promise<void> {
  if (!store) {
    return;
  }
  try {
    await store.recordStackEnv(stackName, envFingerprint(await composeVariables(composeString)));
  } catch (e) {
    console.error(`Could not record the env ${stackName} was deployed with:`, e);
  }
}
