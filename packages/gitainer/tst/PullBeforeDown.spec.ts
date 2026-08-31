import { expect, test } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

let testCounter = 0;

function getTestSetup() {
  testCounter++;
  const testId = `test_${testCounter}_${Date.now()}`;
  const testRoot = `./tst/resources_pulldown_${testId}`;
  const port = 3400 + testCounter * 2;
  const webhookPort = 3400 + testCounter * 2 + 1;

  try {
    rmSync(testRoot, { recursive: true });
  } catch (e) {}

  mkdirSync(testRoot + "/backend/data", { recursive: true });
  mkdirSync(testRoot + "/backend/fragments", { recursive: true });
  mkdirSync(testRoot + "/backend/stacks", { recursive: true });
  mkdirSync(testRoot + "/client", { recursive: true });

  const docker = new DockerClient();
  process.env.FRAGMENTS_PATH = "fragments";
  const gitainer = new GitainerServer(
    "docker",
    "main",
    testRoot + "/backend",
    testRoot + "/backend/data",
    "fragments",
    testRoot + "/backend/stacks",
    docker,
    false,
    `http://localhost:${webhookPort}/gitainer`,
  );

  const postHelper = new NotifyWebhookTestHelper("/gitainer", webhookPort);

  return {
    testRoot,
    port,
    docker,
    gitainer,
    postHelper,
    cleanup: async () => {
      await gitainer.close();
      postHelper.listener.stop(true);
      try {
        rmSync(testRoot, { recursive: true });
      } catch (e) {}
    }
  };
}

async function cloneAndConfigRepo(testRoot: string, port: number) {
  await $`git clone http://localhost:${port}/docker.git`.cwd(testRoot + "/client");
  await $`git config user.name "test"`.cwd(testRoot + "/client/docker");
  await $`git config user.email "test@test.com"`.cwd(testRoot + "/client/docker");
  await $`git config init.defaultBranch main`.cwd(testRoot + "/client/docker");
  await $`git config push.autoSetupRemote "true"`.cwd(testRoot + "/client/docker");
}

function waitForSynthesisSuccess(postHelper: NotifyWebhookTestHelper) {
  return new Promise((resolve, reject) => {
    postHelper.callback = (body: any) => {
      if (body.msg && body.msg.includes("Synthesis succeeded") && !body.err) {
        setTimeout(() => resolve(null), 1000);
      } else {
        setTimeout(() => reject(body), 1000);
      }
    }
  });
}

// Stubs docker.composePull/composeDown/composeUpdate on the given DockerClient so the
// synthesis flow can be exercised (and its call ordering observed) without touching real
// docker/compose. Returns the recorded call log, in invocation order.
function stubDockerCalls(docker: DockerClient): { calls: string[] } {
  const state = { calls: [] as string[] };
  (docker as any).composePull = async (composeString: string, stackName: string) => {
    state.calls.push(`composePull:${stackName}`);
  };
  (docker as any).composeDown = async (composeString: string, stackName: string) => {
    state.calls.push(`composeDown:${stackName}`);
  };
  (docker as any).composeUpdate = async (composeString: string, stackName: string) => {
    state.calls.push(`composeUpdate:${stackName}`);
  };
  return state;
}

