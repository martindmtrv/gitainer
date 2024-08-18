import { simpleGit as Git, type SimpleGit } from 'simple-git';
import { GitChangeType, type GitChange } from './GitChange';
import { GitainerServer } from './GitainerServer';

export class GitConsumer {
  readonly repo: SimpleGit;

  constructor(path: string) {
    this.repo = Git(path);
  }

  async getStack(stackName: string): Promise<string | undefined> {
    let fileContents = await this.getFileContents(`stacks/${stackName}/docker-compose.yaml`);

    if (!fileContents) {
      fileContents = await this.getFileContents(`stacks/${stackName}/docker-compose.yml`);
    }

    return fileContents;
  }

  async getFileContents(filePath: string): Promise<string | undefined> {
    return this.repo
      .show([`main:${filePath}`])
      .catch(err => {
        console.error(err);
        return undefined;
      });
  }

  private static parseShowOutput(showOutput: string, reason: string): GitChange[] {
    return showOutput
      .split("\n")
      .slice(1, -1)
      .map(entry => {
        const file = entry.split("\t");
        return {
          file: file[1],
          type: file[0] as GitChangeType,
          reason,
        };
      });
  }

  async getChanges(pointer: string = "HEAD"): Promise<GitChange[]> {
    // shows the files changed in latest commit
    return GitConsumer.parseShowOutput(await this.repo.show(["--name-status", "--oneline", pointer]), `Change at ${pointer}`);
  }

  async listAllFiles(prefix: string): Promise<string[]> {
    try {
      const output = await this.repo.raw('ls-tree', '-r', 'main', '--name-only');
      return output
        .split("\n")
        .slice(0, -1)
        .filter(path => path.startsWith(prefix));
    } catch (e) {
      // this throws when the repo is empty
      return [];
    }
  }

  async listStacksWithEnvReference(envVars: string[]): Promise<GitChange[]> {
    const files = await this.listAllFiles("stacks");

    const promises = await Promise.all(files
      .filter(file => GitainerServer.stackPattern.test(file))
      .map(file => this.getFileContents(file).then(contents => ({
        file,
        contents: contents as string,
      }))));

    const results = [];

    for (const file of promises) {
      const matches: string[] = [];
      envVars.forEach(envVar => {
        if (
          [`$${envVar}`, '${'+envVar+'}']
          .some(envPattern => file.contents.includes(envPattern))
        ) {
          matches.push(envVar);
        }
      });

      if (matches.length !== 0) {
        results.push({
          file: file.file,
          type: GitChangeType.MODIFY,
          reason: `Stack contains ENV VAR references to ${matches}`,
        });
      }
    }

    return results;
  }
}
