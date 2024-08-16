import { Hono } from "hono";
import type { DockerClient } from "../docker/DockerClient";
import type { GitConsumer } from "../git/GitConsumer";
import { prettyJSON } from "hono/pretty-json";
import { serve, ShellError } from "bun";

export class WebhookServer {
  readonly app: Hono;
  readonly docker: DockerClient;
  readonly bareRepo: GitConsumer;

  constructor(docker: DockerClient, bareRepo: GitConsumer) {
    this.docker = docker;
    this.bareRepo = bareRepo;
    this.app = new Hono();

    this.app.use(prettyJSON());

    // view the contents
    this.app.get('/api/stacks/:stackName', async (c) => {
      const stackName = c.req.param('stackName');
      const stackFile = await this.bareRepo.getFileContents(`stacks/${stackName}/docker-compose.yaml`);

      if (!stackFile) {
        return c.json({
          err: "Unknown stack",
        }, 404);
      }

      return c.text(stackFile);
    });

    // force a stack reload and pull image
    this.app.post('/api/stacks/:stackName', async (c) => {
      const stackName = c.req.param('stackName');
      const stackFile = await this.bareRepo.getFileContents(`stacks/${stackName}/docker-compose.yaml`);

      if (!stackFile) {
        return c.json({
          err: "Unknown stack",
        }, 404);
      }

      console.log(`== stack update from POST webhook -> ${stackName} ==`);

      try {
        const output = await docker.composeUpdate(stackFile, stackName);
        return c.json({
          stackName,
          msg: `Successfully updated stack ${stackName}`,
          output: output.text(),
        });
      } catch (e) {
        console.error((e as ShellError).stderr.toString());
        return c.json({
          err: (e as ShellError)?.stderr?.toString(),
        }, 400);
      }
    });
    
    this.app.get('*', (c) => {
      return fetch(process.env.GITLIST + c.req.path);
    });
  }

  listen(port: number) {
    return serve({
      fetch: this.app.fetch,
      port,
    });
  }
}
