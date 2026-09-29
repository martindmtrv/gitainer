import { Hono, type Context } from "hono";
import type { DockerClient } from "../docker/DockerClient";
import type { GitConsumer } from "../git/GitConsumer";
import { stream } from 'hono/streaming';
import { $, serve, ShellError } from "bun";
import type { GitainerServer } from "../git/GitainerServer";
import { WebhookEventType, webhookTitle } from "./WebhookEventType";
import { parseNamedCommands } from "../docker/DockerClient";

// a stack update that runs longer than this switches to a streamed response with whitespace
// keepalives, so the server's idleTimeout (90s) doesn't drop the connection mid-deploy
const KEEPALIVE_INTERVAL_MS = 30_000;

type Env = { Variables: { keepalive?: boolean } };

type UpdateResult = { status: 200 | 400, body: Record<string, unknown> };

function isPretty(c: Context) {
  return c.req.query('pretty') !== undefined;
}

export class WebhookServer {
  readonly app: Hono<Env>;
  readonly docker: DockerClient;
  readonly bareRepo: GitConsumer;
  readonly gitainer: GitainerServer;
  readonly namedCommands: Record<string, string>;

  readonly keepaliveIntervalMs: number;

  constructor(docker: DockerClient, bareRepo: GitConsumer, gitainer: GitainerServer, keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS) {
    this.docker = docker;
    this.bareRepo = bareRepo;
    this.gitainer = gitainer;
    this.namedCommands = process.env.GITAINER_COMMANDS ? parseNamedCommands(process.env.GITAINER_COMMANDS) : {};
    this.keepaliveIntervalMs = keepaliveIntervalMs;
    this.app = new Hono<Env>();

    // same as hono's prettyJSON(), which would read a keepalive stream to the end before
    // sending any of it, so keepalive responses skip it and format their own JSON
    this.app.use(async (c, next) => {
      await next();
      if (isPretty(c) && !c.get('keepalive') && c.res.headers.get('Content-Type')?.startsWith('application/json')) {
        const obj = await c.res.json();
        c.res = new Response(JSON.stringify(obj, null, 2), c.res);
      }
    });

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

      const isSelfStack = this.gitainer.isSelfStack(stackName);

      if (!isSelfStack) {
        const update = this.updateStack(stackFile, stackName);

        // undefined if the update is still running after one keepalive interval
        const result = await new Promise<UpdateResult | undefined>(resolve => {
          const timer = setTimeout(() => resolve(undefined), this.keepaliveIntervalMs);
          update.then(r => {
            clearTimeout(timer);
            resolve(r);
          });
        });

        if (result) {
          return c.json(result.body, result.status);
        }

        // Still running: commit to a 200 now and write whitespace (valid before a JSON value)
        // until the update finishes, then the result. A failure is only reported in `err`.
        c.set('keepalive', true);
        c.header("Content-Type", "application/json");
        return stream(c, async (streamApi) => {
          const keepalive = setInterval(() => streamApi.write("\n"), this.keepaliveIntervalMs);
          try {
            await streamApi.write("\n");
            const { body } = await update;
            await streamApi.write(isPretty(c) ? JSON.stringify(body, null, 2) : JSON.stringify(body));
          } finally {
            clearInterval(keepalive);
          }
        });
      }

      // Self-stack: the recreate can replace gitainer's own container, which kills this
      // process. If that happens before this webhook's HTTP response has been flushed to the
      // client, the caller sees a broken/aborted request even though the update succeeded -
      // the same race fixed for the git-push path in GitainerServer. So prepare (validate/
      // pull/stage) now, but only trigger the actual recreate once the response body has been
      // written out to the client's socket.
      try {
        const trigger = await docker.prepareSelfUpdate(stackFile, stackName);
        const outputText = "self-update handed off to a detached helper container";

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

        c.header("Content-Type", "application/json");
        return stream(c, async (streamApi) => {
          await streamApi.write(JSON.stringify(res));
          await streamApi.close();
          try {
            await trigger();
          } catch (e) {
            console.error("Self-update trigger failed:", e);
          }
        });
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

  private async updateStack(stackFile: string, stackName: string): Promise<UpdateResult> {
    try {
      // pull images before tearing the stack down, so a forced reload has no
      // pull-induced downtime between down() and up() - mirrors the git-push path
      // in GitainerServer.
      await this.docker.composePull(stackFile, stackName);
      await this.docker.composeDown(stackFile, stackName);
      const output = await this.docker.composeUpdate(stackFile, stackName, false);
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

      return { status: 200, body: res };
    } catch (e) {
      const errMsg = (e as ShellError)?.stderr?.toString() || (e as Error)?.message || String(e);
      console.error(errMsg);
      return { status: 400, body: { err: errMsg } };
    }
  }

  listen(port: number) {
    return serve({
      idleTimeout: 90,
      fetch: this.app.fetch,
      port,
    });
  }
}
