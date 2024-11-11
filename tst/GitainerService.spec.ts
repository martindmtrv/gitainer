import { expect, test, beforeEach, afterEach, afterAll } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $, sleepSync } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

const TEST_ROOT = "./tst/resources";
const TEST_COMPOSE_ROOT = "./tst/compose";

let gitainer: GitainerServer;
let postHelper: NotifyWebhookTestHelper;

// TODO: run tests from an isolated dind container to be more consistent and not impact host machine

async function initEmptyRepo() {
  const docker = new DockerClient();
  gitainer = new GitainerServer(
    "docker",
    "main",
    TEST_ROOT + "/backend", 
    TEST_ROOT + "/backend/data", 
    TEST_ROOT + "/backend/fragments",
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
  await $`git checkout -b main`.cwd(TEST_ROOT + "/client/docker");
  await $`git config push.autoSetupRemote "true"`.cwd(TEST_ROOT + "/client/docker");
}

beforeEach(async () => {
  postHelper = new NotifyWebhookTestHelper("/gitainer", 3005);

  // clean if there was anything
  rmSync(TEST_ROOT, { recursive: true });

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
  rmSync(TEST_ROOT, { recursive: true });

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
