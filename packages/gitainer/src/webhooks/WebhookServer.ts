import { Hono, type Context } from "hono";
import type { DockerClient } from "../docker/DockerClient";
import type { GitConsumer } from "../git/GitConsumer";
import { stream } from 'hono/streaming';
import { $, serve, ShellError } from "bun";
import type { GitainerServer } from "../git/GitainerServer";
import { WebhookEventType, webhookTitle } from "./WebhookEventType";
import { composeVariableDetails, extractRemoteHostConfig, isStackDisabled, parseNamedCommands, type ComposeVariable, type StackContainer } from "../docker/DockerClient";
import { infisicalKeys } from "../infisical/InfisicalProvider";
import type { DeployRecord } from "../store/EventStore";
import { describeSettings, HIDDEN_ENV_KEYS } from "../server/settings";
import { recordDeployedEnv, staleVariables, type EnvFingerprint } from "../server/stackEnv";

// a stack update that runs longer than this switches to a streamed response with whitespace
// keepalives, so the server's idleTimeout (90s) doesn't drop the connection mid-deploy
const KEEPALIVE_INTERVAL_MS = 30_000;

type Env = { Variables: { keepalive?: boolean } };

type UpdateResult = { status: 200 | 400, body: Record<string, unknown> };

type StackInfo = {
  name: string,
  self: boolean,
  // the docker host from a `#@` comment
  remoteHost?: string,
  disabled: boolean,
  // why the stack can't be read (a missing fragment, a bad #@ comment or x-gitainer-disabled)
  err?: string,
  // undefined when the status couldn't be loaded, see statusErr
  containers?: StackContainer[],
  statusErr?: string,
  // the action in flight on the stack
  busy?: string,
  // the variables whose value changed since the stack was last deployed: if it's running, it's
  // running with their old values until it's updated, restarted or upped
  staleEnv?: string[],
};

const UI_DIR = new URL("../ui/", import.meta.url);
const UI_FILES: Record<string, string> = {
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "icon.svg": "image/svg+xml",
};

// the manager UI sends `X-Gitainer-Source: ui`, so its actions are told apart from other API
// clients'. It's a label for notifications and the history, not a permission
function apiEventType(c: Context): WebhookEventType {
  return c.req.header('X-Gitainer-Source')?.toLowerCase() === 'ui' ? WebhookEventType.UI : WebhookEventType.WEBHOOK;
}

// the paths the UI has a page for, see route() in ui/app.js
const UI_PAGES = /^\/(env|history|info|stacks\/[^/]+)?\/?$/;

function configuredApiKey(): string | undefined {
  return process.env.GITAINER_API_KEY || process.env.WEBHOOK_API_KEY;
}

