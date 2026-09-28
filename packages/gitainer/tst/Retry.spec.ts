import { expect, test } from "bun:test";
import { isTransientPullError, withRetry } from "../src/docker/retry";

const quiet = () => {};

test("withRetry returns the first successful result", async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return "ok"; }, { attempts: 3, delayMs: 0, label: "pull", log: quiet });

  expect(result).toBe("ok");
  expect(calls).toBe(1);
});

test("withRetry retries transient failures", async () => {
  let calls = 0;
  const logs: string[] = [];
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error("EOF");
    return "ok";
  }, { attempts: 3, delayMs: 0, label: "pull stack", log: msg => logs.push(msg) });

  expect(result).toBe("ok");
  expect(calls).toBe(3);
  expect(logs).toEqual([
    "pull stack failed (attempt 1/3), retrying in 0s",
    "pull stack failed (attempt 2/3), retrying in 0s",
  ]);
});

test("withRetry rethrows the last error once attempts run out", async () => {
  let calls = 0;
  const run = withRetry(async () => { calls++; throw new Error(`EOF ${calls}`); }, { attempts: 3, delayMs: 0, label: "pull", log: quiet });

  await expect(run).rejects.toThrow("EOF 3");
  expect(calls).toBe(3);
});

test("withRetry rethrows immediately when shouldRetry says no", async () => {
  let calls = 0;
  const run = withRetry(async () => { calls++; throw new Error("invalid compose file"); }, {
    attempts: 3, delayMs: 0, label: "pull", log: quiet, shouldRetry: () => false,
  });

  await expect(run).rejects.toThrow("invalid compose file");
  expect(calls).toBe(1);
});

// shaped like bun's ShellError: the compose/daemon output is on stderr
const shellError = (stderr: string) => Object.assign(new Error("Failed with exit code 18"), { stderr: Buffer.from(stderr) });

test("isTransientPullError retries registry connection failures", () => {
  for (const stderr of [
    'Error response from daemon: Head "https://ecr.local.chromart.cc/v2/doorman-homeassistant/manifests/latest": EOF',
    'Error response from daemon: Get "https://ecr.local.chromart.cc/v2/": EOF',
    'Error response from daemon: Get "https://ecr.local.chromart.cc/v2/": read tcp 172.17.0.2:40000->192.168.1.150:443: read: connection reset by peer',
    'Error response from daemon: Get "https://ecr.local.chromart.cc/v2/": dial tcp 192.168.1.150:443: connect: connection refused',
    'Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout',
    'Error response from daemon: received unexpected HTTP status: 502 Bad Gateway',
  ]) {
    expect(isTransientPullError(shellError(stderr))).toBe(true);
  }
});

test("isTransientPullError does not retry errors that fail the same way every time", () => {
  for (const stderr of [
    "services.image must be a mapping",
    "validating /tmp/gitainer/x.yaml: services.app.container_name must be a string",
    "Error response from daemon: pull access denied for alpien, repository does not exist or may require 'docker login'",
    "Error response from daemon: manifest for ecr.local.chromart.cc/datum:latset not found: manifest unknown: manifest unknown",
    'unable to get image \'alpine\': error during connect: Get "http://docker.example.com/v1.46/images/alpine/json": command [ssh -o ConnectTimeout=30 -l root -- 192.0.2.1 docker system dial-stdio] has exited with exit status 255: stderr=ssh: connect to host 192.0.2.1 port 22: Operation timed out',
  ]) {
    expect(isTransientPullError(shellError(stderr))).toBe(false);
  }
});
