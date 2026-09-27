import { expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { mkdirSync, rmSync, readFileSync } from "node:fs";

const TEST_ROOT = "./tst/resources_envupdate";
const SECRET_KEY = "GITAINER_ENV_UPDATE_TEST_SECRET";
const SECRET_VALUE = "super-secret-value-do-not-log";

let gitainer: GitainerServer;

beforeEach(async () => {
  try {
    rmSync(TEST_ROOT, { recursive: true });
  } catch (e) {
    // pass
  }

  mkdirSync(TEST_ROOT + "/backend/data", { recursive: true });
  mkdirSync(TEST_ROOT + "/backend/fragments", { recursive: true });
  mkdirSync(TEST_ROOT + "/backend/stacks", { recursive: true });

  process.env.FRAGMENTS_PATH = "fragments";
  gitainer = new GitainerServer(
    "docker",
    "main",
    TEST_ROOT + "/backend",
    TEST_ROOT + "/backend/data",
    "fragments",
    TEST_ROOT + "/backend/stacks",
    new DockerClient(),
    true,
  );
  await gitainer.initRepo();
});

afterEach(async () => {
  delete process.env[SECRET_KEY];
  await gitainer.close();

  try {
    rmSync(TEST_ROOT, { recursive: true });
  } catch (e) {
    // pass
  }
});

function captureLogs() {
  const logs: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  });
  return { logs, restore: () => spy.mockRestore() };
}

test("env change logs the changed key but never its value", async () => {
  process.env[SECRET_KEY] = SECRET_VALUE;

  const { logs, restore } = captureLogs();
  try {
    await gitainer.checkForStackEnvUpdate();
  } finally {
    restore();
  }

  expect(logs.some(line => line.includes(SECRET_KEY))).toBe(true);
  expect(logs.some(line => line.includes(SECRET_VALUE))).toBe(false);
});

test("env change used by no stack is recorded, so it is not reported again", async () => {
  process.env[SECRET_KEY] = SECRET_VALUE;
  await gitainer.checkForStackEnvUpdate();

  const lastSynthesizedEnv = readFileSync(TEST_ROOT + "/backend/data/lastSynthesizedEnv", "utf-8");
  expect(lastSynthesizedEnv).toContain(`${SECRET_KEY}=`);

  const { logs, restore } = captureLogs();
  try {
    await gitainer.checkForStackEnvUpdate();
  } finally {
    restore();
  }

  expect(logs).toContain("no diff detected");
  expect(logs.some(line => line.includes(SECRET_KEY))).toBe(false);
});
