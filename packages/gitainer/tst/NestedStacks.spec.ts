import { expect, test } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { WebhookServer } from "../src/webhooks/WebhookServer";
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

let testCounter = 0;

function getTestSetup() {
  testCounter++;
  const testId = `test_${testCounter}_${Date.now()}`;
  const testRoot = `./tst/resources_nested_${testId}`;
  const port = 4000 + testCounter * 2;
  const webhookPort = 4000 + testCounter * 2 + 1;

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

// resolves with the next POST_WEBHOOK payload, whether the synthesis succeeded or not
function nextSynthesis(postHelper: NotifyWebhookTestHelper): Promise<any> {
  return new Promise((resolve) => {
    postHelper.callback = (body: any) => setTimeout(() => resolve(body), 1000);
  });
}

// records the compose calls of a synthesis instead of running them
function stubDockerCalls(docker: DockerClient): string[] {
  const calls: string[] = [];
  (docker as any).composePull = async (composeString: string, stackName: string) => {
    calls.push(`composePull:${stackName}`);
  };
  (docker as any).composeDown = async (composeString: string, stackName: string) => {
    calls.push(`composeDown:${stackName}`);
  };
  (docker as any).composeUpdate = async (composeString: string, stackName: string) => {
    calls.push(`composeUpdate:${stackName}`);
  };
  return calls;
}

async function writeStack(testRoot: string, stackName: string, containerName: string) {
  const stackRoot = `${testRoot}/client/docker/stacks/${stackName}`;
  mkdirSync(stackRoot, { recursive: true });
  await Bun.write(`${stackRoot}/docker-compose.yaml`, `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: ${containerName}
    stop_grace_period: 0s
`);
}

test("a stack's name is its folders under stacks/ joined with dashes", () => {
  expect(GitainerServer.stackNameOf("stacks/web/docker-compose.yaml")).toBe("web");
  expect(GitainerServer.stackNameOf("stacks/host/web/docker-compose.yml")).toBe("host-web");
  expect(GitainerServer.stackNameOf("stacks/host-web/docker-compose.yaml")).toBe("host-web");
  expect(GitainerServer.stackNameOf("stacks/host/group/web/docker-compose.yaml")).toBe("host-group-web");

  expect(GitainerServer.stackNameOf("stacks/docker-compose.yaml")).toBeUndefined();
  expect(GitainerServer.stackNameOf("stacks/host/web/NODEPLOYdocker-compose.yaml")).toBeUndefined();
  expect(GitainerServer.stackNameOf("stacks/host/web/docker-compose.yaml.bak")).toBeUndefined();
  expect(GitainerServer.stackNameOf("other/stacks/web/docker-compose.yaml")).toBeUndefined();
});

test("a stack in a folder is deployed and addressed by its flat name", async () => {
  const { testRoot, port, gitainer, postHelper, cleanup } = getTestSetup();
  const containerName = `nested-real-${Date.now()}`;
  try {
    const bareRepo = await gitainer.initRepo();
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    await writeStack(testRoot, "nestedhost/web", containerName);
    const synthesis = nextSynthesis(postHelper);
    await $`git add . && git commit -m "add nested stack" && git push`.cwd(testRoot + "/client/docker");
    expect((await synthesis).msg).toBe("Synthesis succeeded for 1 stack(s): stacks/nestedhost/web/docker-compose.yaml");

    const project = await $`docker inspect ${containerName} --format ${'{{ index .Config.Labels "com.docker.compose.project" }}'}`.text();
    expect(project.trim()).toBe("nestedhost-web");

    expect(await bareRepo.getAllStackNames()).toEqual(["nestedhost-web"]);
    expect(await bareRepo.getStack("nestedhost-web")).toContain(containerName);
    expect(await bareRepo.getStack("nestedhost/web")).toBeUndefined();
    expect(existsSync(`${testRoot}/backend/stacks/stacks/nestedhost-web/docker-compose.yaml`)).toBe(true);

    const webhook = new WebhookServer(gitainer.docker, bareRepo, gitainer);
    const listed = await (await webhook.app.request("/api/stacks")).json();
    expect(listed.map((stack: any) => [stack.name, stack.containers.length])).toEqual([["nestedhost-web", 1]]);
    expect((await webhook.app.request("/api/stacks/nestedhost/web")).status).toBe(404);

    const down = await webhook.app.request("/api/stacks/nestedhost-web/down", { method: "POST" });
    expect(down.status).toBe(200);
    expect((await $`docker ps -aq --filter name=${containerName}`.text()).trim()).toBe("");
  } finally {
    await $`docker rm -f ${containerName}`.quiet().nothrow();
    await $`docker network rm nestedhost-web_default`.quiet().nothrow();
    await cleanup();
  }
}, { timeout: 100_000 });

test("folders can be nested to any depth", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    const bareRepo = await gitainer.initRepo();
    const calls = stubDockerCalls(docker);
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    await writeStack(testRoot, "site/host/group/web", "deep-app");
    const synthesis = nextSynthesis(postHelper);
    await $`git add . && git commit -m "add deep stack" && git push`.cwd(testRoot + "/client/docker");
    expect((await synthesis).msg).toBe("Synthesis succeeded for 1 stack(s): stacks/site/host/group/web/docker-compose.yaml");

    expect(calls).toEqual(["composePull:site-host-group-web", "composeUpdate:site-host-group-web"]);
    expect(await bareRepo.getAllStackNames()).toEqual(["site-host-group-web"]);
    expect(await bareRepo.getStack("site-host-group-web")).toContain("deep-app");
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("moving a stack to a folder of another name downs it under its old name and deploys the new one", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();
    const calls = stubDockerCalls(docker);
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    await writeStack(testRoot, "nestedmove", "nestedmove-app");
    let synthesis = nextSynthesis(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(testRoot + "/client/docker");
    await synthesis;
    calls.length = 0;

    synthesis = nextSynthesis(postHelper);
    await $`mkdir stacks/host && git mv stacks/nestedmove stacks/host/nestedmove`.cwd(testRoot + "/client/docker");
    await $`git commit -m "move stack" && git push`.cwd(testRoot + "/client/docker");
    expect((await synthesis).msg).toBe("Synthesis succeeded for 1 stack(s): stacks/host/nestedmove/docker-compose.yaml");

    expect(calls).toEqual(["composePull:host-nestedmove", "composeDown:nestedmove", "composeUpdate:host-nestedmove"]);
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("moving a stack into the folders its name spells doesn't redeploy it", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    await gitainer.initRepo();
    const calls = stubDockerCalls(docker);
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    await writeStack(testRoot, "samehost-web", "samehost-app");
    let synthesis = nextSynthesis(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(testRoot + "/client/docker");
    await synthesis;
    calls.length = 0;

    synthesis = nextSynthesis(postHelper);
    await $`mkdir stacks/samehost && git mv stacks/samehost-web stacks/samehost/web`.cwd(testRoot + "/client/docker");
    await $`git commit -m "move stack" && git push`.cwd(testRoot + "/client/docker");
    const result = await synthesis;

    expect(result.commentOnlyStacks).toEqual(["samehost-web"]);
    expect(calls).toEqual([]);
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });

test("a stack moved between host-web and host/web with its content changed stays up on its volumes", async () => {
  const { testRoot, port, gitainer, postHelper, cleanup } = getTestSetup();
  const containerName = `nested-keep-${Date.now()}`;
  const volume = "keephost-web_data";
  const repo = testRoot + "/client/docker";
  const writeCompose = (stackName: string, comment: string) => {
    mkdirSync(`${repo}/stacks/${stackName}`, { recursive: true });
    return Bun.write(`${repo}/stacks/${stackName}/docker-compose.yaml`, `${comment}
services:
  app:
    image: alpine
    command: sleep infinity
    container_name: ${containerName}
    stop_grace_period: 0s
    volumes:
      - data:/data
volumes:
  data:
`);
  };
  const running = async () => (await $`docker ps -q --filter name=${containerName}`.text()).trim() !== "";
  const project = async () => (await $`docker inspect ${containerName} --format ${'{{ index .Config.Labels "com.docker.compose.project" }}'}`.text()).trim();

  try {
    await gitainer.initRepo();
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    await writeCompose("keephost-web", "# one");
    let synthesis = nextSynthesis(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(repo);
    expect((await synthesis).err).toBeUndefined();
    await $`docker exec ${containerName} sh -c "echo kept > /data/marker"`;

    // moved with its content changed, which git reports as a delete and an add
    synthesis = nextSynthesis(postHelper);
    await $`git rm -rq stacks/keephost-web`.cwd(repo);
    await writeCompose("keephost/web", "# two\n".repeat(40));
    await $`git add . && git commit -m "move into a folder" && git push`.cwd(repo);
    expect((await synthesis).changes.map((change: any) => change.type)).toEqual(["D", "A"]);
    expect(await project()).toBe("keephost-web");
    expect((await $`docker exec ${containerName} cat /data/marker`.text()).trim()).toBe("kept");

    // and back, where git lists the add first
    synthesis = nextSynthesis(postHelper);
    await $`git rm -rq stacks/keephost`.cwd(repo);
    await writeCompose("keephost-web", "# three\n".repeat(80));
    await $`git add . && git commit -m "move back" && git push`.cwd(repo);
    expect((await synthesis).changes.map((change: any) => change.type)).toEqual(["D", "A"]);
    expect(await running()).toBe(true);
    expect((await $`docker exec ${containerName} cat /data/marker`.text()).trim()).toBe("kept");

  } finally {
    await $`docker rm -f ${containerName}`.quiet().nothrow();
    await $`docker volume rm ${volume}`.quiet().nothrow();
    // the test image's dockerd only has room for so many networks
    await $`docker network rm keephost-web_default`.quiet().nothrow();
    await cleanup();
  }
}, { timeout: 200_000 });

test("a push is rejected when two folders would be the same stack", async () => {
  const { testRoot, port, docker, gitainer, postHelper, cleanup } = getTestSetup();
  try {
    const bareRepo = await gitainer.initRepo();
    const calls = stubDockerCalls(docker);
    gitainer.listen(port);
    await cloneAndConfigRepo(testRoot, port);

    await writeStack(testRoot, "clash/web", "clash-one");
    let synthesis = nextSynthesis(postHelper);
    await $`git add . && git commit -m "add stack" && git push`.cwd(testRoot + "/client/docker");
    await synthesis;
    calls.length = 0;

    await writeStack(testRoot, "clash-web", "clash-two");
    synthesis = nextSynthesis(postHelper);
    await $`git add . && git commit -m "add clashing stack" && git push`.cwd(testRoot + "/client/docker");
    const result = await synthesis;

    expect(result.err).toContain(`stacks/clash-web and stacks/clash/web would both be the stack "clash-web": rename one of them`);
    expect(result.failedStack).toBe("stacks/clash-web/docker-compose.yaml");
    expect(calls).toEqual([]);
    // the commit was removed
    expect(await bareRepo.getStackFolders("clash-web")).toEqual(["stacks/clash/web"]);
  } finally {
    await cleanup();
  }
}, { timeout: 100_000 });
