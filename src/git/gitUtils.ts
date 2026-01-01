import { $ } from "bun";

const getReadmeContent = (repoName: string) => `# Gitainer

Simple Git-based container management platform for Docker Standalone

[View the repository](https://github.com/martindmtrv/gitainer)

## Features

- All the benefits of Git such as versioning, portability, etc.
- Pass through Variables and YAML fragments to keep your stacks DRY
- Lightweight HTTP API to trigger stack actions from CI/CD pipelines
- POST webhook option for update responses

## Usage

### Quick Start

On the machine you want to manage stacks from clone the repo
\`\`\`
git clone <hostmachine>:3000/${repoName}.git
cd ${repoName}
\`\`\`

Create your stack
\`\`\`
mkdir -p stacks/mystack
vi stacks/mystack/docker-compose.yaml
\`\`\`

Push the changes
\`\`\`
git add .
git commit -m "my first stack"
git push
\`\`\`

"mystack" will now be deployed on the host machine
`;

export async function createInitialCommitWithReadme(repoDir: string, repoName: string, branch: string = "main") {
    const readmeContent = getReadmeContent(repoName);

    // Write blob
    const blobHash = (await $`echo "${readmeContent}" | git --git-dir ${repoDir} hash-object -w --stdin`.text()).trim();

    // Create tree
    // Format: <mode> blob <sha1>\t<filename>
    const treeHash = (await $`printf "100644 blob ${blobHash}\tREADME.md\n" | git --git-dir ${repoDir} mktree`.text()).trim();

    await $`git --git-dir ${repoDir} config user.email "gitainer@localhost"`;
    await $`git --git-dir ${repoDir} config user.name "Gitainer"`;

    // Create commit
    const commitHash = (await $`git --git-dir ${repoDir} commit-tree ${treeHash} -m "Initial commit"`.text()).trim();

    // Update ref
    await $`git --git-dir ${repoDir} update-ref refs/heads/${branch} ${commitHash}`;
}
