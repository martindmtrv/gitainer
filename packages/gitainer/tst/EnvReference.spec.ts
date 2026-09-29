import { expect, test, beforeAll, afterAll } from "bun:test";
import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { GitConsumer } from "../src/git/GitConsumer";

const TEST_ROOT = "./tst/resources_envreference";

const files: Record<string, string> = {
  "fragments/uses-var.yaml": "x-env: &fragment-env\n  URL: http://$FRAGMENT_HOST\n",
  "stacks/plain/docker-compose.yaml": [
    "services:",
    "  app:",
    "    image: ${LOCAL_ECR:-192.168.1.150:9120}/caddy",
    "    environment:",
    "      URL: http://$LOCAL_IP:80",
    "",
  ].join("\n"),
  "stacks/escaped/docker-compose.yaml": [
    "# needs $COMMENTED",
    "services:",
    "  runner:",
    "    image: alpine",
    "    prefix_entrypoint:",
    "      - sed -i \"s|x|$$GITEA_INSTANCE_URL|\" /data/.runner",
    "      - echo $PREFIX_VAR",
    "",
  ].join("\n"),
  "stacks/prefixed/docker-compose.yaml": "services:\n  app:\n    image: $LOCAL_ECR_DIRECT/caddy\n",
  "stacks/withfragment/docker-compose.yaml": [
    "#! fragments/uses-var.yaml",
    "services:",
    "  app:",
    "    image: alpine",
    "    environment: *fragment-env",
    "",
  ].join("\n"),
};

let repo: GitConsumer;

beforeAll(async () => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(`${TEST_ROOT}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true });
    writeFileSync(`${TEST_ROOT}/${path}`, contents);
  }
  await $`git init -q -b main && git add . && git -c user.name=test -c user.email=test@test commit -qm stacks`.cwd(TEST_ROOT);

  process.env.FRAGMENTS_PATH = "fragments";
  repo = new GitConsumer(TEST_ROOT);
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function stacksReferencing(envVar: string): Promise<string[]> {
  return (await repo.listStacksWithEnvReference([envVar])).map(change => change.file).sort();
}

test("interpolated variables mark the stack, including defaults and ones inside strings", async () => {
  expect(await stacksReferencing("LOCAL_ECR")).toEqual(["stacks/plain/docker-compose.yaml"]);
  expect(await stacksReferencing("LOCAL_IP")).toEqual(["stacks/plain/docker-compose.yaml"]);
});

test("escaped $$VAR and variables in comments are not references", async () => {
  expect(await stacksReferencing("GITEA_INSTANCE_URL")).toEqual([]);
  expect(await stacksReferencing("COMMENTED")).toEqual([]);
});

test("variables in prefix_entrypoint are references, since compose interpolates them", async () => {
  expect(await stacksReferencing("PREFIX_VAR")).toEqual(["stacks/escaped/docker-compose.yaml"]);
});

test("a variable used only in an imported fragment marks the importing stack", async () => {
  expect(await stacksReferencing("FRAGMENT_HOST")).toEqual(["stacks/withfragment/docker-compose.yaml"]);
});

test("a longer variable with the same prefix is not a reference", async () => {
  expect(await stacksReferencing("LOCAL_ECR_DIRECT")).toEqual(["stacks/prefixed/docker-compose.yaml"]);
  expect(await stacksReferencing("LOCAL")).toEqual([]);
});

test("the reason lists every matched variable", async () => {
  const changes = await repo.listStacksWithEnvReference(["LOCAL_ECR", "LOCAL_IP", "UNUSED"]);
  expect(changes).toHaveLength(1);
  expect(changes[0].reason).toBe("Stack contains references to LOCAL_ECR,LOCAL_IP");
});
