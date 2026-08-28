import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { $ } from "bun";
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

export class DockerClient {
  private composeStringToTmp(composeString: string): string {
    const fileName = `/tmp/gitainer/${randomUUID()}.yaml`;

    // make tmp dir
    if (!existsSync("/tmp/gitainer")) {
      mkdirSync("/tmp/gitainer");
    }

    writeFileSync(fileName, composeString);

    return fileName;
  }

  /**
   * Compose update is -> down(), pull(), up()
   */
  async composeUpdate(composeString: string, stackName: string) {
    const config = extractRemoteHostConfig(composeString);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    const strippedCompose = this.stripPrefixEntrypoint(composeString);
    const strippedFilename = this.composeStringToTmp(strippedCompose);

    if (cmdEnv) {
      await $`docker-compose -f ${strippedFilename} -p ${stackName} down`.env(cmdEnv);
      await $`docker-compose -f ${strippedFilename} pull`.env(cmdEnv);
    } else {
      await $`docker-compose -f ${strippedFilename} -p ${stackName} down`;
      await $`docker-compose -f ${strippedFilename} pull`;
    }

    const hydratedCompose = await this.preprocessCompose(composeString, cmdEnv);
    const finalFilename = this.composeStringToTmp(hydratedCompose);

    if (cmdEnv) {
      return await $`docker-compose -f ${finalFilename} -p ${stackName} up -d --force-recreate`.env(cmdEnv);
    } else {
      return await $`docker-compose -f ${finalFilename} -p ${stackName} up -d --force-recreate`;
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

  // env vars that are process/runtime bookkeeping rather than gitainer config or compose
  // variable-interpolation values - forwarding them into the sibling would be pointless at
  // best (nobody names a compose variable "PATH") and could shadow the sibling's own values
  // at worst, so they're excluded from composeSelfUpdate's environment forwarding below.
  private static readonly SELF_UPDATE_ENV_FORWARD_DENYLIST = new Set([
    "PATH", "HOME", "HOSTNAME", "PWD", "OLDPWD", "SHLVL", "_", "STACK_NAME",
  ]);

  /**
   * Self-update can't run down()/up() in-process like composeUpdate() does: if the target
   * stack is gitainer's own container, stopping it to recreate would kill the very process
   * running this sequence before it finishes. pull() is safe to run in-process though (it
   * never touches the running container), so only the recreate is handed off to a detached
   * sibling container (launched via the docker socket, so it survives gitainer's own container
   * being replaced) - if pull() fails here, the running gitainer container is never touched.
   */
  async composeSelfUpdate(composeString: string, stackName: string): Promise<void> {
    const config = extractRemoteHostConfig(composeString);
    if (config) {
      throw new Error(`Self-update stack "${stackName}" cannot use a remote host (#@) comment; gitainer can only self-update the host it is running on`);
    }

    const strippedCompose = this.stripPrefixEntrypoint(composeString);
    const strippedFilename = this.composeStringToTmp(strippedCompose);
    await $`docker-compose -f ${strippedFilename} pull`;

    const hydratedCompose = await this.preprocessCompose(composeString);
    const hydratedFilename = this.composeStringToTmp(hydratedCompose);
    const helperImage = process.env.GITAINER_SELF_UPDATE_HELPER_IMAGE || "docker:27.1.2-alpine3.20";
    const containerName = this.selfUpdateContainerName(stackName);

    // Forward gitainer's own environment into the sibling (bare `-e KEY` makes docker pull the
    // value from the invoking process, i.e. gitainer's own process.env) so compose variable
    // interpolation (see README "Variables") resolves the same way here as it does in-process
    // for pull() above and for every other stack's composeUpdate().
    const envForwarding = Object.keys(process.env)
      .filter(key => !DockerClient.SELF_UPDATE_ENV_FORWARD_DENYLIST.has(key))
      .flatMap(key => ["-e", key]);

    // The hydrated compose is handed to the sibling as a real file rather than an env var
    // (avoids the ~128KB env var size limit), via `docker cp` instead of a bind mount: `cp`
    // goes over the docker socket itself, copying from wherever gitainer's own tmp file
    // actually lives into the container's filesystem, so it needs no host-path translation or
    // self-container-identification - it behaves the same whether gitainer runs bare or inside
    // a container. `create` (not `run`) so the file can be copied in before the entrypoint
    // executes; `--rm` still auto-removes the container once it exits, same as before.
    await $`docker create --rm --name ${containerName} -v /var/run/docker.sock:/var/run/docker.sock ${envForwarding} -e STACK_NAME="${stackName}" ${helperImage} sh -c "${selfUpdateScript}"`;
    await $`docker cp ${hydratedFilename} ${containerName}:/self-update.yaml`;
    await $`docker start ${containerName}`;
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

  async composeDown(composeString: string, stackName: string) {
    const strippedCompose = this.stripPrefixEntrypoint(composeString);
    const filename = this.composeStringToTmp(strippedCompose);
    const config = extractRemoteHostConfig(strippedCompose);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    if (cmdEnv) {
      return await $`docker-compose -f ${filename} -p ${stackName} down`.env(cmdEnv);
    } else {
      return await $`docker-compose -f ${filename} -p ${stackName} down`;
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
