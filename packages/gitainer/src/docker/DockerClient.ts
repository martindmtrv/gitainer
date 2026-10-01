import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { $ } from "bun";
import { isDeepStrictEqual } from "node:util";
import { isTransientPullError, withRetry } from "./retry";
import jsyaml from "js-yaml";
import selfUpdateScript from "./self-update.sh" with { type: "text" };

export interface RemoteHostConfig {
  dockerHost: string;
  composeProjectDir?: string;
}

export function extractRemoteHostConfig(composeString: string): RemoteHostConfig | undefined {
  const lines = composeString.split(/\r?\n/);
  
  // Validate that no other line starts with #@
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("#@")) {
      throw new Error("Remote host comment (#@) is only allowed once per stack, exactly at the first line");
    }
  }

  const firstLine = lines[0]?.trim() || "";
  if (firstLine.startsWith("#@")) {
    const match = firstLine.match(/^#@\s*(.+)$/);
    if (!match) {
      throw new Error("Invalid remote host comment syntax at line 1");
    }
    const fullValue = match[1].trim();
    
    let temp = fullValue;
    let scheme = "";
    const schemeMatch = temp.match(/^([a-zA-Z0-9.+-]+:\/\/)/);
    if (schemeMatch) {
      scheme = schemeMatch[1];
      temp = temp.substring(scheme.length);
    }

    let hostPart = temp;
    let pathPart: string | undefined = undefined;

    const lastColonIndex = temp.lastIndexOf(":");
    if (lastColonIndex !== -1) {
      const afterColon = temp.substring(lastColonIndex + 1).trim();
      const isNumeric = /^\d+$/.test(afterColon);
      if (!isNumeric) {
        hostPart = temp.substring(0, lastColonIndex).trim();
        const cleanPath = afterColon.trim();
        if (cleanPath) {
          pathPart = cleanPath;
        }
      }
    }

    if (!hostPart) {
      throw new Error("Invalid remote host comment syntax at line 1: missing host");
    }

    const dockerHost = scheme ? `${scheme}${hostPart}` : `ssh://${hostPart}`;

    return {
      dockerHost,
      composeProjectDir: pathPart,
    };
  }

  return undefined;
}

/**
 * Reads the top-level `x-shutdown-hook` from a compose file. Compose ignores top-level `x-`
 * extension fields, so the key doesn't need to be stripped before handing the file to compose.
 */
export function extractShutdownHook(composeString: string): string[] {
  let parsed: any;
  try {
    parsed = jsyaml.load(composeString);
  } catch (e) {
    return [];
  }

  const hook = parsed && typeof parsed === 'object' ? parsed['x-shutdown-hook'] : undefined;
  if (hook === undefined || hook === null) {
    return [];
  }
  if (typeof hook === 'string') {
    return [hook];
  }
  if (Array.isArray(hook) && hook.every(cmd => typeof cmd === 'string')) {
    return hook;
  }
  throw new Error("x-shutdown-hook must be a command string or a list of command strings");
}

const DISABLED_KEY = 'x-gitainer-disabled';

// the raw top-level x-gitainer-disabled value, before compose interpolates it
function rawDisabledFlag(composeString: string): unknown {
  let parsed: any;
  try {
    parsed = jsyaml.load(composeString);
  } catch (e) {
    return undefined;
  }

  return parsed && typeof parsed === 'object' ? parsed[DISABLED_KEY] : undefined;
}

// a string with a `$` is handed to compose to interpolate. Anything else has to be a YAML boolean
function isInterpolatedFlag(flag: unknown): flag is string {
  return typeof flag === 'string' && flag.includes('$');
}

// a compose file holding only the flag, so interpolating it doesn't depend on the rest of the stack
function disabledFlagCompose(flag: string): string {
  return jsyaml.dump({ [DISABLED_KEY]: flag });
}

