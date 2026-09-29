import { expect, test } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { $ } from "bun";

function stackCompose(containerName: string, version = "v1") {
  return `services:
  app:
    image: alpine
    command: sleep infinity
    container_name: ${containerName}
    stop_grace_period: 0s
    labels:
      test.version: ${version}
`;
}

async function containerId(containerName: string): Promise<string | undefined> {
  const output = await $`docker inspect ${containerName} --format '{{.State.Running}} {{.Id}}'`.nothrow().quiet().text();
  const [running, id] = output.trim().split(" ");
  return running === "true" ? id : undefined;
}

async function removeContainer(containerName: string) {
  await $`docker rm -f ${containerName}`.quiet().nothrow();
}

test("composeUp starts a downed stack", async () => {
  const docker = new DockerClient();
  const container = "composeup-downed";
  const compose = stackCompose(container);

  await removeContainer(container);
  try {
    await docker.composeUpdate(compose, "composeup-downed");
    await docker.composeDown(compose, "composeup-downed");
    expect(await containerId(container)).toBeUndefined();

    await docker.composeUp(compose, "composeup-downed");
    expect(await containerId(container)).toBeDefined();
  } finally {
    await removeContainer(container);
  }
}, { timeout: 60_000 });

test("composeUp leaves an unchanged running container alone, but recreates a changed one", async () => {
  const docker = new DockerClient();
  const container = "composeup-running";

  await removeContainer(container);
  try {
    await docker.composeUpdate(stackCompose(container), "composeup-running");
    const original = await containerId(container);
    expect(original).toBeDefined();

    await docker.composeUp(stackCompose(container), "composeup-running");
    expect(await containerId(container)).toBe(original!);

    await docker.composeUp(stackCompose(container, "v2"), "composeup-running");
    const recreated = await containerId(container);
    expect(recreated).toBeDefined();
    expect(recreated).not.toBe(original!);
  } finally {
    await removeContainer(container);
  }
}, { timeout: 60_000 });