test("modify stack: pulls the new stack's images before deconfiguring the previous stack", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();
    const { calls } = stubDockerCalls(docker);
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    const stackRoot = testRoot + "/client/docker/stacks/pulldown-test";
    mkdirSync(stackRoot, { recursive: true });

    const composeV1 = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: pulldown-app
    stop_grace_period: 0s
    labels:
      test.version: v1`;
    await $`echo "${composeV1}" > ${stackRoot}/docker-compose.yaml`;

    let postPromise = waitForSynthesisSuccess(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    // first deploy: nothing to tear down, so only composeUpdate should run
    expect(calls).toEqual(["composeUpdate:pulldown-test"]);
    calls.length = 0;

    const composeV2 = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: pulldown-app
    stop_grace_period: 0s
    labels:
      test.version: v2`;
    await $`echo "${composeV2}" > ${stackRoot}/docker-compose.yaml`;

    postPromise = waitForSynthesisSuccess(postHelper);
    await $`git add . && git commit -m "update stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    // the new stack's images must be pulled before the previous stack is torn down, and
    // composeUpdate (which pulls again before recreating) must still run afterwards
    expect(calls).toEqual([
      "composePull:pulldown-test",
      "composeDown:pulldown-test",
      "composeUpdate:pulldown-test",
    ]);
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("modify stack: composePull is called with the new content, composeDown with the previous content", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();

    const pulled: string[] = [];
    const downed: string[] = [];
    (docker as any).composePull = async (composeString: string) => { pulled.push(composeString); };
    (docker as any).composeDown = async (composeString: string) => { downed.push(composeString); };
    (docker as any).composeUpdate = async () => {};

    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    const stackRoot = testRoot + "/client/docker/stacks/pulldown-content";
    mkdirSync(stackRoot, { recursive: true });

    const composeV1 = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: pulldown-content-app
    stop_grace_period: 0s
    labels:
      test.version: v1`;
    await $`echo "${composeV1}" > ${stackRoot}/docker-compose.yaml`;

    let postPromise = waitForSynthesisSuccess(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    const composeV2 = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: pulldown-content-app
    stop_grace_period: 0s
    labels:
      test.version: v2`;
    await $`echo "${composeV2}" > ${stackRoot}/docker-compose.yaml`;

    postPromise = waitForSynthesisSuccess(postHelper);
    await $`git add . && git commit -m "update stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    expect(pulled.length).toBe(1);
    expect(pulled[0]).toContain("test.version: v2");

    expect(downed.length).toBe(1);
    expect(downed[0]).toContain("test.version: v1");
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("delete stack: tears down without pulling", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();
    const { calls } = stubDockerCalls(docker);
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    const stackRoot = testRoot + "/client/docker/stacks/pulldown-delete";
    mkdirSync(stackRoot, { recursive: true });

    const compose = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: pulldown-delete-app
    stop_grace_period: 0s`;
    await $`echo "${compose}" > ${stackRoot}/docker-compose.yaml`;

    let postPromise = waitForSynthesisSuccess(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    calls.length = 0;

    postPromise = waitForSynthesisSuccess(postHelper);
    rmSync(stackRoot, { recursive: true });
    await $`git add . && git commit -m "delete stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    expect(calls).toEqual(["composeDown:pulldown-delete"]);
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("rename stack out of pattern: tears down without pulling", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();
    const { calls } = stubDockerCalls(docker);
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    const stackRoot = testRoot + "/client/docker/stacks/pulldown-rename";
    mkdirSync(stackRoot, { recursive: true });

    const compose = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: pulldown-rename-app
    stop_grace_period: 0s`;
    await $`echo "${compose}" > ${stackRoot}/docker-compose.yaml`;

    let postPromise = waitForSynthesisSuccess(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    calls.length = 0;

    postPromise = waitForSynthesisSuccess(postHelper);
    await $`git mv docker-compose.yaml NODEPLOYdocker-compose.yaml`.cwd(stackRoot);
    await $`git add . && git commit -m "deprecate stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    expect(calls).toEqual(["composeDown:pulldown-rename"]);
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("DockerClient.composePull pulls images without starting or stopping any containers", async () => {
  const docker = new DockerClient();
  const compose = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: composepull-unit-test
    stop_grace_period: 0s`;

  await $`docker rm -f composepull-unit-test`.quiet().catch(() => {});

  try {
    await docker.composePull(compose, "composepull-unit-test");

    // composePull must not have created/started the container
    let containerExists = true;
    try {
      await $`docker inspect composepull-unit-test`.quiet();
    } catch (e) {
      containerExists = false;
    }
    expect(containerExists).toBe(false);

    // the image must now be present locally
    const imageId = await $`docker images -q alpine:latest`.text();
    expect(imageId.trim().length).toBeGreaterThan(0);
  } finally {
    await $`docker rm -f composepull-unit-test`.quiet().catch(() => {});
  }
}, { timeout: 60_000 });
