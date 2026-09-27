import { afterAll, expect, test } from "bun:test";
import { DockerClient, extractShutdownHook } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $ } from "bun";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

const OUT_DIR = "./tst/resources_shutdownhook_out";

afterAll(() => rmSync(OUT_DIR, { recursive: true, force: true }));

function tmpOutFile(name: string) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${name}_${Date.now()}.txt`;
  rmSync(file, { force: true });
  return file;
}

function stackCompose(containerName: string, hook: string, version = "v1") {
  return `${hook}
services:
  app:
    image: alpine
    command: sleep infinity
    container_name: ${containerName}
    stop_grace_period: 0s
    labels:
      test.version: ${version}
`;
}

async function isRunning(containerName: string): Promise<boolean> {
  const output = await $`docker inspect ${containerName} --format '{{.State.Running}}'`.nothrow().quiet().text();
  return output.trim() === "true";
}

async function removeContainer(containerName: string) {
  await $`docker rm -f ${containerName}`.quiet().nothrow();
}

test("extractShutdownHook parses string, list and missing hooks", () => {
  expect(extractShutdownHook(`services:\n  app:\n    image: alpine\n`)).toEqual([]);
  expect(extractShutdownHook(`x-shutdown-hook: echo hi\nservices: {}\n`)).toEqual(["echo hi"]);
  expect(extractShutdownHook(`x-shutdown-hook:\n  - echo one\n  - echo two\nservices: {}\n`)).toEqual(["echo one", "echo two"]);
});

test("extractShutdownHook rejects a malformed hook", () => {
  expect(() => extractShutdownHook(`x-shutdown-hook:\n  cmd: echo hi\nservices: {}\n`)).toThrow("x-shutdown-hook must be");
  expect(() => extractShutdownHook(`x-shutdown-hook:\n  - 1\nservices: {}\n`)).toThrow("x-shutdown-hook must be");
});

test("composeDown runs each hook command in order before downing the stack", async () => {
  const docker = new DockerClient();
  const out = tmpOutFile("order");
  const container = "shutdownhook-order";
  // the hook can still reach the running container, proving it runs before the down
  const compose = stackCompose(container, `x-shutdown-hook:
  - echo first >> ${out}
  - docker exec ${container} echo second >> ${out}`);

  await removeContainer(container);
  try {
    await docker.composeUpdate(compose, "shutdownhook-order");
    expect(await isRunning(container)).toBe(true);

    await docker.composeDown(compose, "shutdownhook-order");
    expect(readFileSync(out, "utf-8")).toBe("first\nsecond\n");
    expect(await isRunning(container)).toBe(false);
  } finally {
    await removeContainer(container);
  }
}, { timeout: 60_000 });

test("composeDown fails with the hook error and leaves the stack running", async () => {
  const docker = new DockerClient();
  const out = tmpOutFile("failure");
  const container = "shutdownhook-failure";
  const compose = stackCompose(container, `x-shutdown-hook:
  - echo backup failed >&2; exit 3
  - echo should-not-run >> ${out}`);

  await removeContainer(container);
  try {
    await docker.composeUpdate(compose, "shutdownhook-failure");

    const err = await docker.composeDown(compose, "shutdownhook-failure").then(() => undefined, e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(`Shutdown hook for stack "shutdownhook-failure" failed (exit code 3)`);
    expect(err!.message).toContain("backup failed");

    // later commands are skipped and the stack is not downed
    expect(() => readFileSync(out, "utf-8")).toThrow();
    expect(await isRunning(container)).toBe(true);
  } finally {
    await removeContainer(container);
  }
}, { timeout: 60_000 });

test("runShutdownHook is skipped when the stack has no containers", async () => {
  const docker = new DockerClient();
  const out = tmpOutFile("skipped");
  const compose = stackCompose("shutdownhook-skipped", `x-shutdown-hook: echo ran >> ${out}; exit 1`);

  await removeContainer("shutdownhook-skipped");
  await docker.runShutdownHook(compose, "shutdownhook-skipped");
  expect(() => readFileSync(out, "utf-8")).toThrow();
});

test("runShutdownHook passes the command environment to the hook", async () => {
  const docker = new DockerClient();
  const out = tmpOutFile("env");
  const container = "shutdownhook-env";
  const compose = stackCompose(container, `x-shutdown-hook: echo "$SHUTDOWN_HOOK_TEST_VAR" > ${out}`);

  await removeContainer(container);
  try {
    await docker.composeUpdate(compose, "shutdownhook-env");
    await docker.runShutdownHook(compose, "shutdownhook-env", { ...process.env, SHUTDOWN_HOOK_TEST_VAR: "from-env" });
    expect(readFileSync(out, "utf-8")).toBe("from-env\n");
  } finally {
    await removeContainer(container);
  }
}, { timeout: 60_000 });

test("composeUpdate rejects a malformed shutdown hook before deploying", async () => {
  const docker = new DockerClient();
  const container = "shutdownhook-malformed";
  const compose = stackCompose(container, `x-shutdown-hook:
  cmd: echo hi`);

  await removeContainer(container);
  await expect(docker.composeUpdate(compose, "shutdownhook-malformed")).rejects.toThrow("x-shutdown-hook must be");
  expect(await isRunning(container)).toBe(false);
});

let pushTestCounter = 0;

// Spins up a gitainer server with a cloned client repo, and returns helpers to push a stack
// and wait for the resulting POST webhook body.
async function setupPushTest(stackName: string) {
  pushTestCounter++;
  const testRoot = `./tst/resources_shutdownhook_push_${pushTestCounter}`;
  const port = 3600 + pushTestCounter * 2;
  const webhookPort = port + 1;

  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot + "/backend/data", { recursive: true });
  mkdirSync(testRoot + "/backend/fragments", { recursive: true });
  mkdirSync(testRoot + "/backend/stacks", { recursive: true });
  mkdirSync(testRoot + "/client", { recursive: true });

  process.env.FRAGMENTS_PATH = "fragments";
  const gitainer = new GitainerServer(
    "docker",
    "main",
    testRoot + "/backend",
    testRoot + "/backend/data",
    "fragments",
    testRoot + "/backend/stacks",
    new DockerClient(),
    false,
    `http://localhost:${webhookPort}/gitainer`,
  );
  const postHelper = new NotifyWebhookTestHelper("/gitainer", webhookPort);

  await gitainer.initRepo();
  gitainer.listen(port);

  const client = testRoot + "/client/docker";
  await $`git clone http://localhost:${port}/docker.git`.cwd(testRoot + "/client");
  await $`git config user.name "test"`.cwd(client);
  await $`git config user.email "test@test.com"`.cwd(client);
  await $`git config push.autoSetupRemote "true"`.cwd(client);

  const stackRoot = `${client}/stacks/${stackName}`;
  mkdirSync(stackRoot, { recursive: true });

  return {
    push: async (compose: string): Promise<any> => {
      const body = new Promise(resolve => {
        postHelper.callback = (b: any) => setTimeout(() => resolve(b), 1000);
      });
      await $`echo ${compose} > ${stackRoot}/docker-compose.yaml`;
      await $`git add . && git commit -m "update stack" && git push`.cwd(client).nothrow();
      return await body;
    },
    cleanup: async () => {
      await gitainer.close();
      postHelper.listener.stop(true);
      rmSync(testRoot, { recursive: true, force: true });
    },
  };
}

