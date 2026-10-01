import { expect, test, describe } from "bun:test";
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { EventStore, type DeployRecord } from "../src/store/EventStore";
import { WebhookEventType } from "../src/webhooks/WebhookEventType";

function deploy(stack: string, overrides: Partial<DeployRecord> = {}): DeployRecord {
  return {
    stack,
    action: "deploy",
    ok: true,
    output: "Container app Started",
    commit: "abc123",
    startedAt: "2026-10-01T10:00:00.000Z",
    finishedAt: "2026-10-01T10:00:05.000Z",
    ...overrides,
  };
}

describe("EventStore", () => {
  test("stores an event with its deploys, newest first", async () => {
    const store = new EventStore(":memory:");

    await store.recordEvent(WebhookEventType.GIT_PUSH, { msg: "Synthesis succeeded for 2 stack(s)", changes: [] }, [deploy("web"), deploy("db")]);
    await store.recordEvent(WebhookEventType.WEBHOOK, { stackName: "web", err: "no such image" }, [deploy("web", { action: "up", ok: false, output: "no such image", commit: undefined })]);

    const events = await store.listEvents();
    expect(events).toMatchObject([
      { type: "Webhook", ok: false, message: "no such image", payload: { title: "Gitainer: Webhook", stackName: "web", err: "no such image" } },
      { type: "Git Push", ok: true, message: "Synthesis succeeded for 2 stack(s)", payload: { title: "Gitainer: Git Push", changes: [] } },
    ]);
    expect(events[0].deploys.map(stored => stored.stack)).toEqual(["web"]);
    expect(events[1].deploys.map(stored => stored.stack)).toEqual(["web", "db"]);

    const [failed, ...rest] = await store.listDeploys("web");
    expect(failed).toMatchObject({ stack: "web", action: "up", ok: false, trigger: "Webhook", eventId: events[0].id });
    expect(failed.commit).toBeUndefined();
    expect(rest).toEqual([{ ...deploy("web"), id: 1, eventId: events[1].id, trigger: "Git Push" }]);

    expect((await store.listDeploys()).map(stored => stored.stack)).toEqual(["web", "db", "web"]);
    expect(await store.listEvents(1)).toHaveLength(1);
    await store.close();
  });

  test("keeps its history across restarts", async () => {
    const dir = `./tst/resources_store_${Date.now()}`;
    try {
      // the data dir doesn't have to exist yet
      const store = new EventStore(`${dir}/data/gitainer.sqlite`);
      await store.recordEvent(WebhookEventType.ENV_UPDATE, { msg: "Synthesis succeeded for 1 stack(s)" }, [deploy("web")]);
      await store.close();

      // readable only by its owner, and the write-ahead log is gone once it's closed
      expect(statSync(`${dir}/data/gitainer.sqlite`).mode & 0o777).toBe(0o600);
      expect(readdirSync(`${dir}/data`)).toEqual(["gitainer.sqlite"]);

      const reopened = new EventStore(`${dir}/data/gitainer.sqlite`);
      expect(await reopened.listEvents()).toMatchObject([{ type: "Env Update", ok: true, deploys: [{ stack: "web" }] }]);
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // the only test writing a database to disk, which a busy CI runner can be slow to sync
  }, 30_000);

  test("a database that can't be written doesn't fail the caller", async () => {
    const store = new EventStore(":memory:");
    await store.close();

    // must not throw: it's called in the middle of a deploy
    await store.recordEvent(WebhookEventType.WEBHOOK, { msg: "ok" });
  });
});

describe("EventStore records syntheses", () => {
  const testRoot = `./tst/resources_eventstore_${Date.now()}`;
  const port = 3610;

  // docker is stubbed: `failing` stacks fail to deploy
  function stubDocker(docker: DockerClient, failing: string[] = []) {
    (docker as any).composePull = async () => {};
    (docker as any).composeDown = async () => {};
    (docker as any).composeUpdate = async (composeString: string, stackName: string) => {
      if (failing.includes(stackName) && composeString.includes("broken")) {
        throw new Error(`no such image for ${stackName}`);
      }
      return { stderr: ` Container ${stackName}-app-1 Started ` };
    };
  }

  async function pushStack(stackName: string, image: string) {
    const stackRoot = `${testRoot}/client/docker/stacks/${stackName}`;
    mkdirSync(stackRoot, { recursive: true });
    await Bun.write(`${stackRoot}/docker-compose.yaml`, `services:\n  app:\n    image: ${image}\n`);
    await $`git add -A && git commit -m ${`${stackName} ${image}`}`.cwd(`${testRoot}/client/docker`).quiet();
    // a failed synthesis rejects nothing: the push itself succeeds and the commit is removed after
    await $`git push origin HEAD:main`.cwd(`${testRoot}/client/docker`).quiet().nothrow();
  }

  test("a push stores one event with a deploy per stack, also when it fails", async () => {
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot + "/backend/data", { recursive: true });
    mkdirSync(testRoot + "/client", { recursive: true });

    const docker = new DockerClient();
    const store = new EventStore(":memory:");
    process.env.FRAGMENTS_PATH = "fragments";
    const gitainer = new GitainerServer("docker", "main", testRoot + "/backend", testRoot + "/backend/data", "fragments",
      testRoot + "/backend/stacks", docker, false, undefined, undefined, store);

    try {
      await gitainer.initRepo();
      stubDocker(docker, ["web"]);
      gitainer.listen(port);

      await $`git clone http://localhost:${port}/docker.git`.cwd(testRoot + "/client").quiet();
      await $`git config user.name "test" && git config user.email "test@test.com"`.cwd(testRoot + "/client/docker");

      await pushStack("web", "alpine");
      const [pushed] = await store.listEvents();
      expect(pushed).toMatchObject({
        type: "Git Push",
        ok: true,
        message: "Synthesis succeeded for 1 stack(s): stacks/web/docker-compose.yaml",
        deploys: [{ stack: "web", action: "deploy", ok: true, output: "Container web-app-1 Started", trigger: "Git Push" }],
      });
      // the env it was deployed with is remembered, to tell a stale one later
      expect([...(await store.listStackEnvs()).keys()]).toEqual(["web"]);
      const commit = (await $`git rev-parse HEAD`.cwd(testRoot + "/client/docker").text()).trim();
      expect(pushed.deploys[0].commit).toBe(commit);

      await pushStack("web", "broken");
      const [failed] = await store.listEvents();
      expect(failed).toMatchObject({
        type: "Git Push",
        ok: false,
        deploys: [{ stack: "web", action: "deploy", ok: false, output: "no such image for web" }],
      });
      expect(failed.message).toContain("removing the bad commit");
      expect(await store.listDeploys("web")).toHaveLength(2);
    } finally {
      await gitainer.close();
      await store.close();
      if (existsSync(testRoot)) {
        rmSync(testRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
