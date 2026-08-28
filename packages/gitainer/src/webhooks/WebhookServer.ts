import { Hono } from "hono";
import type { DockerClient } from "../docker/DockerClient";
import type { GitConsumer } from "../git/GitConsumer";
import { prettyJSON } from "hono/pretty-json";
import { stream } from 'hono/streaming';
import { $, serve, ShellError } from "bun";
import type { GitainerServer } from "../git/GitainerServer";
import { WebhookEventType, webhookTitle } from "./WebhookEventType";
import { parseNamedCommands } from "../docker/DockerClient";

export class WebhookServer {
  readonly app: Hono;
  readonly docker: DockerClient;
  readonly bareRepo: GitConsumer;
  readonly gitainer: GitainerServer;
  readonly namedCommands: Record<string, string>;

  constructor(docker: DockerClient, bareRepo: GitConsumer, gitainer: GitainerServer) {
    this.docker = docker;
    this.bareRepo = bareRepo;
    this.gitainer = gitainer;
    this.namedCommands = process.env.GITAINER_COMMANDS ? parseNamedCommands(process.env.GITAINER_COMMANDS) : {};
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
        const isSelfStack = this.gitainer.isSelfStack(stackName);
        let outputText: string;
        if (isSelfStack) {
          await docker.composeSelfUpdate(stackFile, stackName);
          outputText = "self-update handed off to a detached helper container";
        } else {
          const output = await docker.composeUpdate(stackFile, stackName);
          outputText = output.text();
        }

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
        const errMsg = (e as ShellError)?.stderr?.toString() || (e as Error)?.message || String(e);
        console.error(errMsg);
        return c.json({
          err: errMsg,
        }, 400);
      }
    });

    // bulk stop/start every container labelled gitainer.identifier=<identifier>, regardless of stack
    this.app.post('/api/labels/:identifier/stop', async (c) => {
      const identifier = c.req.param('identifier');

      try {
        const containerIds = await docker.stopContainersByLabel(identifier);

        const res = {
          title: webhookTitle(WebhookEventType.WEBHOOK),
          identifier,
          msg: `Stopped ${containerIds.length} container(s) labelled gitainer.identifier=${identifier}`,
          containerIds,
        };

        if (this.gitainer.postWebhook) {
          await fetch(this.gitainer.postWebhook, {
            body: JSON.stringify(res),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          }).catch(err => console.error(err));
        }

        return c.json(res);
      } catch (e) {
        const errMsg = (e as ShellError)?.stderr?.toString() || (e as Error)?.message || String(e);
        console.error(errMsg);
        return c.json({
          err: errMsg,
        }, 400);
      }
    });

    this.app.post('/api/labels/:identifier/start', async (c) => {
      const identifier = c.req.param('identifier');

      try {
        const containerIds = await docker.startContainersByLabel(identifier);

        const res = {
          title: webhookTitle(WebhookEventType.WEBHOOK),
          identifier,
          msg: `Started ${containerIds.length} container(s) labelled gitainer.identifier=${identifier}`,
          containerIds,
        };

        if (this.gitainer.postWebhook) {
          await fetch(this.gitainer.postWebhook, {
            body: JSON.stringify(res),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          }).catch(err => console.error(err));
        }

        return c.json(res);
      } catch (e) {
        const errMsg = (e as ShellError)?.stderr?.toString() || (e as Error)?.message || String(e);
        console.error(errMsg);
        return c.json({
          err: errMsg,
        }, 400);
      }
    });

    // run `registry garbage-collect` inside a running Docker Registry container
    this.app.post('/api/registry/:containerName/cleanup', async (c) => {
      const containerName = c.req.param('containerName');
      const deleteUntagged = c.req.query('deleteUntagged') === 'true';
      const configPath = c.req.query('configPath');

      try {
        const output = await docker.registryGarbageCollect(containerName, deleteUntagged, configPath);

        const res = {
          title: webhookTitle(WebhookEventType.WEBHOOK),
          containerName,
          msg: `Ran registry garbage-collect on ${containerName}`,
          output,
        };

        if (this.gitainer.postWebhook) {
          await fetch(this.gitainer.postWebhook, {
            body: JSON.stringify(res),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          }).catch(err => console.error(err));
        }

        return c.json(res);
      } catch (e) {
        const errMsg = (e as ShellError)?.stderr?.toString() || (e as Error)?.message || String(e);
        console.error(errMsg);
        return c.json({
          err: errMsg,
        }, 400);
      }
    });

    // run a named `docker exec` command configured via GITAINER_COMMANDS
    this.app.post('/api/commands/:name', async (c) => {
      const name = c.req.param('name');
      const cmd = this.namedCommands[name];

      if (!cmd) {
        return c.json({
          err: `Unknown command "${name}"`,
        }, 404);
      }

      try {
        const output = await docker.runCommand(cmd);

        const res = {
          title: webhookTitle(WebhookEventType.WEBHOOK),
          name,
          msg: `Ran command "${name}"`,
          output,
        };

        if (this.gitainer.postWebhook) {
          await fetch(this.gitainer.postWebhook, {
            body: JSON.stringify(res),
            headers: {
              "Content-Type": "application/json",
            },
            method: "POST",
          }).catch(err => console.error(err));
        }

        return c.json(res);
      } catch (e) {
        const errMsg = (e as ShellError)?.stderr?.toString() || (e as Error)?.message || String(e);
        console.error(errMsg);
        return c.json({
          err: errMsg,
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
