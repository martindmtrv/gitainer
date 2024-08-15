import { randomUUID } from "crypto";
import Dockerode from "dockerode";
import Compose from "dockerode-compose";
import { existsSync, mkdirSync, writeFileSync } from "fs";

export class DockerClient {
  readonly docker: Dockerode;

  constructor() {
    this.docker = new Dockerode({
      socketPath: process.env.DOCKER_SOCK,
    });
  }

  getDockerode(): Dockerode {
    return this.docker;
  }

  private composeStringToObj(composeString: string, stackName: string): Compose {
    const fileName = `/tmp/gitainer/${randomUUID()}.yaml`;

    // make tmp dir
    if (!existsSync("/tmp/gitainer")) {
      mkdirSync("/tmp/gitainer");
    }

    writeFileSync(fileName, composeString);
    return new Compose(this.docker, fileName, stackName);
  }

  /**
   * Compose update is -> down(), pull(), up()
   */
  async composeUpdate(composeString: string, stackName: string) {
    const compose = this.composeStringToObj(composeString, stackName);

    await compose.down();
    await compose.pull(undefined, { streams: true, verbose: true });
    return compose.up({ verbose: true });
  }

  async composeDown(composeString: string, stackName: string) {
    return this.composeStringToObj(composeString, stackName).down();
  }
}
