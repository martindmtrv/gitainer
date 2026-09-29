import { afterAll, beforeAll } from "bun:test";
import { $ } from "bun";

// Tests tear their compose stacks down with `docker rm -f`, which leaves each project's
// networks behind. On a long-lived dockerd (not the throwaway one in the test image),
// enough of them make dockerd hand out 192.168.x subnets that can shadow the LAN. So
// after all test files, remove the compose networks this run created.

let existingNetworks = new Set<string>();

async function composeNetworks(): Promise<string[]> {
  const ids = await $`docker network ls -q --filter label=com.docker.compose.project`.quiet().nothrow().text();
  return ids.split("\n").filter(Boolean);
}

beforeAll(async () => {
  existingNetworks = new Set(await composeNetworks());
});

afterAll(async () => {
  const created = (await composeNetworks()).filter(id => !existingNetworks.has(id));
  if (created.length > 0) {
    // a network still in use by a container is refused and left in place
    await $`docker network rm ${created}`.quiet().nothrow();
  }
});
