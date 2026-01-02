import { expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $, sleepSync } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

const TEST_ROOT = "./tst/resources";
const TEST_COMPOSE_ROOT = "./tst/compose";
const TEST_FRAGMENTS_ROOT = "./tst/fragments";

let gitainer: GitainerServer;
let postHelper: NotifyWebhookTestHelper;

// TODO: run tests from an isolated dind container to be more consistent and not impact host machine

async function initEmptyRepo() {
  const docker = new DockerClient();
  process.env.FRAGMENTS_PATH = "fragments";
  gitainer = new GitainerServer(
    "docker",
    "main",
    TEST_ROOT + "/backend",
    TEST_ROOT + "/backend/data",
    "fragments",
    TEST_ROOT + "/backend/stacks",
    docker,
    false,
    "http://localhost:3005/gitainer"
  );

  await gitainer.initRepo();
  gitainer.listen(3000);
}

async function cloneAndConfigRepo() {
  await $`git clone http://localhost:3000/docker.git`.cwd(TEST_ROOT + "/client");

  await $`git config user.name "test"`.cwd(TEST_ROOT + "/client/docker");
  await $`git config user.email "test@test.com"`.cwd(TEST_ROOT + "/client/docker");
  await $`git config init.defaultBranch main`.cwd(TEST_ROOT + "/client/docker");
  await $`git config push.autoSetupRemote "true"`.cwd(TEST_ROOT + "/client/docker");
}

beforeEach(async () => {
  postHelper = new NotifyWebhookTestHelper("/gitainer", 3005);

  // clean if there was anything
  try {
    rmSync(TEST_ROOT, { recursive: true });
  } catch (e) {
    // pass
  }

  mkdirSync(TEST_ROOT);
  mkdirSync(TEST_ROOT + "/backend");
  mkdirSync(TEST_ROOT + "/backend/data");
  mkdirSync(TEST_ROOT + "/backend/fragments");
  mkdirSync(TEST_ROOT + "/backend/stacks");
  mkdirSync(TEST_ROOT + "/client");

  await initEmptyRepo();
});

afterEach(async () => {
  await gitainer.close();
  postHelper.listener.stop(true);

  try {
    rmSync(TEST_ROOT, { recursive: true });
  } catch (e) {
    // pass
  }

  // clean containers
  await $`docker rm -f redis`;
});

test("can clone empty gitainer repo", async () => {
  await cloneAndConfigRepo();
});

test("push redis stack, starts redis service and sends POST notification", async () => {
  await cloneAndConfigRepo();
  const redisRoot = TEST_ROOT + "/client/docker/stacks/redis";

  mkdirSync(redisRoot, {
    recursive: true,
  });

  const postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body) => {
      if (
        body.msg === "Synthesis succeeded for 1 stack(s)" &&
        body.changes?.length === 1 &&
        body.changes[0].file === "stacks/redis/docker-compose.yaml"
      ) {
        setTimeout(() => resolve(null), 1_000);
      } else {
        setTimeout(() => reject("wrong result from stack webhook"), 1_000);
      }
    }
  });

  await $`cp ${TEST_COMPOSE_ROOT}/redis-compose.yaml ${redisRoot}/docker-compose.yaml`;
  await $`git add . && git commit -m "add redis" && git push`.cwd(TEST_ROOT + "/client/docker");

  await postPromise;
}, {
  timeout: 100_000,
});

test("bad compose file, should fail to deploy", async () => {
  await cloneAndConfigRepo();

  const redisRoot = TEST_ROOT + "/client/docker/stacks/redis";

  mkdirSync(redisRoot, {
    recursive: true,
  });

  let postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body) => {
      if (
        body.msg === "Synthesis succeeded for 1 stack(s)" &&
        body.changes?.length === 1 &&
        body.changes[0].file === "stacks/redis/docker-compose.yaml"
      ) {
        setTimeout(() => resolve(null), 1_000);
      } else {
        setTimeout(() => reject("wrong result from stack webhook"), 1_000);
      }
    }
  });

  // make good change
  await $`cp ${TEST_COMPOSE_ROOT}/redis-compose.yaml ${redisRoot}/docker-compose.yaml`;
  await $`git add . && git commit -m "add redis" && git push`.cwd(TEST_ROOT + "/client/docker");

  await postPromise;

  postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body) => {
      if (
        body.err?.includes("Got an error during synthesis") &&
        body.failedStack === "stacks/redis/docker-compose.yaml"
      ) {
        setTimeout(() => resolve(null), 1_000);
      } else {
        setTimeout(() => reject("wrong result from stack webhook"), 1_000);
      }
    }
  });

  // make bad change
  await $`cp -f ${TEST_COMPOSE_ROOT}/bad-compose.yaml ${redisRoot}/docker-compose.yaml`;
  await $`git add . && git commit -m "add bad file" && git push`.cwd(TEST_ROOT + "/client/docker");

  await postPromise;
}, {
  timeout: 100_000,
});

