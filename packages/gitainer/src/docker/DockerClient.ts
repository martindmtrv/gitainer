import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { $ } from "bun";

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
    const filename = this.composeStringToTmp(composeString);
    const config = extractRemoteHostConfig(composeString);
    const cmdEnv = config ? {
      ...process.env,
      DOCKER_HOST: config.dockerHost,
      ...(config.composeProjectDir ? { COMPOSE_PROJECT_DIR: config.composeProjectDir } : {})
    } : undefined;

    if (cmdEnv) {
      await $`docker-compose -f ${filename} -p ${stackName} down`.env(cmdEnv);
      await $`docker-compose -f ${filename} pull`.env(cmdEnv);
      return await $`docker-compose -f ${filename} -p ${stackName} up -d --force-recreate`.env(cmdEnv);
    } else {
      await $`docker-compose -f ${filename} -p ${stackName} down`;
      await $`docker-compose -f ${filename} pull`;
      return await $`docker-compose -f ${filename} -p ${stackName} up -d --force-recreate`;
    }
  }

  async composeDown(composeString: string, stackName: string) {
    const filename = this.composeStringToTmp(composeString);
    const config = extractRemoteHostConfig(composeString);
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
}