// compose colours its progress output when it thinks it can
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

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

  // the action running on each stack, so a second one on the same stack is refused with a 409
  private readonly inFlight = new Map<string, string>();
  // each stack's variables at `commit`: reading them is a `docker compose config` per stack
  private variablesCache: { commit?: string, byStack: Map<string, Promise<ComposeVariable[]>> } = { byStack: new Map() };

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
      const apiKey = configuredApiKey();
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

    // the manager UI: static files that call the API below
    this.app.get('/ui/:file', (c) => this.serveUiFile(c, c.req.param('file')));

    // what the UI needs to know about this gitainer: where to clone the repo from
    this.app.get('/api/info', (c) => {
      return c.json({
        repoName: this.gitainer.repoName,
        branch: this.gitainer.gitBranch,
        // only when it's configured: otherwise the UI derives it from the address it's opened at
        ...(process.env.GITAINER_CLONE_URL ? { cloneUrl: process.env.GITAINER_CLONE_URL } : {}),
      });
    });

    // gitainer's own settings, with a description of each. Values that can hold credentials
    // are left out
    this.app.get('/api/settings', (c) => {
      return c.json(describeSettings());
    });

    // every stack with its container states. A remote host that doesn't answer holds the response
    // up until its lookup times out, so ?status=local leaves the remote stacks' states out, to
    // be loaded one by one from /api/stacks/:stackName/status
    this.app.get('/api/stacks', async (c) => {
      const localOnly = c.req.query('status') === 'local';
      const stackNames = (await this.bareRepo.getAllStackNames()).sort();
      const deployedEnvs = await this.deployedEnvs();
      const stacks = await Promise.all(stackNames.map(stackName => this.describeStack(stackName, deployedEnvs)));

      // one `docker ps` per docker host rather than per stack
      const hosts = new Set(stacks.filter(stack => !stack.err && !(localOnly && stack.remoteHost)).map(stack => stack.remoteHost));
      await Promise.all([...hosts].map(async (host) => {
        const onHost = stacks.filter(stack => !stack.err && stack.remoteHost === host);
        try {
          const containers = await this.docker.listStackContainers(host);
          onHost.forEach(stack => stack.containers = containers.get(stack.name) ?? []);
        } catch (e) {
          onHost.forEach(stack => stack.statusErr = (e as Error).message);
        }
      }));

      return c.json(stacks);
    });

    this.app.get('/api/stacks/:stackName/status', async (c) => {
      const stackName = c.req.param('stackName');
      if (!await this.bareRepo.getStack(stackName).catch(() => true)) {
        return c.json({
          err: "Unknown stack",
        }, 404);
      }

      const stack = await this.describeStack(stackName, await this.deployedEnvs());
      if (!stack.err) {
        try {
          stack.containers = (await this.docker.listStackContainers(stack.remoteHost, stackName)).get(stackName) ?? [];
        } catch (e) {
          stack.statusErr = (e as Error).message;
        }
      }
      return c.json(stack);
    });

    // the compose file with env vars interpolated, i.e. with the stack's secrets in it
    this.app.get('/api/stacks/:stackName/resolved', async (c) => {
      const stackName = c.req.param('stackName');
      const stackFile = await this.bareRepo.getStack(stackName);

      if (!stackFile) {
        return c.json({
          err: "Unknown stack",
        }, 404);
      }

      const noKeyErr = this.secretsError();
      if (noKeyErr) {
        return c.json({
          err: noKeyErr,
        }, 403);
      }

      try {
        return c.text(await this.docker.composeResolved(stackFile, stackName));
      } catch (e) {
        return c.json({
          err: (e as Error).message,
        }, 400);
      }
    });

    // the variables a stack reads and whether each is set, without their values
    this.app.get('/api/stacks/:stackName/variables', async (c) => {
      const stackName = c.req.param('stackName');

      if (!await this.bareRepo.getStack(stackName)) {
        return c.json({
          err: "Unknown stack",
        }, 404);
      }

      try {
        const variables = await this.stackVariables(stackName);
        return c.json(variables.map(variable => ({ ...variable, set: process.env[variable.name] !== undefined })));
      } catch (e) {
        return c.json({
          err: (e as Error).message,
        }, 400);
      }
    });

    // the keys of gitainer's env, without their values
    this.app.get('/api/env', async (c) => {
      const stackNames = (await this.bareRepo.getAllStackNames()).sort();
      const usedBy = new Map<string, { stacks: string[], hasDefault: boolean, required: boolean }>();
      const stackErrors: Record<string, string> = {};

      await Promise.all(stackNames.map(async (stackName) => {
        try {
          for (const variable of await this.stackVariables(stackName)) {
            const usage = usedBy.get(variable.name) ?? { stacks: [], hasDefault: true, required: false };
            usage.stacks.push(stackName);
            usage.hasDefault &&= variable.hasDefault;
            usage.required ||= variable.required;
            usedBy.set(variable.name, usage);
          }
        } catch (e) {
          stackErrors[stackName] = (e as Error).message;
        }
      }));
      usedBy.forEach(usage => usage.stacks.sort());

      // per key, the stacks that were deployed with another value of it
      const staleStacks = new Map<string, string[]>();
      for (const [stackName, deployedEnv] of await this.deployedEnvs()) {
        const read = [...usedBy].filter(([, usage]) => usage.stacks.includes(stackName)).map(([key]) => key);
        for (const key of staleVariables(deployedEnv, read)) {
          staleStacks.set(key, [...(staleStacks.get(key) ?? []), stackName].sort());
        }
      }

      const fromInfisical = new Set(infisicalKeys());

      return c.json({
        env: Object.keys(process.env).filter(key => process.env[key] !== undefined).sort().map(key => ({
          key,
          source: fromInfisical.has(key) ? "infisical" : "container",
          stacks: usedBy.get(key)?.stacks ?? [],
          staleStacks: staleStacks.get(key) ?? [],
          revealable: !HIDDEN_ENV_KEYS.has(key),
        })),
        // variables stacks read that aren't set. hasDefault: every stack reading it has a default
        unset: [...usedBy].filter(([key]) => process.env[key] === undefined).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, usage]) => ({ key, ...usage })),
        ...(Object.keys(stackErrors).length ? { stackErrors } : {}),
      });
    });

    // one value, so a page listing the env never holds every secret
    this.app.get('/api/env/:key', async (c) => {
      const key = c.req.param('key');

      const noKeyErr = this.secretsError();
      if (noKeyErr) {
        return c.json({
          err: noKeyErr,
        }, 403);
      }

      if (HIDDEN_ENV_KEYS.has(key)) {
        return c.json({
          err: `${key} is never revealed`,
        }, 403);
      }

      const value = process.env[key];
      if (value === undefined) {
        return c.json({
          err: `${key} is not set`,
        }, 404);
      }

      return c.json({ key, value });
    });

    // the stored history: every webhook event with the deploys it made, newest first
    this.app.get('/api/events', async (c) => {
      return c.json(await this.gitainer.store?.listEvents(Number(c.req.query('limit'))) ?? []);
    });

    // the stored deploys, newest first: of every stack, or of ?stack= only
    this.app.get('/api/deploys', async (c) => {
      return c.json(await this.gitainer.store?.listDeploys(c.req.query('stack'), Number(c.req.query('limit'))) ?? []);
    });

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

      const disabledErr = await this.disabledError(stackFile, stackName);
      if (disabledErr) {
        return c.json({
          err: disabledErr,
        }, 400);
      }

      const busyErr = this.busyError(stackName);
      if (busyErr) {
        return c.json({
          err: busyErr,
        }, 409);
      }

      console.log(`== stack update from POST webhook -> ${stackName} ==`);

      const event = apiEventType(c);
      const isSelfStack = this.gitainer.isSelfStack(stackName);

      if (!isSelfStack) {
        return this.respondWithKeepalive(c, this.runStackAction(event, stackName, "update", "updated", stackFile, async () => {
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
      const deploy = this.lockStack(stackName, "update");
      try {
        const trigger = await docker.prepareSelfUpdate(stackFile, stackName, true, this.gitainer.selfUpdateNotify(event));
        const outputText = "self-update handed off to a detached helper container";

        const res = {
          title: webhookTitle(event),
          stackName,
          msg: `Successfully updated stack ${stackName}: ${outputText}`,
          output: outputText,
        };

        // stored before the recreate is triggered: it can replace this very process. Its
        // outcome is only reported to POST_WEBHOOK, by the helper container
        await this.record(res, [deploy(true, outputText)], event);
        await recordDeployedEnv(this.gitainer.store, stackName, stackFile);

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
          } finally {
            this.inFlight.delete(stackName);
          }
        });
      } catch (e) {
        const errMsg = (e as ShellError)?.stderr?.toString() || (e as Error)?.message || String(e);
        console.error(errMsg);
        this.inFlight.delete(stackName);
        await this.record({ stackName, err: errMsg }, [deploy(false, errMsg)], event);
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
        const disabledErr = action === "down" ? undefined : await this.disabledError(stackFile, stackName);
        if (disabledErr) {
          return c.json({
            err: disabledErr,
          }, 400);
        }

        const busyErr = this.busyError(stackName);
        if (busyErr) {
          return c.json({
            err: busyErr,
          }, 409);
        }

        console.log(`== stack ${action} from POST webhook -> ${stackName} ==`);

        return this.respondWithKeepalive(c, this.runStackAction(apiEventType(c), stackName, action, verb, stackFile, () => run(stackFile, stackName)));
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

        await this.record(res);

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
        await this.record({ identifier, err: errMsg });
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

        await this.record(res);

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
        await this.record({ identifier, err: errMsg });
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

        await this.record(res);

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
        await this.record({ containerName, err: errMsg });
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

        await this.record(res);

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
        await this.record({ name, err: errMsg });
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

    // Every other path is a page of the UI, which does its own routing: a reload or a shared
    // link to /stacks/mystack has to get the page too. A path that isn't one of its pages gets
    // it with a 404, and the UI shows its "not found" page
    this.app.get('*', (c) => this.serveUiFile(c, "index.html", UI_PAGES.test(c.req.path) ? 200 : 404));
  }

  private async serveUiFile(c: Context<Env>, name: string, status: 200 | 404 = 200) {
    const contentType = UI_FILES[name];
    if (!contentType) {
      return c.notFound();
    }
    // no-cache: the files aren't fingerprinted, so a new version has to be picked up on reload
    return c.body(await Bun.file(new URL(name, UI_DIR)).text(), status, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });
  }

  // a stack as GET /api/stacks lists it, minus its container states
  // the env each stack was last deployed with. Empty without a store, or if it can't be read
  private async deployedEnvs(): Promise<Map<string, EnvFingerprint>> {
    try {
      return await this.gitainer.store?.listStackEnvs() ?? new Map();
    } catch (e) {
      console.error("Could not read the envs the stacks were deployed with:", e);
      return new Map();
    }
  }

  private async describeStack(stackName: string, deployedEnvs: Map<string, EnvFingerprint>): Promise<StackInfo> {
    const stack: StackInfo = {
      name: stackName,
      self: this.gitainer.isSelfStack(stackName),
      disabled: false,
      ...(this.inFlight.has(stackName) ? { busy: this.inFlight.get(stackName) } : {}),
    };

    try {
      const stackFile = await this.bareRepo.getStack(stackName) as string;
      const remoteHost = extractRemoteHostConfig(stackFile)?.dockerHost;
      if (remoteHost) {
        stack.remoteHost = remoteHost;
      }
      stack.disabled = await isStackDisabled(stackFile);

      const deployedEnv = deployedEnvs.get(stackName);
      if (deployedEnv) {
        const variables = (await this.stackVariables(stackName)).map(variable => variable.name);
        const stale = staleVariables(deployedEnv, variables);
        if (stale.length > 0) {
          stack.staleEnv = stale;
        }
      }
    } catch (e) {
      stack.err = (e as Error).message;
    }
    return stack;
  }

  // the variables a stack reads, cached until the next commit
  private async stackVariables(stackName: string): Promise<ComposeVariable[]> {
    const commit = await this.bareRepo.headCommit();
    if (this.variablesCache.commit !== commit) {
      this.variablesCache = { commit, byStack: new Map() };
    }

    const { byStack } = this.variablesCache;
    let variables = byStack.get(stackName);
    if (!variables) {
      variables = this.bareRepo.getStack(stackName).then(stackFile => composeVariableDetails(stackFile as string));
      byStack.set(stackName, variables);
      // a failure isn't cached: it may be docker's rather than the stack's
      variables.catch(() => byStack.delete(stackName));
    }
    return await variables;
  }

  // why secret values aren't served: without an API key, /api/* is open to anyone who can reach it
  private secretsError(): string | undefined {
    return configuredApiKey() ? undefined : "Set GITAINER_API_KEY to view env values: without an API key, anyone who can reach gitainer could read every secret";
  }

  private busyError(stackName: string): string | undefined {
    const action = this.inFlight.get(stackName);
    return action ? `Stack ${stackName} already has ${/^[aeiou]/.test(action) ? 'an' : 'a'} ${action} in progress` : undefined;
  }

  /**
   * Marks `action` as in flight on the stack, until the caller deletes it from inFlight. Returns
   * the function that builds the deploy to store from the action's outcome. Check busyError()
   * first, with no await in between.
   */
  private lockStack(stackName: string, action: string): (ok: boolean, output: string) => DeployRecord {
    const startedAt = new Date().toISOString();
    this.inFlight.set(stackName, action);
    return (ok, output) => ({ stack: stackName, action, ok, output: stripAnsi(output).trim(), startedAt, finishedAt: new Date().toISOString() });
  }

  // stores the result of an API call, and the deploy it made if it acted on a stack
  private async record(result: Record<string, unknown>, deploys: DeployRecord[] = [], event: WebhookEventType = WebhookEventType.WEBHOOK) {
    if (!this.gitainer.store) {
      return;
    }
    const commit = deploys.length ? await this.bareRepo.headCommit() : undefined;
    await this.gitainer.store.recordEvent(event, result, deploys.map(deploy => ({ ...deploy, commit })));
  }

  // why the stack can't be brought up, if it's disabled with x-gitainer-disabled. The flag is
  // read after interpolation, so one set from an env var counts too
  private async disabledError(stackFile: string, stackName: string): Promise<string | undefined> {
    try {
      return await isStackDisabled(stackFile)
        ? `Stack ${stackName} is disabled with x-gitainer-disabled: true; remove the flag in git (or unset the env var it reads) to deploy it`
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
   * `verb` completes "Successfully <verb> stack <name>". The stack is locked while it runs.
   * `event` is where the action came from: the UI or another API client.
   */
  private async runStackAction(event: WebhookEventType, stackName: string, action: string, verb: string, stackFile: string, run: () => Promise<{ text(): string, stderr?: { toString(): string } }>): Promise<UpdateResult> {
    const deploy = this.lockStack(stackName, action);
    try {
      const output = await run();
      this.inFlight.delete(stackName);
      const outputText = output.text();
      // compose reports its progress on stderr
      const stored = deploy(true, [outputText, output.stderr?.toString()].filter(Boolean).join("\n"));

      const res = {
        title: webhookTitle(event),
        stackName,
        msg: `Successfully ${verb} stack ${stackName}: ${outputText}`,
        output: outputText,
      };

      await this.record(res, [stored], event);
      // a down leaves nothing running with an env. Anything else just deployed the stack with the current one
      if (action === "down") {
        await this.gitainer.store?.clearStackEnv(stackName);
      } else {
        await recordDeployedEnv(this.gitainer.store, stackName, stackFile);
      }

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
      this.inFlight.delete(stackName);
      await this.record({ stackName, err: errMsg }, [deploy(false, errMsg)], event);
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
