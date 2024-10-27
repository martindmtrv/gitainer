import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { $ } from "bun";

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

    await $`docker-compose -f ${filename} down --remove-orphans`;
    await $`docker-compose -f ${filename} pull`;
    return await $`docker-compose -f ${filename} -p ${stackName} up -d`;
  }

  async composeDown(composeString: string, stackName: string) {
    const filename = this.composeStringToTmp(composeString);
    return await $`docker-compose -f ${filename} down --remove-orphans`;
  }
}
