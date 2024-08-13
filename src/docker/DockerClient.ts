import { randomUUID } from "crypto";
import Dockerode from "dockerode";
import DockerodeCompose from "dockerode-compose";
import { existsSync, mkdirSync, writeFileSync } from "fs";

export class DockerClient {
  readonly docker: Dockerode;

  constructor() {
    this.docker = new Dockerode({
      socketPath: '/var/run/docker.sock',
    });
  }

  getDockerode(): Dockerode {
    return this.docker;
  }

  /**
   * Compose update is -> down(), pull(), up()
   */
  async composeUpdate(composeFileString: string, stackName: string) {
    const fileName = `/tmp/gitainer/${randomUUID()}.yaml`;

    // make tmp dir
    if (!existsSync("/tmp/gitainer")) {
      mkdirSync("/tmp/gitainer");
    }

    writeFileSync(fileName, composeFileString);

    const compose = new DockerodeCompose(this.docker, fileName, stackName);

    await compose.down();
    await compose.pull(undefined, { streams: true, verbose: true });
    return compose.up({ verbose: true });
  }
}
