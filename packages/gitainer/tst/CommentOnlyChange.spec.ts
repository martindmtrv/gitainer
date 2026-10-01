import { afterEach, expect, test } from "bun:test";
import { DockerClient, isSameComposeContent } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { NotifyWebhookTestHelper } from "./helper/NotifyWebhookTestHelper";

const ENV_KEY = "GITAINER_COMMENT_ONLY_TEST_VAR";

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
  const testRoot = `./tst/resources_commentonly_${testCounter}_${Date.now()}`;
  const port = 3900 + testCounter * 2;
  const webhookPort = 3900 + testCounter * 2 + 1;

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

  const push = async (message: string) => {
    // resolves with the push's POST_WEBHOOK notification
    const notification = new Promise<any>(resolve => {
      postHelper.callback = body => resolve(body);
    });
    await $`git add . && git commit -m ${message} && git push`.cwd(clientRoot).quiet();
    return await notification;
  };

  const writeFile = (path: string, content: string) => {
    mkdirSync(`${clientRoot}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true });
    writeFileSync(`${clientRoot}/${path}`, content);
  };

  return { docker, gitainer, clientRoot, push, writeFile };
}

function stackCompose(containerName: string, { header = "", comment = "a comment", extra = "" } = {}) {
  return `${header}# ${comment}
services:
  app:
    image: alpine
    command: sleep infinity # ${comment}
    container_name: ${containerName}
    stop_grace_period: 0s
${extra}`;
}

// changes whenever the container is recreated
async function containerId(containerName: string): Promise<string> {
  return (await $`docker inspect ${containerName} --format '{{.Id}}'`.nothrow().quiet().text()).trim();
}

test("isSameComposeContent ignores comments and formatting, but not directives or content", () => {
  const base = "services:\n  app:\n    image: alpine\n    command: echo '# not a comment'\n";

  expect(isSameComposeContent(base, base)).toBe(true);
  expect(isSameComposeContent(base, `# a comment\n\n${base}    # another\n`)).toBe(true);
  expect(isSameComposeContent(base, base.replace("image: alpine", "image: alpine # pinned later"))).toBe(true);
  expect(isSameComposeContent(base, base.replace("image: alpine", "image:   'alpine'"))).toBe(true);

  // a # inside a quoted string or a block scalar is content
  expect(isSameComposeContent(base, base.replace("# not a comment", "# still not a comment"))).toBe(false);
  const script = (line: string) => `services:\n  app:\n    image: alpine\n    command: |\n      # ${line}\n      echo hi\n`;
  expect(isSameComposeContent(script("one"), script("two"))).toBe(false);

  expect(isSameComposeContent(base, base.replace("image: alpine", "image: alpine:3"))).toBe(false);
  expect(isSameComposeContent(base, `x-gitainer-disabled: true\n${base}`)).toBe(false);

  // the #@ remote host is a directive
  expect(isSameComposeContent(base, `#@ root@host\n${base}`)).toBe(false);
  expect(isSameComposeContent(`#@ root@host\n${base}`, `#@ root@other\n${base}`)).toBe(false);
  expect(isSameComposeContent(`#@ root@host\n${base}`, `#@   ssh://root@host\n# a comment\n${base}`)).toBe(true);

  // a version that can't be parsed counts as changed, so the deploy reports the error
  expect(isSameComposeContent(base, "services: [\n")).toBe(false);
  expect(isSameComposeContent("services: [\n", "services: [\n")).toBe(false);
  expect(isSameComposeContent(base, `${base}#@ root@host\n`)).toBe(false);
});

test("a comment-only change to a compose file doesn't redeploy the stack", async () => {
  const { push, writeFile } = await setup(["commentonly", "commentonly-other"]);
  const file = "stacks/commentonly/docker-compose.yaml";
  const otherFile = "stacks/commentonly-other/docker-compose.yaml";

  writeFile(file, stackCompose("commentonly"));
  writeFile(otherFile, stackCompose("commentonly-other"));
  expect((await push("add stacks")).err).toBeUndefined();
  const deployedId = await containerId("commentonly");
  const otherDeployedId = await containerId("commentonly-other");
  expect(deployedId).not.toBe("");

  writeFile(file, stackCompose("commentonly", { comment: "a reworded comment" }));
  const commentPush = await push("reword a comment");
  expect(commentPush.err).toBeUndefined();
  expect(commentPush.commentOnlyStacks).toEqual(["commentonly"]);
  expect(commentPush.changes).toEqual([]);
  expect(commentPush.msg).toBe("Synthesis succeeded for 0 stack(s). Skipped 1 stack(s) with comment-only changes: commentonly");
  expect(await containerId("commentonly")).toBe(deployedId);

  // alongside a real change to another stack, only that one is redeployed
  writeFile(file, stackCompose("commentonly", { comment: "reworded again" }));
  writeFile(otherFile, stackCompose("commentonly-other", { extra: "    labels:\n      test.value: v2\n" }));
  const mixedPush = await push("a comment and a real change");
  expect(mixedPush.err).toBeUndefined();
  expect(mixedPush.commentOnlyStacks).toEqual(["commentonly"]);
  expect(mixedPush.msg).toBe(`Synthesis succeeded for 1 stack(s): ${otherFile}. Skipped 1 stack(s) with comment-only changes: commentonly`);
  expect(await containerId("commentonly")).toBe(deployedId);
  expect(await containerId("commentonly-other")).not.toBe(otherDeployedId);

  // a real change to the stack still redeploys it
  writeFile(file, stackCompose("commentonly", { extra: "    labels:\n      test.value: v2\n" }));
  const realPush = await push("a real change");
  expect(realPush.err).toBeUndefined();
  expect(realPush.commentOnlyStacks).toBeUndefined();
  expect(await containerId("commentonly")).not.toBe(deployedId);
}, { timeout: 100_000 });