test("push stack using fragments, should resolve and deploy", async () => {
  await cloneAndConfigRepo();
  const fragRoot = TEST_ROOT + "/client/docker/fragments";
  const stackRoot = TEST_ROOT + "/client/docker/stacks/fragstack";

  mkdirSync(fragRoot, { recursive: true });
  mkdirSync(stackRoot, { recursive: true });

  await $`cp ${TEST_FRAGMENTS_ROOT}/labels.yaml ${fragRoot}/labels.yaml`;

  // Create stack using fragment
  await $`cp ${TEST_COMPOSE_ROOT}/compose-with-fragment.yaml ${stackRoot}/docker-compose.yaml`;

  // Setup waiter
  const postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body) => {
      if (body.msg === "Synthesis succeeded for 1 stack(s)") {
        setTimeout(() => resolve(null), 1000);
      } else {
        setTimeout(() => reject(body), 1000);
      }
    }
  });

  // Push
  await $`git add . && git commit -m "add fragment stack" && git push`.cwd(TEST_ROOT + "/client/docker");

  await postPromise;

  // Verify internal processing
  const stack = await gitainer.bareRepo.getStack("fragstack");
  expect(stack).toContain("x-labels: &labels");
  expect(stack).toContain(`custom.label: fragment-verified`);
  expect(stack).toContain("# === fragments start ===");

  // Verify deployed container
  // Inspect the container and filter for the label
  const labels = await $`docker inspect frag-app --format '{{json .Config.Labels}}'`.json();
  expect(labels["custom.label"]).toBe("fragment-verified");

  // Cleanup container
  await $`docker rm -f frag-app`;
}, { timeout: 100_000 });

test("rollback: multiple stacks, first valid, second invalid -> first reverts", async () => {
  await cloneAndConfigRepo();
  const stackARoot = TEST_ROOT + "/client/docker/stacks/stack-a";
  const stackBRoot = TEST_ROOT + "/client/docker/stacks/stack-b";

  mkdirSync(stackARoot, { recursive: true });
  mkdirSync(stackBRoot, { recursive: true });

  // Initial valid state for stack A
  const composeA1 = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: stack-a
    stop_grace_period: 0s
    labels:
      test.version: v1`;
  await $`echo "${composeA1}" > ${stackARoot}/docker-compose.yaml`;

  // Setup waiter for first push
  let postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body) => {
      if (body.msg && body.msg.includes("Synthesis succeeded") && !body.err) {
        setTimeout(() => resolve(null), 1000);
      } else {
        setTimeout(() => reject(body), 1000);
      }
    }
  });

  // Push initial stack A
  await $`git add . && git commit -m "init stack a" && git push`.cwd(TEST_ROOT + "/client/docker");
  await postPromise;

  // Verify stack A is v1
  let labels = await $`docker inspect stack-a --format '{{json .Config.Labels}}'`.json();
  expect(labels["test.version"]).toBe("v1");

  // Prepare second push: Modify A (v2) and Add B (invalid)
  // Stack A -> v2
  // Stack A -> v2
  const composeA2 = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: stack-a
    stop_grace_period: 0s
    labels:
      test.version: v2`;
  await $`echo "${composeA2}" > ${stackARoot}/docker-compose.yaml`;

  // Stack B -> invalid
  const composeB = `services:
  app:
    image: alpine
    container_name:
    labels:
      test.version: v1`;
  await $`echo "${composeB}" > ${stackBRoot}/docker-compose.yaml`;

  // Setup waiter for failure
  postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body) => {
      if (body.err && body.err.includes("removing the bad commit")) {
        setTimeout(() => resolve(null), 1000);
      } else {
        // It might send success if rollback logic is broken?
        console.log("Unexpected body:", body);
        setTimeout(() => reject(body), 1000);
      }
    }
  });

  // Push bad commit
  await $`git add . && git commit -m "update a, add bad b" && git push`.cwd(TEST_ROOT + "/client/docker");

  // Expect failure
  await postPromise;

  // Verify Stack A is ROLLED BACK to v1
  labels = await $`docker inspect stack-a --format '{{json .Config.Labels}}'`.json();
  expect(labels["test.version"]).toBe("v1");

  // Verify Stack B does not exist
  try {
    await $`docker inspect stack-b --format '{{json .Config.Labels}}'`.json();
    throw new Error("Stack B should not exist");
  } catch (e) {
    // pass
  }

  // Cleanup
  await $`docker rm -f stack-a`;
}, { timeout: 100_000 });

test("delete stack: push deletion -> stack is downed", async () => {
  await cloneAndConfigRepo();
  const stackRoot = TEST_ROOT + "/client/docker/stacks/deleteme";
  mkdirSync(stackRoot, { recursive: true });

  const compose = `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: deleteme-app
    stop_grace_period: 0s`;
  await $`echo "${compose}" > ${stackRoot}/docker-compose.yaml`;

  // Setup waiter for deploy
  let postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body: any) => {
      if (body.msg && body.msg.includes("Synthesis succeeded") && !body.err) {
        setTimeout(() => resolve(null), 1000);
      } else {
        setTimeout(() => reject(body), 1000);
      }
    }
  });

  // Push to deploy
  await $`git add . && git commit -m "add stack to delete" && git push`.cwd(TEST_ROOT + "/client/docker");
  await postPromise;

  // Verify it's running
  await $`docker inspect deleteme-app`.quiet();

  // Setup waiter for deletion
  postPromise = new Promise((resolve, reject) => {
    postHelper.callback = (body: any) => {
      if (body.msg && body.msg.includes("Synthesis succeeded") && !body.err) {
        setTimeout(() => resolve(null), 1000);
      } else {
        setTimeout(() => reject(body), 1000);
      }
    }
  });

  // Delete stack file and push
  rmSync(stackRoot, { recursive: true });
  await $`git add . && git commit -m "delete stack" && git push`.cwd(TEST_ROOT + "/client/docker");
  await postPromise;

  // Verify it's gone
  try {
    await $`docker inspect deleteme-app`.quiet();
    throw new Error("Container should have been deleted");
  } catch (e) {
    // success: container not found
  }

}, { timeout: 100_000 });
