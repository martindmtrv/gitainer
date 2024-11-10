import { Hono } from "hono";
import type { DockerClient } from "../docker/DockerClient";
import type { GitConsumer } from "../git/GitConsumer";
import { prettyJSON } from "hono/pretty-json";
import { stream } from 'hono/streaming';
import { $, serve, ShellError } from "bun";

export class WebhookServer {
  readonly app: Hono;
  readonly docker: DockerClient;
  readonly bareRepo: GitConsumer;

  constructor(docker: DockerClient, bareRepo: GitConsumer) {
    this.docker = docker;
    this.bareRepo = bareRepo;
    this.app = new Hono();

    this.app.use(prettyJSON());

    // stream docker command api
    if (process.env.ENABLE_RAW_API) {
      this.app.get('/api/raw/docker/*', async (c) => {
        const cmd = c.req.path.slice('/api/raw/docker'.length + 1).split("/");

        const proc = Bun.spawn(['docker', ...cmd]);

        return stream(c, async (stream) => {
          stream.onAbort(async () => {
            await proc.kill();
          });
      
          await stream.pipe(proc.stdout);       
        });
      });
    }

    // view the contents
    this.app.get('/api/stacks/:stackName', async (c) => {
      const stackName = c.req.param('stackName');

      const stackFile = await this.bareRepo.getStack(stackName);

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
      const stackFile = await this.bareRepo.getStack(stackName);

      if (!stackFile) {
        return c.json({
          err: `Unknown stack ${stackName}`,
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

    this.app.all('/api/*', (c) => {
      return c.json({
        err: "Unknown API",
      }, 404);
    })
  }

  listen(port: number) {
    return serve({
      fetch: this.app.fetch,
      port,
    });
  }
}
