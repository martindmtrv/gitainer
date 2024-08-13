import { simpleGit as Git, type SimpleGit } from 'simple-git';
import type { GitChange, GitChangeType } from './GitChange';

export class GitConsumer {
  readonly repo: SimpleGit;

  constructor(path: string) {
    this.repo = Git(path);
  }

  async getFileContents(filePath: string): Promise<string | undefined> {
    return this.repo
      .show([`main:${filePath}`])
      .catch(err => {
        console.error(err);
        return undefined;
      });
  }

  private static parseShowOutput(showOutput: string): GitChange[] {
    return showOutput
      .split("\n")
      .slice(1, -1)
      .map(entry => {
        const file = entry.split("\t");
        return {
          file: file[1],
          type: file[0] as GitChangeType,
        };
      });
  }

  async getChanges(pointer: string = "HEAD"): Promise<GitChange[]> {
    // shows the files changed in latest commit
    return GitConsumer.parseShowOutput(await this.repo.show(["--name-status", "--oneline", pointer]));
  }
}
