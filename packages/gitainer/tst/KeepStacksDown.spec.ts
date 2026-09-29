import { afterEach, expect, test } from "bun:test";
import { DockerClient, isStackDisabled } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

const ENV_KEY = "GITAINER_KEEP_DOWN_TEST_VAR";

let testCounter = 0;
let cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  delete process.env[ENV_KEY];
  for (const cleanup of cleanups) {
    await cleanup();
  }
  cleanups = [];
});

async function setup(containers: string[]) {
  testCounter++;
  const testRoot = `./tst/resources_keepdown_${testCounter}_${Date.now()}`;
  const port = 3800 + testCounter * 2;
  const webhookPort = 3800 + testCounter * 2 + 1;

  rmSync(testRoot, { recursive: true, force: true });
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

  cleanups.push(async () => {
    await gitainer.close();
    postHelper.listener.stop(true);
    for (const container of containers) {
      await $`docker rm -f ${container}`.quiet().nothrow();
    }
    rmSync(testRoot, { recursive: true, force: true });
  });

  await gitainer.initRepo();
  gitainer.listen(port);

  const clientRoot = testRoot + "/client/docker";
  await $`git clone http://localhost:${port}/docker.git`.cwd(testRoot + "/client").quiet();
  await $`git config user.name "test" && git config user.email "test@test.com"`.cwd(clientRoot);

  // resolves with the next POST_WEBHOOK notification
  const nextNotification = () => new Promise<any>(resolve => {
    postHelper.callback = body => resolve(body);
  });

  const push = async (message: string) => {
    const notification = nextNotification();
    await $`git add . && git commit -m ${message} && git push`.cwd(clientRoot).quiet();
    return await notification;
  };

  const writeStack = (stackName: string, content: string) => {
    mkdirSync(`${clientRoot}/stacks/${stackName}`, { recursive: true });
    writeFileSync(`${clientRoot}/stacks/${stackName}/docker-compose.yaml`, content);
  };

  return { docker, gitainer, clientRoot, nextNotification, push, writeStack };
}

function stackCompose(containerName: string, label: string, header = "") {
  return `${header}services:
  app:
    image: alpine
    command: sleep infinity
    container_name: ${containerName}
    stop_grace_period: 0s
    labels:
      test.value: ${label}
`;
}

async function runningLabel(containerName: string): Promise<string | undefined> {
  const output = await $`docker inspect ${containerName} --format '{{.State.Running}} {{index .Config.Labels "test.value"}}'`.nothrow().quiet().text();
  const [running, label] = output.trim().split(" ");
  return running === "true" ? label : undefined;
}

test("an env change skips a downed stack and says so in the notification", async () => {
  const { docker, gitainer, nextNotification, push, writeStack } = await setup(["skipenv-up", "skipenv-down"]);
  process.env[ENV_KEY] = "v1";

  writeStack("skipenv-up", stackCompose("skipenv-up", `"\${${ENV_KEY}}"`));
  writeStack("skipenv-down", stackCompose("skipenv-down", `"\${${ENV_KEY}}"`));
  expect((await push("add stacks")).err).toBeUndefined();
  expect(await runningLabel("skipenv-down")).toBe("v1");

  await docker.composeDown(await gitainer.bareRepo.getStack("skipenv-down") as string, "skipenv-down");

  process.env[ENV_KEY] = "v2";
  const notification = nextNotification();
  await gitainer.checkForStackEnvUpdate();
  const body = await notification;

  expect(body.title).toBe("Gitainer: Env Update");
  expect(body.err).toBeUndefined();
  expect(body.skippedStacks).toEqual(["skipenv-down"]);
  expect(body.msg).toBe("Synthesis succeeded for 1 stack(s): stacks/skipenv-up/docker-compose.yaml. Skipped 1 stack(s) that aren't deployed: skipenv-down");
  expect(await runningLabel("skipenv-up")).toBe("v2");
  expect(await runningLabel("skipenv-down")).toBeUndefined();
}, { timeout: 100_000 });

test("a pushed fragment change skips a downed stack, but a push to the stack itself deploys it", async () => {
  const { docker, gitainer, clientRoot, push, writeStack } = await setup(["skipfrag"]);
  const header = "#! fragments/skipfrag.yaml\n";

  mkdirSync(`${clientRoot}/fragments`, { recursive: true });
  writeFileSync(`${clientRoot}/fragments/skipfrag.yaml`, "x-skipfrag: &skipfrag\n  a: v1\n");
  writeStack("skipfrag", stackCompose("skipfrag", "v1", header));
  expect((await push("add stack")).err).toBeUndefined();
  expect(await runningLabel("skipfrag")).toBe("v1");

  await docker.composeDown(await gitainer.bareRepo.getStack("skipfrag") as string, "skipfrag");

  writeFileSync(`${clientRoot}/fragments/skipfrag.yaml`, "x-skipfrag: &skipfrag\n  a: v2\n");
  const fragmentPush = await push("change fragment");
  expect(fragmentPush.err).toBeUndefined();
  expect(fragmentPush.skippedStacks).toEqual(["skipfrag"]);
  expect(fragmentPush.msg).toBe("Synthesis succeeded for 0 stack(s). Skipped 1 stack(s) that aren't deployed: skipfrag");
  expect(await runningLabel("skipfrag")).toBeUndefined();

  // changing the stack's own compose file (with the fragment too) is a direct change: deployed
  writeFileSync(`${clientRoot}/fragments/skipfrag.yaml`, "x-skipfrag: &skipfrag\n  a: v3\n");
  writeStack("skipfrag", stackCompose("skipfrag", "v3", header));
  const stackPush = await push("change stack");
  expect(stackPush.err).toBeUndefined();
  expect(stackPush.skippedStacks).toBeUndefined();
  expect(await runningLabel("skipfrag")).toBe("v3");
}, { timeout: 100_000 });

