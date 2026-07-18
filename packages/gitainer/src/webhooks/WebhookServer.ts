import { Hono } from "hono";
import type { DockerClient } from "../docker/DockerClient";
import type { GitConsumer } from "../git/GitConsumer";
import { prettyJSON } from "hono/pretty-json";
import { stream } from 'hono/streaming';
import { $, serve, ShellError } from "bun";
import type { GitainerServer } from "../git/GitainerServer";
import { WebhookEventType, webhookTitle } from "./WebhookEventType";

export class WebhookServer {
  readonly app: Hono;
  readonly docker: DockerClient;
  readonly bareRepo: GitConsumer;
  readonly gitainer: GitainerServer;

  constructor(docker: DockerClient, bareRepo: GitConsumer, gitainer: GitainerServer) {
    this.docker = docker;
    this.bareRepo = bareRepo;
    this.gitainer = gitainer;
    this.app = new Hono();

    this.app.use(prettyJSON());

    this.app.use('/api/*', async (c, next) => {
      const apiKey = process.env.GITAINER_API_KEY || process.env.WEBHOOK_API_KEY;
      if (apiKey) {
        const authHeader = c.req.header('Authorization');
        const customHeader = c.req.header('X-API-Key') || c.req.header('x-api-key');

        let token: string | undefined;
        if (authHeader) {
          if (authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
          } else {
            token = authHeader;
          }
        } else if (customHeader) {
          token = customHeader;
        }

        if (!token || token !== apiKey) {
          return c.json({
            err: "Unauthorized",
          }, 401);
        }
      }
      await next();
    });

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
        const outputText = output.text();
        const res = {
          title: webhookTitle(WebhookEventType.WEBHOOK),
          stackName,
          msg: `Successfully updated stack ${stackName}: ${outputText}`,
          output: outputText,
        };

        if (this.gitainer.postWebhook) {
          console.log(`== Sending POST to ${this.gitainer.postWebhook} ==`);
          await fetch(this.gitainer.postWebhook, {
            body: JSON.stringify(res),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          }).catch(err => console.error(err));
          console.log("== Sent webhook notification ==");
        }

        return c.json(res);
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
      idleTimeout: 90,
      fetch: this.app.fetch,
      port,
    });
  }
}