/**
 * Whether the compose file sets the top-level `x-gitainer-disabled: true`, which keeps the stack
 * down. Read from the parsed YAML, so a commented-out flag doesn't count. The value may come from
 * an env var (`${DISABLE_APP}`, `${DISABLE_APP:-false}`): it's then interpolated by compose
 * itself, and has to come out as `true` or `false`. A blank result (the variable is unset, with no
 * default) counts as not disabled. Throws on any other value, and on a hard-coded one that isn't
 * a boolean, so a typo like `"true"` fails the push instead of deploying the stack.
 */
export async function isStackDisabled(composeString: string): Promise<boolean> {
  const flag = rawDisabledFlag(composeString);
  if (flag === undefined || flag === null) {
    return false;
  }
  if (typeof flag === 'boolean') {
    return flag;
  }
  if (!isInterpolatedFlag(flag)) {
    throw new Error(`${DISABLED_KEY} must be true or false, got ${JSON.stringify(flag)}`);
  }

  const fileName = composeStringToTmp(disabledFlagCompose(flag));
  try {
    const result = await $`docker compose -f ${fileName} config --format json`.nothrow().quiet();
    if (result.exitCode !== 0) {
      throw new Error(`Could not interpolate ${DISABLED_KEY} (${flag}): ${result.stderr.toString().trim()}`);
    }
    const value = String(JSON.parse(result.stdout.toString())[DISABLED_KEY] ?? '').trim().toLowerCase();
    if (value === 'true' || value === 'false' || value === '') {
      return value === 'true';
    }
    // not the interpolated value: it comes from the env, so it could be a secret
    throw new Error(`${DISABLED_KEY} (${flag}) must interpolate to true or false`);
  } finally {
    rmSync(fileName, { force: true });
  }
}

/**
 * The variables the compose file's `x-gitainer-disabled` reads, e.g. `DISABLE_APP` for
 * `${DISABLE_APP:-false}`. Empty for a hard-coded (or missing) flag.
 */
export async function disabledFlagVariables(composeString: string): Promise<string[]> {
  const flag = rawDisabledFlag(composeString);
  return isInterpolatedFlag(flag) ? await composeVariables(disabledFlagCompose(flag)) : [];
}

/**
 * Whether two versions of a stack deploy the same thing: the same parsed YAML and the same
 * `#@` remote host. They then only differ in comments or formatting. Compared as parsed YAML
 * rather than by stripping `#` lines, since a `#` inside a quoted string or block scalar isn't a
 * comment. False when either version can't be parsed, so the deploy reports the real error.
 */
export function isSameComposeContent(oldCompose: string, newCompose: string): boolean {
  try {
    return isDeepStrictEqual(extractRemoteHostConfig(oldCompose), extractRemoteHostConfig(newCompose))
      && isDeepStrictEqual(jsyaml.load(oldCompose), jsyaml.load(newCompose));
  } catch (e) {
    return false;
  }
}

export function parseCommandString(cmd: string): string[] {
  const matches = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return matches.map(arg => {
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      return arg.slice(1, -1);
    }
    return arg;
  });
}

/**
 * Parses the `GITAINER_COMMANDS` env var: a JSON object mapping a name (used as
 * `/api/commands/:name`) to a `docker exec ...` command string. Restricted to `docker exec`
 * (rather than arbitrary shell) to bound what an operator can wire up through env config -
 * same blast radius as the raw docker API gated behind ENABLE_RAW_API, not a general shell.
 */
