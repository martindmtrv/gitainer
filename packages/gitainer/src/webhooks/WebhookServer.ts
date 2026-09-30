import { Hono, type Context } from "hono";
import type { DockerClient } from "../docker/DockerClient";
import type { GitConsumer } from "../git/GitConsumer";
import { stream } from 'hono/streaming';
import { $, serve, ShellError } from "bun";
import type { GitainerServer } from "../git/GitainerServer";
import { WebhookEventType, webhookTitle } from "./WebhookEventType";
import { isStackDisabled, parseNamedCommands } from "../docker/DockerClient";

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

      const disabledErr = this.disabledError(stackFile, stackName);
      if (disabledErr) {
        return c.json({
          err: disabledErr,
        }, 400);
      }

      console.log(`== stack update from POST webhook -> ${stackName} ==`);

      const isSelfStack = this.gitainer.isSelfStack(stackName);

      if (!isSelfStack) {
        return this.respondWithKeepalive(c, this.runStackAction(stackName, "updated", async () => {
          // pull images before tearing the stack down, so a forced reload has no
          // pull-induced downtime between down() and up() - mirrors the git-push path
          // in GitainerServer.
          await this.docker.composePull(stackFile, stackName);
          await this.docker.composeDown(stackFile, stackName);
          return await this.docker.composeUpdate(stackFile, stackName, false);
        }));
      }

      // Self-stack: the recreate can replace gitainer's own container, which kills this
      // process. If that happens before this webhook's HTTP response has been flushed to the
      // client, the caller sees a broken/aborted request even though the update succeeded -
      // the same race fixed for the git-push path in GitainerServer. So prepare (validate/
      // pull/stage) now, but only trigger the actual recreate once the response body has been
      // written out to the client's socket.
      try {
        const trigger = await docker.prepareSelfUpdate(stackFile, stackName, true, this.gitainer.selfUpdateNotify(WebhookEventType.WEBHOOK));
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

    // down / up / restart a stack without pulling its images. Gitainer's own stack is refused:
    // downing it would kill the process serving this request, with nothing left to bring it back
    const stackActions: Record<string, { verb: string, run: (stackFile: string, stackName: string) => Promise<{ text(): string }> }> = {
      // runs the stack's x-shutdown-hook first, like a down from a git push
      down: {
        verb: "downed",
        run: (stackFile, stackName) => this.docker.composeDown(stackFile, stackName),
      },
      up: {
        verb: "started",
        run: (stackFile, stackName) => this.docker.composeUp(stackFile, stackName),
      },
      // a forced reload minus the pull: down (with the shutdown hook), then up --force-recreate
      restart: {
        verb: "restarted",
        run: async (stackFile, stackName) => {
          await this.docker.composeDown(stackFile, stackName);
          return await this.docker.composeUpdate(stackFile, stackName, false);
        },
      },
    };

    for (const [action, { verb, run }] of Object.entries(stackActions)) {
      this.app.post(`/api/stacks/:stackName/${action}`, async (c) => {
        const stackName = c.req.param('stackName');
        const stackFile = await this.bareRepo.getStack(stackName);

        if (!stackFile) {
          return c.json({
            err: `Unknown stack ${stackName}`,
          }, 404);
        }

        if (this.gitainer.isSelfStack(stackName)) {
          return c.json({
            err: `Can't ${action} gitainer's own stack ${stackName}; use POST /api/stacks/${stackName} to update it`,
          }, 400);
        }

        // a disabled stack can still be downed, but not brought up
        const disabledErr = action === "down" ? undefined : this.disabledError(stackFile, stackName);
        if (disabledErr) {
          return c.json({
            err: disabledErr,
          }, 400);
        }

        console.log(`== stack ${action} from POST webhook -> ${stackName} ==`);

        return this.respondWithKeepalive(c, this.runStackAction(stackName, verb, () => run(stackFile, stackName)));
      });
    }

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

  // why the stack can't be brought up, if it's disabled with x-gitainer-disabled
  private disabledError(stackFile: string, stackName: string): string | undefined {
    try {
      return isStackDisabled(stackFile)
        ? `Stack ${stackName} is disabled with x-gitainer-disabled: true; remove the flag in git to deploy it`
        : undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /**
   * Responds with the result once `run` settles. If it's still running after one keepalive
   * interval, commits to a 200 and writes whitespace (valid before a JSON value) every interval
   * until it finishes, then the result, so the server's idleTimeout doesn't drop the connection.
   * A failure after that point is only reported in `err`.
   */
  private async respondWithKeepalive(c: Context<Env>, run: Promise<UpdateResult>) {
    // undefined if still running after one keepalive interval
    const result = await new Promise<UpdateResult | undefined>(resolve => {
      const timer = setTimeout(() => resolve(undefined), this.keepaliveIntervalMs);
      run.then(r => {
        clearTimeout(timer);
        resolve(r);
      });
    });

    if (result) {
      return c.json(result.body, result.status);
    }

    c.set('keepalive', true);
    c.header("Content-Type", "application/json");
    return stream(c, async (streamApi) => {
      const keepalive = setInterval(() => streamApi.write("\n"), this.keepaliveIntervalMs);
      try {
        await streamApi.write("\n");
        const { body } = await run;
        await streamApi.write(isPretty(c) ? JSON.stringify(body, null, 2) : JSON.stringify(body));
      } finally {
        clearInterval(keepalive);
      }
    });
  }

  /**
   * Runs a compose action on a stack and builds its result, notifying POST_WEBHOOK on success.
   * `verb` completes "Successfully <verb> stack <name>".
   */
  private async runStackAction(stackName: string, verb: string, action: () => Promise<{ text(): string }>): Promise<UpdateResult> {
    try {
      const output = await action();
      const outputText = output.text();

      const res = {
        title: webhookTitle(WebhookEventType.WEBHOOK),
        stackName,
        msg: `Successfully ${verb} stack ${stackName}: ${outputText}`,
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