async function versionLabel(containerName: string): Promise<string> {
  const labels = await $`docker inspect ${containerName} --format '{{json .Config.Labels}}'`.json();
  return labels["test.version"];
}

test("push fixing a broken shutdown hook runs the new hook, so the stack isn't trapped", async () => {
  const container = "shutdownhook-push-fix";
  const out = tmpOutFile("push-fix");
  await removeContainer(container);
  const { push, cleanup } = await setupPushTest("shutdownhook-push-fix");
  try {
    let body = await push(stackCompose(container, "x-shutdown-hook: exit 1", "v1"));
    expect(body.err).toBeUndefined();
    expect(await versionLabel(container)).toBe("v1");

    // the deployed v1 hook is broken, but the incoming v2 hook is the one that runs
    body = await push(stackCompose(container, `x-shutdown-hook: echo v2-hook >> ${out}`, "v2"));
    expect(body.err).toBeUndefined();
    expect(readFileSync(out, "utf-8")).toBe("v2-hook\n");
    expect(await versionLabel(container)).toBe("v2");
  } finally {
    await cleanup();
    await removeContainer(container);
  }
}, { timeout: 100_000 });

test("push whose new shutdown hook fails is rejected and the stack is left running", async () => {
  const container = "shutdownhook-push-fail";
  await removeContainer(container);
  const { push, cleanup } = await setupPushTest("shutdownhook-push-fail");
  try {
    let body = await push(stackCompose(container, "", "v1"));
    expect(body.err).toBeUndefined();

    body = await push(stackCompose(container, "x-shutdown-hook: echo hook refused >&2; exit 1", "v2"));
    expect(body.err).toContain(`Shutdown hook for stack "shutdownhook-push-fail" failed (exit code 1)`);
    expect(body.err).toContain("hook refused");

    // the stack was never downed, so the v1 container is still running
    expect(await isRunning(container)).toBe(true);
    expect(await versionLabel(container)).toBe("v1");
  } finally {
    await cleanup();
    await removeContainer(container);
  }
}, { timeout: 100_000 });
