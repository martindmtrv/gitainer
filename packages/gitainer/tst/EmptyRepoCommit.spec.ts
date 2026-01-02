import { expect, test } from "bun:test";
import { DockerClient } from "../src/docker/DockerClient";
import { GitainerServer } from "../src/git/GitainerServer";
import { $ } from "bun";
import { mkdirSync, rmSync, existsSync } from "node:fs";

const TEST_ROOT = "./tst/resources_empty_check";

test("initial commit is only created when repo is empty", async () => {
    // Setup
    if (existsSync(TEST_ROOT)) {
        rmSync(TEST_ROOT, { recursive: true });
    }
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(TEST_ROOT + "/backend", { recursive: true });
    mkdirSync(TEST_ROOT + "/backend/data", { recursive: true });
    mkdirSync(TEST_ROOT + "/backend/fragments", { recursive: true });
    mkdirSync(TEST_ROOT + "/backend/stacks", { recursive: true });

    const docker = new DockerClient();
    const gitainer = new GitainerServer(
        "test-repo",
        "main",
        TEST_ROOT + "/backend",
        TEST_ROOT + "/backend/data",
        "fragments",
        TEST_ROOT + "/backend/stacks",
        docker,
        false
    );

    const getCommitCount = async () => {
        const repoDir = TEST_ROOT + "/backend/test-repo.git";
        try {
            const count = await $`git --git-dir ${repoDir} rev-list --count --all`.text();
            return parseInt(count.trim());
        } catch (e) {
            return 0;
        }
    };

    // 1. First initialization - should create initial commit
    await gitainer.initRepo();
    expect(await getCommitCount()).toBe(1);

    // 2. Second initialization - should NOT create another commit
    await gitainer.initRepo();
    expect(await getCommitCount()).toBe(1);

    // Cleanup
    await gitainer.close();
    rmSync(TEST_ROOT, { recursive: true });
}, { timeout: 30000 });
