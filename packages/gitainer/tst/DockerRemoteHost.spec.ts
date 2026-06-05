import { expect, test } from "bun:test";
import { extractRemoteHostConfig } from "../src/docker/DockerClient";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

// Unit tests for extractRemoteHostConfig
test("extractRemoteHostConfig extracts remote host and optional project directory correctly", () => {
  // Test case 1: absolute path suffix
  const config1 = extractRemoteHostConfig("#@ root@192.168.1.100:/opt/stack\nservices:\n  app:\n    image: alpine");
  expect(config1).toEqual({
    dockerHost: "ssh://root@192.168.1.100",
    composeProjectDir: "/opt/stack"
  });

  // Test case 2: relative path suffix
  const config2 = extractRemoteHostConfig("#@ root@192.168.1.100:opt/stack\nservices:\n  app:\n    image: alpine");
  expect(config2).toEqual({
    dockerHost: "ssh://root@192.168.1.100",
    composeProjectDir: "opt/stack"
  });

  // Test case 3: no path suffix
  const config3 = extractRemoteHostConfig("#@ root@192.168.1.100\nservices:\n  app:\n    image: alpine");
  expect(config3).toEqual({
    dockerHost: "ssh://root@192.168.1.100",
    composeProjectDir: undefined
  });

  // Test case 4: already has scheme
  const config4 = extractRemoteHostConfig("#@ ssh://root@192.168.1.100:2222:/opt/stack\nservices:\n  app:\n    image: alpine");
  expect(config4).toEqual({
    dockerHost: "ssh://root@192.168.1.100:2222",
    composeProjectDir: "/opt/stack"
  });

  // Test case 5: tcp scheme
  const config5 = extractRemoteHostConfig("#@ tcp://192.168.1.100:2375\nservices:\n  app:\n    image: alpine");
  expect(config5).toEqual({
    dockerHost: "tcp://192.168.1.100:2375",
    composeProjectDir: undefined
  });

  // Test case 6: no comment
  const config6 = extractRemoteHostConfig("services:\n  app:\n    image: alpine");
  expect(config6).toBeUndefined();
});

test("extractRemoteHostConfig throws error on invalid syntax or placement", () => {
  // Comment not at line 1
  expect(() => {
    extractRemoteHostConfig("services:\n  app:\n#@ root@192.168.1.100\n    image: alpine");
  }).toThrow("Remote host comment (#@) is only allowed once per stack, exactly at the first line");

  // Empty value
  expect(() => {
    extractRemoteHostConfig("#@\nservices:\n  app:\n    image: alpine");
  }).toThrow("Invalid remote host comment syntax at line 1");

  // Missing host (e.g. scheme only or colon only)
  expect(() => {
    extractRemoteHostConfig("#@ ssh://\nservices:\n  app:\n    image: alpine");
  }).toThrow("Invalid remote host comment syntax at line 1: missing host");
});

let testCounter = 0;

function getTestSetup() {
  testCounter++;
  const testId = `test_${testCounter}_${Date.now()}`;
  const testRoot = `./tst/resources_remote_${testId}`;
  const port = 3110 + testCounter * 2;
  const webhookPort = 3110 + testCounter * 2 + 1;

  try {
    rmSync(testRoot, { recursive: true });
  } catch (e) {}

  mkdirSync(testRoot, { recursive: true });
  mkdirSync(testRoot + "/backend", { recursive: true });
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
    `http://localhost:${webhookPort}/gitainer`
  );

  const postHelper = new NotifyWebhookTestHelper("/gitainer", webhookPort);

  return {
    testRoot,
    port,
    webhookPort,
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

test("push stack with remote host fails on connection and propagates error to webhook", async () => {
  const { testRoot, port, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();
    gitainer.listen(port);

    await cloneAndConfigRepo(testRoot, port);
    const stackRoot = testRoot + "/client/docker/stacks/remote-app";
    mkdirSync(stackRoot, { recursive: true });

    // 192.0.2.1 is reserved for documentation and is non-routable, ensuring connection timeout/failure
    const compose = `#@ root@192.0.2.1:/opt/stack
services:
  app:
    image: alpine
    command: sleep infinity
    container_name: remote-app-test
    stop_grace_period: 0s`;
    
    await $`echo "${compose}" > ${stackRoot}/docker-compose.yaml`;

    const postPromise = new Promise((resolve, reject) => {
      postHelper.callback = (body: any) => {
        if (body.err && body.err.includes("Got an error during synthesis") && body.err.includes("192.0.2.1")) {
          setTimeout(() => resolve(null), 1000);
        } else {
          console.log("Received unexpected webhook body:", body);
          setTimeout(() => reject(new Error("Webhook error did not propagate expected SSH connection failure")), 1000);
        }
      }
    });

    await $`git add . && git commit -m "add remote host stack" && git push 2>&1`.cwd(testRoot + "/client/docker");
    await postPromise;
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("push stack with invalid syntax remote host comment fails validation and propagates error to webhook", async () => {
  const { testRoot, port, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();
    gitainer.listen(port);

    await cloneAndConfigRepo(testRoot, port);
    const stackRoot = testRoot + "/client/docker/stacks/invalid-app";
    mkdirSync(stackRoot, { recursive: true });

    const compose = `services:
  app:
    image: alpine
#@ root@192.168.1.100
    command: sleep infinity
    container_name: invalid-app-test
    stop_grace_period: 0s`;
    
    await $`echo "${compose}" > ${stackRoot}/docker-compose.yaml`;

    const postPromise = new Promise((resolve, reject) => {
      postHelper.callback = (body: any) => {
        if (body.err && body.err.includes("Remote host comment (#@) is only allowed once per stack, exactly at the first line")) {
          setTimeout(() => resolve(null), 1000);
        } else {
          console.log("Received unexpected webhook body:", body);
          setTimeout(() => reject(new Error("Webhook error did not propagate validation error")), 1000);
        }
      }
    });

    await $`git add . && git commit -m "add invalid comment stack" && git push 2>&1`.cwd(testRoot + "/client/docker");
    await postPromise;
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });
