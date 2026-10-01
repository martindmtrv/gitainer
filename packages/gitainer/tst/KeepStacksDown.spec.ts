import { afterEach, expect, test } from "bun:test";
import { DockerClient, disabledFlagVariables, isStackDisabled } from "../src/docker/DockerClient";
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

test("isStackDisabled reads the top-level flag from the parsed YAML", async () => {
  const services = "services:\n  app:\n    image: alpine\n";
  expect(await isStackDisabled(services)).toBe(false);
  expect(await isStackDisabled(`x-gitainer-disabled: true\n${services}`)).toBe(true);
  expect(await isStackDisabled(`x-gitainer-disabled: false\n${services}`)).toBe(false);
  expect(await isStackDisabled(`x-gitainer-disabled:\n${services}`)).toBe(false);
  // commented out, or only in a comment, doesn't count
  expect(await isStackDisabled(`# x-gitainer-disabled: true\n${services}`)).toBe(false);
  expect(await isStackDisabled(`#x-gitainer-disabled: true\n${services}`)).toBe(false);
  expect(await isStackDisabled(`x-gitainer-disabled: false # true\n${services}`)).toBe(false);
  expect(await isStackDisabled(`${services}    # x-gitainer-disabled: true\n`)).toBe(false);
  // only the top level counts
  expect(await isStackDisabled(`services:\n  app:\n    image: alpine\n    x-gitainer-disabled: true\n`)).toBe(false);
  // works after the remote host comment
  expect(await isStackDisabled(`#@ssh://user@host\nx-gitainer-disabled: true\n${services}`)).toBe(true);
});

test("isStackDisabled rejects a hard-coded value that isn't a boolean", async () => {
  const services = "services:\n  app:\n    image: alpine\n";
  await expect(isStackDisabled(`x-gitainer-disabled: "true"\n${services}`)).rejects.toThrow('x-gitainer-disabled must be true or false, got "true"');
  await expect(isStackDisabled(`x-gitainer-disabled: yes\n${services}`)).rejects.toThrow("x-gitainer-disabled must be true or false");
  await expect(isStackDisabled(`x-gitainer-disabled: 1\n${services}`)).rejects.toThrow("x-gitainer-disabled must be true or false");
});

test("isStackDisabled interpolates a flag set from an env var", async () => {
  const services = "services:\n  app:\n    image: alpine\n";
  const flag = (value: string) => `x-gitainer-disabled: ${value}\n${services}`;

  process.env[ENV_KEY] = "true";
  expect(await isStackDisabled(flag(`\${${ENV_KEY}}`))).toBe(true);
  expect(await isStackDisabled(flag(`$${ENV_KEY}`))).toBe(true);
  expect(await isStackDisabled(flag(`"\${${ENV_KEY}:-false}"`))).toBe(true);
  // a commented-out flag still has no effect
  expect(await isStackDisabled(`# ${flag(`\${${ENV_KEY}}`)}`)).toBe(false);

  process.env[ENV_KEY] = "false";
  expect(await isStackDisabled(flag(`\${${ENV_KEY}}`))).toBe(false);
  expect(await isStackDisabled(flag(`\${${ENV_KEY}:-true}`))).toBe(false);

  // the rest of the stack isn't interpolated, so a required variable elsewhere doesn't matter
  process.env[ENV_KEY] = "true";
  expect(await isStackDisabled(`${flag(`\${${ENV_KEY}}`)}    command: \${GITAINER_KEEP_DOWN_UNSET:?required}\n`)).toBe(true);
});

test("isStackDisabled uses the default of an unset env var, and an unset one with no default isn't disabled", async () => {
  const services = "services:\n  app:\n    image: alpine\n";
  expect(await isStackDisabled(`x-gitainer-disabled: \${${ENV_KEY}:-false}\n${services}`)).toBe(false);
  expect(await isStackDisabled(`x-gitainer-disabled: \${${ENV_KEY}:-true}\n${services}`)).toBe(true);
  expect(await isStackDisabled(`x-gitainer-disabled: \${${ENV_KEY}}\n${services}`)).toBe(false);
});

test("isStackDisabled rejects an env var that isn't true or false, without echoing its value", async () => {
  process.env[ENV_KEY] = "s3cret-yes";
  const result = isStackDisabled(`x-gitainer-disabled: \${${ENV_KEY}}\nservices:\n  app:\n    image: alpine\n`);
  await expect(result).rejects.toThrow(`x-gitainer-disabled (\${${ENV_KEY}}) must interpolate to true or false`);
  await expect(result).rejects.not.toThrow("s3cret-yes");
});

test("disabledFlagVariables lists the variables the flag reads", async () => {
  const services = `services:\n  app:\n    image: alpine:\${OTHER_VAR}\n`;
  expect(await disabledFlagVariables(`x-gitainer-disabled: \${${ENV_KEY}:-false}\n${services}`)).toEqual([ENV_KEY]);
  expect(await disabledFlagVariables(`x-gitainer-disabled: true\n${services}`)).toEqual([]);
  expect(await disabledFlagVariables(`# x-gitainer-disabled: \${${ENV_KEY}}\n${services}`)).toEqual([]);
  expect(await disabledFlagVariables(services)).toEqual([]);
});

test("an env var flipping x-gitainer-disabled downs the stack, brings it back up, and downs it again", async () => {
  const { gitainer, nextNotification, push, writeStack } = await setup(["keepdown-env"]);
  const file = "stacks/keepdown-env/docker-compose.yaml";

  writeStack("keepdown-env", stackCompose("keepdown-env", "v1", `x-gitainer-disabled: \${${ENV_KEY}:-false}\n`));
  // the variable is unset, so its default applies
  const add = await push("add stack");
  expect(add.err).toBeUndefined();
  expect(add.disabledStacks).toBeUndefined();
  expect(await runningLabel("keepdown-env")).toBe("v1");

  const envUpdate = async (value: string) => {
    process.env[ENV_KEY] = value;
    const notification = nextNotification();
    await gitainer.checkForStackEnvUpdate();
    return await notification;
  };

  const disable = await envUpdate("true");
  expect(disable.title).toBe("Gitainer: Env Update");
  expect(disable.err).toBeUndefined();
  expect(disable.disabledStacks).toEqual(["keepdown-env"]);
  expect(disable.msg).toBe(`Synthesis succeeded for 1 stack(s): ${file}. Disabled with x-gitainer-disabled (not deployed): keepdown-env`);
  expect(await runningLabel("keepdown-env")).toBeUndefined();

  // the stack has no containers by now, but the not-deployed skip doesn't apply to its own flag
  const enable = await envUpdate("false");
  expect(enable.err).toBeUndefined();
  expect(enable.disabledStacks).toBeUndefined();
  expect(enable.skippedStacks).toBeUndefined();
  expect(enable.msg).toBe(`Synthesis succeeded for 1 stack(s): ${file}`);
  expect(await runningLabel("keepdown-env")).toBe("v1");

  const disableAgain = await envUpdate("true");
  expect(disableAgain.err).toBeUndefined();
  expect(disableAgain.disabledStacks).toEqual(["keepdown-env"]);
  expect(await runningLabel("keepdown-env")).toBeUndefined();
}, { timeout: 100_000 });

test("a downed stack is still skipped when the changed env var isn't the one its flag reads", async () => {
  const { docker, gitainer, nextNotification, push, writeStack } = await setup(["keepdown-other"]);
  const OTHER_KEY = `${ENV_KEY}_OTHER`;
  process.env[OTHER_KEY] = "v1";
  cleanups.push(async () => { delete process.env[OTHER_KEY]; });

  writeStack("keepdown-other", stackCompose("keepdown-other", `"\${${OTHER_KEY}}"`, `x-gitainer-disabled: \${${ENV_KEY}:-false}\n`));
  expect((await push("add stack")).err).toBeUndefined();
  expect(await runningLabel("keepdown-other")).toBe("v1");

  await docker.composeDown(await gitainer.bareRepo.getStack("keepdown-other") as string, "keepdown-other");

  process.env[OTHER_KEY] = "v2";
  const notification = nextNotification();
  await gitainer.checkForStackEnvUpdate();
  expect((await notification).skippedStacks).toEqual(["keepdown-other"]);
  expect(await runningLabel("keepdown-other")).toBeUndefined();
}, { timeout: 100_000 });

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
