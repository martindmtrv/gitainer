import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { $, YAML } from "bun";

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
      parsed = YAML.parse(composeString);
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

    let finalYaml = YAML.stringify(parsed);
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
      parsed = YAML.parse(composeString);
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

    let finalYaml = YAML.stringify(parsed);
    if (hasRemoteHostComment) {
      finalYaml = firstLine + "\n" + finalYaml;
    }
    return finalYaml;
  }
}