test("isStackDisabled reads the top-level flag from the parsed YAML", () => {
  const services = "services:\n  app:\n    image: alpine\n";
  expect(isStackDisabled(services)).toBe(false);
  expect(isStackDisabled(`x-gitainer-disabled: true\n${services}`)).toBe(true);
  expect(isStackDisabled(`x-gitainer-disabled: false\n${services}`)).toBe(false);
  expect(isStackDisabled(`x-gitainer-disabled:\n${services}`)).toBe(false);
  // commented out, or only in a comment, doesn't count
  expect(isStackDisabled(`# x-gitainer-disabled: true\n${services}`)).toBe(false);
  expect(isStackDisabled(`#x-gitainer-disabled: true\n${services}`)).toBe(false);
  expect(isStackDisabled(`x-gitainer-disabled: false # true\n${services}`)).toBe(false);
  expect(isStackDisabled(`${services}    # x-gitainer-disabled: true\n`)).toBe(false);
  // only the top level counts
  expect(isStackDisabled(`services:\n  app:\n    image: alpine\n    x-gitainer-disabled: true\n`)).toBe(false);
  // works after the remote host comment
  expect(isStackDisabled(`#@ssh://user@host\nx-gitainer-disabled: true\n${services}`)).toBe(true);
});

test("isStackDisabled rejects a value that isn't a boolean", () => {
  const services = "services:\n  app:\n    image: alpine\n";
  expect(() => isStackDisabled(`x-gitainer-disabled: "true"\n${services}`)).toThrow('x-gitainer-disabled must be true or false, got "true"');
  expect(() => isStackDisabled(`x-gitainer-disabled: yes\n${services}`)).toThrow("x-gitainer-disabled must be true or false");
  expect(() => isStackDisabled(`x-gitainer-disabled: 1\n${services}`)).toThrow("x-gitainer-disabled must be true or false");
});

test("x-gitainer-disabled downs a running stack, and commenting it out deploys it again", async () => {
  const { push, writeStack } = await setup(["keepdown-flag"]);

  writeStack("keepdown-flag", stackCompose("keepdown-flag", "v1"));
  expect((await push("add stack")).err).toBeUndefined();
  expect(await runningLabel("keepdown-flag")).toBe("v1");

  writeStack("keepdown-flag", stackCompose("keepdown-flag", "v2", "x-gitainer-disabled: true\n"));
  const disable = await push("disable stack");
  expect(disable.err).toBeUndefined();
  expect(disable.disabledStacks).toEqual(["keepdown-flag"]);
  expect(disable.msg).toBe("Synthesis succeeded for 1 stack(s): stacks/keepdown-flag/docker-compose.yaml. Disabled with x-gitainer-disabled (not deployed): keepdown-flag");
  expect(await runningLabel("keepdown-flag")).toBeUndefined();

  writeStack("keepdown-flag", stackCompose("keepdown-flag", "v3", "# x-gitainer-disabled: true\n"));
  const enable = await push("re-enable stack");
  expect(enable.err).toBeUndefined();
  expect(enable.disabledStacks).toBeUndefined();
  expect(await runningLabel("keepdown-flag")).toBe("v3");
}, { timeout: 100_000 });

test("a new stack added with x-gitainer-disabled is neither pulled nor deployed", async () => {
  const { push, writeStack } = await setup(["keepdown-new"]);

  // an image that can't be pulled proves the disabled stack isn't pulled
  writeStack("keepdown-new", `x-gitainer-disabled: true
services:
  app:
    image: gitainer-test/does-not-exist:never
    container_name: keepdown-new
`);
  const body = await push("add disabled stack");
  expect(body.err).toBeUndefined();
  expect(body.disabledStacks).toEqual(["keepdown-new"]);
  expect(await runningLabel("keepdown-new")).toBeUndefined();
}, { timeout: 100_000 });

test("an invalid x-gitainer-disabled value rejects the push", async () => {
  const { push, writeStack } = await setup(["keepdown-invalid"]);

  writeStack("keepdown-invalid", stackCompose("keepdown-invalid", "v1", 'x-gitainer-disabled: "true"\n'));
  const body = await push("add stack with a bad flag");
  expect(body.err).toContain('x-gitainer-disabled must be true or false, got "true"');
  expect(await runningLabel("keepdown-invalid")).toBeUndefined();
}, { timeout: 100_000 });