export function parseNamedCommands(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`GITAINER_COMMANDS is not valid JSON: ${(e as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GITAINER_COMMANDS must be a JSON object of name -> command string");
  }

  const commands = parsed as Record<string, unknown>;
  for (const [name, cmd] of Object.entries(commands)) {
    if (typeof cmd !== "string") {
      throw new Error(`GITAINER_COMMANDS["${name}"] must be a string`);
    }
    const args = parseCommandString(cmd);
    if (args[0] !== "docker" || args[1] !== "exec") {
      throw new Error(`GITAINER_COMMANDS["${name}"] must start with "docker exec"`);
    }
  }

  return commands as Record<string, string>;
}

function composeStringToTmp(composeString: string): string {
  const fileName = `/tmp/gitainer/${randomUUID()}.yaml`;

  // make tmp dir
  if (!existsSync("/tmp/gitainer")) {
    mkdirSync("/tmp/gitainer");
  }

  writeFileSync(fileName, composeString);

  return fileName;
}

/**
 * Names of the variables compose would interpolate in `composeString`, from
 * `docker compose config --variables`. Unlike a regex over the text, this skips escaped `$$VAR`
 * and variables in comments. Variables in `prefix_entrypoint` are included, since that ends up
 * in the service's entrypoint and compose interpolates it there. Throws if compose can't parse
 * the file.
 */
export async function composeVariables(composeString: string): Promise<string[]> {
  return (await composeVariableDetails(composeString)).map(variable => variable.name);
}

export interface ComposeVariable {
  name: string;
  // `${VAR:-default}` with a non-empty default, so the stack still deploys with it unset
  hasDefault: boolean;
  // `${VAR:?err}`: compose refuses to deploy the stack with it unset
  required: boolean;
}

/** composeVariables(), with whether each variable has a default or is required. */
export async function composeVariableDetails(composeString: string): Promise<ComposeVariable[]> {
  const fileName = composeStringToTmp(composeString);
  try {
    const result = await $`docker compose -f ${fileName} config --variables --format json`.nothrow().quiet();
    if (result.exitCode !== 0) {
      throw new Error(`docker compose config failed (exit code ${result.exitCode}): ${result.stderr.toString().trim()}`);
    }
    const variables: Record<string, { DefaultValue?: string, Required?: boolean }> = JSON.parse(result.stdout.toString()) || {};
    return Object.entries(variables).map(([name, variable]) => ({
      name,
      hasDefault: !!variable.DefaultValue,
      required: !!variable.Required,
    }));
  } finally {
    rmSync(fileName, { force: true });
  }
}

export interface StackContainer {
  name: string;
  service: string;
  // docker's container state: running, exited, restarting, ...
  state: string;
  // docker's human readable status, e.g. "Up 2 hours (healthy)"
  status: string;
}

// how long a status lookup may take: an unreachable remote host would otherwise hang on ssh
const STATUS_TIMEOUT_MS = 8_000;

export class DockerClient {
  private composeStringToTmp(composeString: string): string {
    return composeStringToTmp(composeString);
  }

  /**
   * Compose update is -> down(), pull(), up(). Pass `pull: false` when the images were already
   * pulled (see composePull()), so a failed pull can't leave the stack down.
   */
  async composeUpdate(composeString: string, stackName: string, pull: boolean = true) {
    // validate the shutdown hook up front, so a malformed one fails the deploy that introduced
    // it rather than the later down() of this stack
    extractShutdownHook(composeString);

    const config = extractRemoteHostConfig(composeString);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    const strippedCompose = this.stripPrefixEntrypoint(composeString);
    const strippedFilename = this.composeStringToTmp(strippedCompose);

    if (cmdEnv) {
      await $`docker compose -f ${strippedFilename} -p ${stackName} down`.env(cmdEnv);
    } else {
      await $`docker compose -f ${strippedFilename} -p ${stackName} down`;
    }
    if (pull) {
      await this.pullWithRetry(strippedFilename, stackName, cmdEnv);
    }

    return await this.hydratedUp(composeString, stackName, cmdEnv, true);
  }

  /**
   * `docker compose up -d` without a down or pull first: starts a downed stack, and only
   * recreates containers whose config (or env) changed. Images that aren't present locally are
   * still pulled by compose itself.
   */
  async composeUp(composeString: string, stackName: string) {
    extractShutdownHook(composeString);

    const config = extractRemoteHostConfig(composeString);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    return await this.hydratedUp(composeString, stackName, cmdEnv, false);
  }

  private async hydratedUp(composeString: string, stackName: string, cmdEnv: Record<string, string> | undefined, forceRecreate: boolean) {
    const hydratedCompose = await this.preprocessCompose(composeString, cmdEnv);
    const finalFilename = this.composeStringToTmp(hydratedCompose);
    const recreateFlag = forceRecreate ? ["--force-recreate"] : [];

    if (cmdEnv) {
      return await $`docker compose -f ${finalFilename} -p ${stackName} up -d ${recreateFlag}`.env(cmdEnv);
    } else {
      return await $`docker compose -f ${finalFilename} -p ${stackName} up -d ${recreateFlag}`;
    }
  }

  selfUpdateContainerName(stackName: string): string {
    return `gitainer-self-update-${stackName}`;
  }

  /**
   * Best-effort lookup of the compose project label on gitainer's own running container
   * (Docker sets HOSTNAME to the container's short ID by default), used only to warn on
   * startup if GITAINER_SELF_STACK doesn't match gitainer's actual deployment.
   */
  async getOwnComposeProject(): Promise<string | undefined> {
    if (!process.env.HOSTNAME) {
      return undefined;
    }

    try {
      const label = await $`docker inspect ${process.env.HOSTNAME} --format ${'{{ index .Config.Labels "com.docker.compose.project" }}'}`.text();
      return label.trim() || undefined;
    } catch (e) {
      return undefined;
    }
  }

  // a proxy config reload drops the connection for a moment, so a few seconds apart is enough
  static PULL_ATTEMPTS = 3;
  static PULL_RETRY_DELAY_MS = 5_000;

  // env vars that are process/runtime bookkeeping rather than gitainer config or compose
  // variable-interpolation values - forwarding them into the sibling would be pointless at
  // best (nobody names a compose variable "PATH") and could shadow the sibling's own values
  // at worst, so they're excluded from composeSelfUpdate's environment forwarding below.
  private static readonly SELF_UPDATE_ENV_FORWARD_DENYLIST = new Set([
    "PATH", "HOME", "HOSTNAME", "PWD", "OLDPWD", "SHLVL", "_", "STACK_NAME",
    "SELF_UPDATE_WEBHOOK_URL", "SELF_UPDATE_WEBHOOK_TITLE",
  ]);

  /**
   * Self-update can't run down()/up() in-process like composeUpdate() does: if the target
   * stack is gitainer's own container, stopping it to recreate would kill the very process
   * running this sequence before it finishes. pull() is safe to run in-process though (it
   * never touches the running container), so only the recreate is handed off to a detached
   * sibling container (launched via the docker socket, so it survives gitainer's own container
   * being replaced) - if pull() fails here, the running gitainer container is never touched.
   *
   * Split into a "prepare" phase (safe, in-process: validate, pull, hydrate, stage the sibling
   * container) and a returned "trigger" closure that actually starts the sibling and thus the
   * recreate. Callers that are mid-response to the git client that pushed this update (the only
   * realistic caller) must call the trigger only *after* that response has been fully flushed:
   * `docker start` here can end with gitainer's own container being replaced, which kills this
   * process - if that happens while the git push's HTTP response is still in flight, the client
   * sees a broken/aborted push even though the update went through. Deferring the trigger until
   * after the response is sent avoids that race.
   *
   * With `notify`, the sibling POSTs the recreate's outcome to `notify.url` once it's done,
   * since gitainer itself may not be around anymore to report it.
   */
  async prepareSelfUpdate(composeString: string, stackName: string, pull: boolean = true, notify?: { url: string, title: string }): Promise<() => Promise<void>> {
    const config = extractRemoteHostConfig(composeString);
    if (config) {
      throw new Error(`Self-update stack "${stackName}" cannot use a remote host (#@) comment; gitainer can only self-update the host it is running on`);
    }

    const strippedCompose = this.stripPrefixEntrypoint(composeString);
    const strippedFilename = this.composeStringToTmp(strippedCompose);
    // callers that already pulled (see GitainerServer.synthesisTime) pass pull: false
    if (pull) {
      await this.pullWithRetry(strippedFilename, stackName);
    }

    const hydratedCompose = await this.preprocessCompose(composeString);
    const hydratedFilename = this.composeStringToTmp(hydratedCompose);
    // The Dockerfile sets this to the docker image gitainer itself is built on (its DOCKER_VERSION
    // build arg); the fallback only applies when running outside that image.
    const helperImage = process.env.GITAINER_SELF_UPDATE_HELPER_IMAGE || "docker:cli";
    const containerName = this.selfUpdateContainerName(stackName);

    // Forward gitainer's own environment into the sibling (bare `-e KEY` makes docker pull the
    // value from the invoking process, i.e. gitainer's own process.env) so compose variable
    // interpolation (see README "Variables") resolves the same way here as it does in-process
    // for pull() above and for every other stack's composeUpdate().
    const envForwarding = Object.keys(process.env)
      .filter(key => !DockerClient.SELF_UPDATE_ENV_FORWARD_DENYLIST.has(key))
      .flatMap(key => ["-e", key]);
    const notifyEnv = notify
      ? ["-e", `SELF_UPDATE_WEBHOOK_URL=${notify.url}`, "-e", `SELF_UPDATE_WEBHOOK_TITLE=${notify.title}`]
      : [];

    // The hydrated compose is handed to the sibling as a real file rather than an env var
    // (avoids the ~128KB env var size limit), via `docker cp` instead of a bind mount: `cp`
    // goes over the docker socket itself, copying from wherever gitainer's own tmp file
    // actually lives into the container's filesystem, so it needs no host-path translation or
    // self-container-identification - it behaves the same whether gitainer runs bare or inside
    // a container. `create` (not `run`) so the file can be copied in before the entrypoint
    // executes; `--rm` still auto-removes the container once it exits, same as before.
    await $`docker create --rm --name ${containerName} -v /var/run/docker.sock:/var/run/docker.sock ${envForwarding} ${notifyEnv} -e STACK_NAME="${stackName}" ${helperImage} sh -c "${selfUpdateScript}"`;
    await $`docker cp ${hydratedFilename} ${containerName}:/self-update.yaml`;

    return async () => {
      await $`docker start ${containerName}`;
    };
  }

  /**
   * Convenience wrapper around prepareSelfUpdate() that triggers immediately - used directly
   * by callers that aren't mid-response to the client that initiated the update (e.g. tests).
   * GitainerServer's git-push path calls prepareSelfUpdate() itself so it can defer the trigger.
   */
  async composeSelfUpdate(composeString: string, stackName: string): Promise<void> {
    const trigger = await this.prepareSelfUpdate(composeString, stackName);
    await trigger();
  }

  /**
   * Containers labelled `gitainer.identifier=<identifier>` (in any stack, e.g. via a
   * fragment shared across stacks) can be bulk stopped/started together, independent of
   * which compose stack they belong to.
   */
  private async listContainerIdsByLabel(identifier: string): Promise<string[]> {
    const output = await $`docker ps -aq --filter label=gitainer.identifier=${identifier}`.text();
    return output.split("\n").map(id => id.trim()).filter(Boolean);
  }

  async stopContainersByLabel(identifier: string): Promise<string[]> {
    const ids = await this.listContainerIdsByLabel(identifier);
    if (ids.length > 0) {
      await $`docker stop ${ids}`;
    }
    return ids;
  }

  async startContainersByLabel(identifier: string): Promise<string[]> {
    const ids = await this.listContainerIdsByLabel(identifier);
    if (ids.length > 0) {
      await $`docker start ${ids}`;
    }
    return ids;
  }

  /**
   * Runs `registry garbage-collect` inside a running Docker Registry (distribution/distribution)
   * container via `docker exec`, so registry blob storage reclaims space from deleted/untagged
   * manifests. `configPath` must match the registry's own config file path inside the container
   * (default matches the official `registry` image).
   */
  async registryGarbageCollect(containerName: string, deleteUntagged: boolean, configPath: string = "/etc/docker/registry/config.yml"): Promise<string> {
    const flags = deleteUntagged ? ["-m"] : [];
    const output = await $`docker exec ${containerName} registry garbage-collect ${flags} ${configPath}`.text();
    return output;
  }

  /** Runs a pre-validated `docker exec ...` command string (see parseNamedCommands). */
  async runCommand(cmd: string): Promise<string> {
    const args = parseCommandString(cmd);
    return await $`${args}`.text();
  }

  /**
   * Pulls images for a compose file without touching running containers. Used to pull the
   * new stack definition's images before the old stack is torn down, so a same-image update
   * has no pull-induced downtime between down() and up().
   */
  async composePull(composeString: string, stackName: string) {
    const config = extractRemoteHostConfig(composeString);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    const strippedCompose = this.stripPrefixEntrypoint(composeString);
    const strippedFilename = this.composeStringToTmp(strippedCompose);

    await this.pullWithRetry(strippedFilename, stackName, cmdEnv);
  }

  /**
   * `docker compose pull`, retried: pulls through a reverse proxy can fail with `EOF` when the
   * proxy reloads its config mid-request (e.g. caddy-docker-proxy reloading on every container
   * start/stop, which is exactly what a deploy causes).
   */
  private async pullWithRetry(filename: string, stackName: string, cmdEnv?: Record<string, string | undefined>) {
    await withRetry(
      () => cmdEnv ? $`docker compose -f ${filename} pull`.env(cmdEnv) : $`docker compose -f ${filename} pull`,
      {
        attempts: DockerClient.PULL_ATTEMPTS,
        delayMs: DockerClient.PULL_RETRY_DELAY_MS,
        label: `Pulling images for ${stackName}`,
        shouldRetry: isTransientPullError,
      },
    );
  }

  /**
   * `hookCompose` is the compose file whose `x-shutdown-hook` runs before the down. Callers
   * replacing a stack pass the incoming version, so pushing a fixed hook unblocks a stack whose
   * deployed hook is broken, rather than the deployed hook trapping it. `log` receives the
   * shutdown hook's progress and output, so a push can relay it to the git client.
   */
  async composeDown(composeString: string, stackName: string, hookCompose: string = composeString, log: (msg: string) => void = console.log) {
    const strippedCompose = this.stripPrefixEntrypoint(composeString);
    const filename = this.composeStringToTmp(strippedCompose);
    const config = extractRemoteHostConfig(strippedCompose);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    // throws (aborting the down) if any shutdown hook command exits non-zero
    await this.runShutdownHook(hookCompose, stackName, cmdEnv, log);

    if (cmdEnv) {
      return await $`docker compose -f ${filename} -p ${stackName} down`.env(cmdEnv);
    } else {
      return await $`docker compose -f ${filename} -p ${stackName} down`;
    }
  }

  /**
   * Whether the compose project has any containers (running or stopped) on the target host.
   * Used to skip the shutdown hook for a stack that isn't actually deployed.
   */
  async isStackDeployed(stackName: string, cmdEnv?: Record<string, string | undefined>): Promise<boolean> {
    const filter = `label=com.docker.compose.project=${stackName}`;
    const output = cmdEnv
      ? await $`docker ps -aq --filter ${filter}`.env(cmdEnv).text()
      : await $`docker ps -aq --filter ${filter}`.text();
    return output.trim().length > 0;
  }

  /**
   * isStackDeployed() on the host the compose file targets (a remote host, if it sets one).
   */
  async isComposeStackDeployed(composeString: string, stackName: string): Promise<boolean> {
    const config = extractRemoteHostConfig(composeString);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;
    return await this.isStackDeployed(stackName, cmdEnv);
  }

  /**
   * Runs the stack-level `x-shutdown-hook` (a command string or list of command strings) via
   * `sh -c`, in order, before the stack is downed. Runs with the same environment as the
   * compose commands, so `docker ...` in a hook targets the stack's (possibly remote) host.
   * Skipped when the stack has no containers, so a broken hook can't wedge a stack that isn't
   * running. Throws on the first command that exits non-zero, which aborts the down.
   * Each command and its output go to `log`.
   */
  async runShutdownHook(composeString: string, stackName: string, cmdEnv?: Record<string, string | undefined>, log: (msg: string) => void = console.log) {
    const hookCmds = extractShutdownHook(composeString);
    if (hookCmds.length === 0) {
      return;
    }

    if (!await this.isStackDeployed(stackName, cmdEnv)) {
      log(`Skipping shutdown hook for ${stackName}: stack has no containers`);
      return;
    }

    for (const cmd of hookCmds) {
      log(`Running shutdown hook for ${stackName}: ${cmd}`);
      // quiet() so the output isn't echoed to the server console on top of the log() below
      const result = cmdEnv
        ? await $`sh -c ${cmd}`.env(cmdEnv).nothrow().quiet()
        : await $`sh -c ${cmd}`.nothrow().quiet();

      const stdout = result.stdout.toString().trim();
      const stderr = result.stderr.toString().trim();
      if (stdout) log(stdout);
      if (stderr) log(stderr);

      if (result.exitCode !== 0) {
        const output = stderr || stdout;
        throw new Error(`Shutdown hook for stack "${stackName}" failed (exit code ${result.exitCode}): ${cmd}${output ? `\n${output}` : ''}`);
      }
    }
  }

  /**
   * The containers (running or stopped) of the compose projects on a host, by project name:
   * of every project, or only `stackName`'s. `dockerHost` is a remote host from a `#@` comment,
   * the local docker otherwise. Throws if docker doesn't answer within `timeoutMs`.
   */
  async listStackContainers(dockerHost?: string, stackName?: string, timeoutMs: number = STATUS_TIMEOUT_MS): Promise<Map<string, StackContainer[]>> {
    const filter = `label=com.docker.compose.project${stackName ? `=${stackName}` : ''}`;
    const format = ['{{.Label "com.docker.compose.project"}}', '{{.Label "com.docker.compose.service"}}', '{{.Names}}', '{{.State}}', '{{.Status}}'].join('\t');
    const proc = Bun.spawn(['docker', 'ps', '-a', '--filter', filter, '--format', format], {
      env: dockerHost ? { ...process.env, DOCKER_HOST: dockerHost } : process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    if (timedOut) {
      throw new Error(`${dockerHost ?? 'docker'} didn't answer within ${timeoutMs / 1000}s`);
    }
    if (exitCode !== 0) {
      throw new Error(`docker ps failed (exit code ${exitCode}): ${stderr.trim()}`);
    }

    const byProject = new Map<string, StackContainer[]>();
    for (const line of stdout.split("\n").filter(Boolean)) {
      const [project, service, name, state, status] = line.split("\t");
      byProject.set(project, [...(byProject.get(project) ?? []), { name, service, state, status }]);
    }
    return byProject;
  }

  /**
   * The compose file as it would deploy now, with env vars interpolated, from
   * `docker compose config`. Compose normalises it, so comments are dropped. It holds every
   * secret the stack reads. `prefix_entrypoint` is hydrated like a deploy does, or left out
   * (with a note) if the image isn't there to inspect yet.
   */
  async composeResolved(composeString: string, stackName: string): Promise<string> {
    const config = extractRemoteHostConfig(composeString);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    let hydratedCompose: string;
    let note = "";
    try {
      hydratedCompose = await this.preprocessCompose(composeString, cmdEnv as Record<string, string> | undefined);
    } catch (e) {
      hydratedCompose = this.stripPrefixEntrypoint(composeString);
      note = "# prefix_entrypoint left out: its image couldn't be inspected, it's pulled on the next deploy\n";
    }

    const fileName = this.composeStringToTmp(hydratedCompose);
    try {
      const result = cmdEnv
        ? await $`docker compose -f ${fileName} -p ${stackName} config`.env(cmdEnv).nothrow().quiet()
        : await $`docker compose -f ${fileName} -p ${stackName} config`.nothrow().quiet();
      if (result.exitCode !== 0) {
        throw new Error(`docker compose config failed (exit code ${result.exitCode}): ${result.stderr.toString().trim()}`);
      }
      return (config ? `${composeString.split(/\r?\n/)[0].trim()}\n` : "") + note + result.stdout.toString();
    } finally {
      rmSync(fileName, { force: true });
    }
  }

  stripPrefixEntrypoint(composeString: string): string {
    const lines = composeString.split(/\r?\n/);
    const firstLine = lines[0]?.trim() || "";
    const hasRemoteHostComment = firstLine.startsWith("#@");

    let parsed: any;
    try {
      parsed = jsyaml.load(composeString);
    } catch (e) {
      return composeString;
    }

    if (parsed && typeof parsed === 'object' && parsed.services && typeof parsed.services === 'object') {
      for (const serviceName of Object.keys(parsed.services)) {
        const service = parsed.services[serviceName];
        if (service && typeof service === 'object' && 'prefix_entrypoint' in service) {
          delete service.prefix_entrypoint;
        }
      }
    }

    let finalYaml = jsyaml.dump(parsed);
    if (hasRemoteHostComment) {
      finalYaml = firstLine + "\n" + finalYaml;
    }
    return finalYaml;
  }

  async preprocessCompose(composeString: string, cmdEnv?: Record<string, string>): Promise<string> {
    const lines = composeString.split(/\r?\n/);
    const firstLine = lines[0]?.trim() || "";
    const hasRemoteHostComment = firstLine.startsWith("#@");

    let parsed: any;
    try {
      parsed = jsyaml.load(composeString);
    } catch (e) {
      return composeString;
    }

    if (parsed && typeof parsed === 'object' && parsed.services && typeof parsed.services === 'object') {
      for (const serviceName of Object.keys(parsed.services)) {
        const service = parsed.services[serviceName];
        if (service && typeof service === 'object' && 'prefix_entrypoint' in service) {
          const prefixVal = service.prefix_entrypoint;
          let prefixCmds: string[] = [];
          if (Array.isArray(prefixVal)) {
            prefixCmds = prefixVal.map(String);
          } else if (typeof prefixVal === 'string') {
            prefixCmds = [prefixVal];
          }

          const image = service.image;
          if (!image || typeof image !== 'string') {
            throw new Error(`Image is required for service '${serviceName}' when using prefix_entrypoint`);
          }

          let inspectOutput = "";
          try {
            if (cmdEnv) {
              inspectOutput = await $`docker inspect ${image} --format='{{json .Config}}'`.env(cmdEnv).text();
            } else {
              inspectOutput = await $`docker inspect ${image} --format='{{json .Config}}'`.text();
            }
          } catch (e) {
            throw new Error(`Failed to inspect image '${image}': ${(e as Error).message || String(e)}`);
          }

          let configObj: any = {};
          try {
            configObj = JSON.parse(inspectOutput.trim()) || {};
          } catch (e) {
            throw new Error(`Failed to parse inspect output for image '${image}': ${(e as Error).message || String(e)}`);
          }

          const imageEntrypoint: string[] | null = configObj.Entrypoint || null;
          const imageCmd: string[] | null = configObj.Cmd || null;

          let downstreamEntrypoint: string[] = [];
          if (service.entrypoint) {
            if (Array.isArray(service.entrypoint)) {
              downstreamEntrypoint = service.entrypoint.map(String);
            } else if (typeof service.entrypoint === 'string') {
              downstreamEntrypoint = [service.entrypoint];
            }
          } else if (imageEntrypoint) {
            downstreamEntrypoint = imageEntrypoint;
          }

          let downstreamCmd: string[] = [];
          if (service.command) {
            if (Array.isArray(service.command)) {
              downstreamCmd = service.command.map(String);
            } else if (typeof service.command === 'string') {
              downstreamCmd = parseCommandString(service.command);
            }
          } else if (!service.entrypoint && imageCmd) {
            downstreamCmd = imageCmd;
          }

          const downstreamExec = [...downstreamEntrypoint, ...downstreamCmd];
          const inlineScript = [...prefixCmds, 'exec "$@"'].join('\n');

          service.entrypoint = ["/bin/sh", "-c", inlineScript, "--"];
          service.command = downstreamExec;
          delete service.prefix_entrypoint;
        }
      }
    }

    let finalYaml = jsyaml.dump(parsed);
    if (hasRemoteHostComment) {
      finalYaml = firstLine + "\n" + finalYaml;
    }
    return finalYaml;
  }
}
