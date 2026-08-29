import { expect, test } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

const TEST_COMPOSE_ROOT = "./tst/compose";

async function waitFor(fn: () => Promise<void>, timeoutMs = 30_000, intervalMs = 500) {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await fn();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
  throw lastErr;
}

let testCounter = 0;

function getTestSetup(selfStackName?: string) {
  testCounter++;
  const testId = `test_${testCounter}_${Date.now()}`;
  const testRoot = `./tst/resources_self_${testId}`;
  const port = 3200 + testCounter * 2;
  const webhookPort = 3200 + testCounter * 2 + 1;

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
    selfStackName,
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

test("composeSelfUpdate deploys via a detached sibling container", async () => {
  const docker = new DockerClient();
  const compose = await Bun.file(`${TEST_COMPOSE_ROOT}/self-stack-compose.yaml`).text();

  await $`docker rm -f selfstack-app-test`.quiet().catch(() => {});
  await $`docker rm -f ${docker.selfUpdateContainerName("directtest")}`.quiet().catch(() => {});

  try {
    await docker.composeSelfUpdate(compose, "directtest");

    // the sibling runs pull+up asynchronously in the background, so poll for it
    await waitFor(async () => {
      await $`docker inspect selfstack-app-test --format {{.State.Running}}`.quiet().text();
    });
  } finally {
    await $`docker rm -f selfstack-app-test`.quiet().catch(() => {});
    await $`docker rm -f ${docker.selfUpdateContainerName("directtest")}`.quiet().catch(() => {});
  }
}, { timeout: 60_000 });

test("composeSelfUpdate forwards gitainer's process env into the sibling for compose variable interpolation", async () => {
  const docker = new DockerClient();
  const compose = await Bun.file(`${TEST_COMPOSE_ROOT}/self-stack-env-compose.yaml`).text();
  const containerName = docker.selfUpdateContainerName("envforwardtest");

  await $`docker rm -f selfstack-env-test`.quiet().catch(() => {});
  await $`docker rm -f ${containerName}`.quiet().catch(() => {});

  const previousValue = process.env.GITAINER_TEST_FORWARD_VAR;
  process.env.GITAINER_TEST_FORWARD_VAR = "forwarded-value-123";

  try {
    await docker.composeSelfUpdate(compose, "envforwardtest");

    // the sibling resolves ${GITAINER_TEST_FORWARD_VAR} itself when it runs `up`, so this
    // only passes if gitainer's process env was actually forwarded into the sibling
    await waitFor(async () => {
      const env = await $`docker inspect selfstack-env-test --format {{.Config.Env}}`.quiet().text();
      if (!env.includes("FORWARDED_VALUE=forwarded-value-123")) {
        throw new Error(`expected forwarded env var not found in container env: ${env}`);
      }
    });
  } finally {
    if (previousValue === undefined) {
      delete process.env.GITAINER_TEST_FORWARD_VAR;
    } else {
      process.env.GITAINER_TEST_FORWARD_VAR = previousValue;
    }
    await $`docker rm -f selfstack-env-test`.quiet().catch(() => {});
    await $`docker rm -f ${containerName}`.quiet().catch(() => {});
  }
}, { timeout: 60_000 });

test("composeSelfUpdate rejects a stack with a #@ remote host comment", async () => {
  const docker = new DockerClient();
  const compose = `#@ root@192.0.2.1:/opt/stack\nservices:\n  app:\n    image: alpine`;

  await expect(docker.composeSelfUpdate(compose, "remotetest")).rejects.toThrow("cannot use a remote host");
});

test("composeSelfUpdate fails fast when a same-named sibling is already in flight", async () => {
  const docker = new DockerClient();
  const stackName = "collisiontest";
  const containerName = docker.selfUpdateContainerName(stackName);

  await $`docker rm -f ${containerName}`.quiet().catch(() => {});
  await $`docker run -d --name ${containerName} alpine sleep 60`.quiet();

  try {
    const compose = `services:\n  app:\n    image: alpine\n    command: sleep infinity\n    stop_grace_period: 0s`;
    await expect(docker.composeSelfUpdate(compose, stackName)).rejects.toThrow();
  } finally {
    await $`docker rm -f ${containerName}`.quiet().catch(() => {});
  }
}, { timeout: 30_000 });

test("push self-stack: routes to composeSelfUpdate and protects it from DELETE", async () => {
  const { testRoot, port, gitainer, postHelper, cleanup } = getTestSetup("selfstack");

  try {
    await gitainer.initRepo();
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    const stackRoot = testRoot + "/client/docker/stacks/selfstack";
    mkdirSync(stackRoot, { recursive: true });
    await $`cp ${TEST_COMPOSE_ROOT}/self-stack-compose.yaml ${stackRoot}/docker-compose.yaml`;

    let postPromise = new Promise((resolve, reject) => {
      postHelper.callback = (body) => {
        if (body.msg?.startsWith("Synthesis succeeded for 1 stack(s)")) {
          setTimeout(() => resolve(null), 1000);
        } else {
          setTimeout(() => reject(body), 1000);
        }
      }
    });

    await $`git add . && git commit -m "add self stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    // composeSelfUpdate's recreate runs asynchronously in a detached sibling
    await waitFor(async () => {
      await $`docker inspect selfstack-app-test --format {{.State.Running}}`.quiet().text();
    });

    // deleting the self stack must be refused, not executed
    postPromise = new Promise((resolve, reject) => {
      postHelper.callback = (body) => {
        if (body.warnings?.some(w => w.includes("Refusing to delete self-stack"))) {
          setTimeout(() => resolve(null), 1000);
        } else {
          setTimeout(() => reject(body), 1000);
        }
      }
    });

    rmSync(stackRoot, { recursive: true });
    await $`git add . && git commit -m "delete self stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    // container must still be running - the delete was a no-op
    await $`docker inspect selfstack-app-test --format {{.State.Running}}`.quiet().text();
  } finally {
    await $`docker rm -f selfstack-app-test`.quiet().catch(() => {});
    await $`docker rm -f ${gitainer.docker.selfUpdateContainerName("selfstack")}`.quiet().catch(() => {});
    await cleanup();
  }
}, { timeout: 100_000 });

test("self-update: the recreate trigger is deferred past the push response, and pushes stay locked out until it runs", async () => {
  const { testRoot, port, gitainer, postHelper, cleanup } = getTestSetup("selfstack");

  try {
    await gitainer.initRepo();

    // Stub out the actual container recreate so this test exercises the deferral/locking
    // behavior in GitainerServer, not real docker/compose - and so we can hold the trigger
    // open on demand to observe the lock while it's "in flight".
    let triggerInvoked = false;
    let releaseTrigger!: () => void;
    const triggerGate = new Promise<void>(resolve => { releaseTrigger = resolve; });
    (gitainer.docker as any).prepareSelfUpdate = async (_compose: string, _stackName: string) => {
      return async () => {
        triggerInvoked = true;
        await triggerGate;
      };
    };

    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    const stackRoot = testRoot + "/client/docker/stacks/selfstack";
    mkdirSync(stackRoot, { recursive: true });
    await $`cp ${TEST_COMPOSE_ROOT}/self-stack-compose.yaml ${stackRoot}/docker-compose.yaml`;

    const postPromise = new Promise((resolve, reject) => {
      postHelper.callback = (body) => {
        if (body.msg?.startsWith("Synthesis succeeded for 1 stack(s)")) {
          resolve(null);
        } else {
          reject(body);
        }
      }
    });

    // The push itself must complete successfully - and, per the fix, must be able to complete
    // even though the (stubbed) recreate hasn't run yet.
    await $`git add . && git commit -m "add self stack" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    // The webhook (sent from inside synthesisTime, before the trigger is deferred) fires
    // before the trigger runs, so by the time we get here the trigger may not have been
    // invoked yet - wait for Node's 'finish'/'close' handling in GitainerServer to reach it.
    await waitFor(async () => {
      if (!triggerInvoked) throw new Error("self-update trigger has not been invoked yet");
    });

    // The trigger is invoked but gated open (simulating the recreate still running) - the
    // push lock must still be held so a concurrent push can't race the recreate.
    expect((gitainer as any).synthesisRunning).toBe(true);

    let secondPushFailed = false;
    try {
      await $`git commit --allow-empty -m "second push while locked" && git push`.cwd(testRoot + "/client/docker");
    } catch (e) {
      secondPushFailed = true;
    }
    expect(secondPushFailed).toBe(true);

    // Let the (stubbed) recreate finish - the lock must be released once it does.
    releaseTrigger();
    await waitFor(async () => {
      if ((gitainer as any).synthesisRunning) throw new Error("push lock was not released after the trigger completed");
    });

    // The previously-rejected commit is still queued locally - pushing it now must succeed.
    await $`git push`.cwd(testRoot + "/client/docker");
  } finally {
    await cleanup();
  }
}, { timeout: 30_000 });

test("push with both a normal stack and the self-stack: self-stack is processed last but both succeed", async () => {
  const { testRoot, port, gitainer, postHelper, cleanup } = getTestSetup("selfstack");

  try {
    await gitainer.initRepo();
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    const selfRoot = testRoot + "/client/docker/stacks/selfstack";
    const normalRoot = testRoot + "/client/docker/stacks/normalstack";
    mkdirSync(selfRoot, { recursive: true });
    mkdirSync(normalRoot, { recursive: true });

    await $`cp ${TEST_COMPOSE_ROOT}/self-stack-compose.yaml ${selfRoot}/docker-compose.yaml`;
    const normalCompose = `services:\n  app:\n    image: alpine\n    command: sleep infinity\n    container_name: normalstack-app-test\n    stop_grace_period: 0s`;
    await $`echo "${normalCompose}" > ${normalRoot}/docker-compose.yaml`;

    const postPromise = new Promise((resolve, reject) => {
      postHelper.callback = (body) => {
        if (body.msg?.startsWith("Synthesis succeeded for 2 stack(s)")) {
          setTimeout(() => resolve(null), 1000);
        } else {
          setTimeout(() => reject(body), 1000);
        }
      }
    });

    await $`git add . && git commit -m "add both stacks" && git push`.cwd(testRoot + "/client/docker");
    await postPromise;

    // the normal stack is deployed synchronously, in-process
    await $`docker inspect normalstack-app-test --format {{.State.Running}}`.quiet().text();

    // the self-stack's recreate runs asynchronously via the sibling
    await waitFor(async () => {
      await $`docker inspect selfstack-app-test --format {{.State.Running}}`.quiet().text();
    });
  } finally {
    await $`docker rm -f normalstack-app-test`.quiet().catch(() => {});
    await $`docker rm -f selfstack-app-test`.quiet().catch(() => {});
    await $`docker rm -f ${gitainer.docker.selfUpdateContainerName("selfstack")}`.quiet().catch(() => {});
    await cleanup();
  }
}, { timeout: 100_000 });