test("several pushed commits that add up to a comment-only change don't redeploy the stack", async () => {
  const { clientRoot, push, writeFile } = await setup(["commentrange"]);
  const file = "stacks/commentrange/docker-compose.yaml";

  writeFile(file, stackCompose("commentrange"));
  expect((await push("add stack")).err).toBeUndefined();
  const deployedId = await containerId("commentrange");

  // a real change, undone by the next commit of the same push
  writeFile(file, stackCompose("commentrange", { extra: "    labels:\n      test.value: v2\n" }));
  await $`git add . && git commit -m "add a label"`.cwd(clientRoot).quiet();
  writeFile(file, stackCompose("commentrange", { comment: "a reworded comment" }));
  const body = await push("drop the label, reword a comment");

  expect(body.err).toBeUndefined();
  expect(body.commentOnlyStacks).toEqual(["commentrange"]);
  expect(await containerId("commentrange")).toBe(deployedId);
}, { timeout: 100_000 });

test("fragment imports and fragment content count as changes, fragment comments don't", async () => {
  const { push, writeFile } = await setup(["commentfrag"]);
  const file = "stacks/commentfrag/docker-compose.yaml";
  const fragment = (value: string, comment: string) => `# ${comment}\nx-commentfrag: &commentfrag\n  test.value: ${value}\n`;
  const withFragment = { header: "#! fragments/commentfrag.yaml\n", extra: "    labels: *commentfrag\n" };

  writeFile("fragments/commentfrag.yaml", fragment("v1", "a comment"));
  writeFile("fragments/unused.yaml", "x-unused: &unused\n  a: b\n");
  writeFile(file, stackCompose("commentfrag", withFragment));
  expect((await push("add stack")).err).toBeUndefined();
  let deployedId = await containerId("commentfrag");
  expect(deployedId).not.toBe("");

  // a comment-only edit to the fragment skips its importers
  writeFile("fragments/commentfrag.yaml", fragment("v1", "a reworded comment"));
  const fragmentCommentPush = await push("reword the fragment's comment");
  expect(fragmentCommentPush.err).toBeUndefined();
  expect(fragmentCommentPush.commentOnlyStacks).toEqual(["commentfrag"]);
  expect(fragmentCommentPush.skippedStacks).toBeUndefined();
  expect(await containerId("commentfrag")).toBe(deployedId);

  // a change to the fragment's content redeploys them
  writeFile("fragments/commentfrag.yaml", fragment("v2", "a reworded comment"));
  const fragmentPush = await push("change the fragment");
  expect(fragmentPush.err).toBeUndefined();
  expect(fragmentPush.commentOnlyStacks).toBeUndefined();
  expect(await containerId("commentfrag")).not.toBe(deployedId);
  deployedId = await containerId("commentfrag");

  // a #! import is a directive, not a comment: adding one changes the expanded stack
  writeFile(file, stackCompose("commentfrag", { ...withFragment, header: "#! fragments/commentfrag.yaml\n#! fragments/unused.yaml\n" }));
  const importPush = await push("import another fragment");
  expect(importPush.err).toBeUndefined();
  expect(importPush.commentOnlyStacks).toBeUndefined();
  expect(await containerId("commentfrag")).not.toBe(deployedId);
}, { timeout: 100_000 });

test("a comment-only change still deploys a stack whose env changed since the last synthesis", async () => {
  const { push, writeFile } = await setup(["commentenv"]);
  const file = "stacks/commentenv/docker-compose.yaml";
  const labels = { extra: `    labels:\n      test.value: "\${${ENV_KEY}}"\n` };
  process.env[ENV_KEY] = "v1";

  writeFile(file, stackCompose("commentenv", labels));
  expect((await push("add stack")).err).toBeUndefined();
  const deployedId = await containerId("commentenv");

  // the push records the env as synthesized, so skipping the stack would lose the new value
  process.env[ENV_KEY] = "v2";
  writeFile(file, stackCompose("commentenv", { ...labels, comment: "a reworded comment" }));
  const body = await push("reword a comment");
  expect(body.err).toBeUndefined();
  expect(body.commentOnlyStacks).toBeUndefined();
  expect(await containerId("commentenv")).not.toBe(deployedId);
  expect((await $`docker inspect commentenv --format '{{index .Config.Labels "test.value"}}'`.quiet().text()).trim()).toBe("v2");
}, { timeout: 100_000 });

test("an explicit synthesis of an unchanged stack, like an env change, still deploys it", async () => {
  const { gitainer, push, writeFile } = await setup(["commentexplicit"]);
  const file = "stacks/commentexplicit/docker-compose.yaml";
  const labels = { extra: `    labels:\n      test.value: "\${${ENV_KEY}}"\n` };
  process.env[ENV_KEY] = "v1";

  writeFile(file, stackCompose("commentexplicit", labels));
  expect((await push("add stack")).err).toBeUndefined();
  writeFile(file, stackCompose("commentexplicit", { ...labels, comment: "a reworded comment" }));
  expect((await push("reword a comment")).commentOnlyStacks).toEqual(["commentexplicit"]);
  const deployedId = await containerId("commentexplicit");

  // HEAD is a comment-only commit, which mustn't hide the env change
  process.env[ENV_KEY] = "v2";
  await gitainer.checkForStackEnvUpdate();
  expect(await containerId("commentexplicit")).not.toBe(deployedId);
}, { timeout: 100_000 });
