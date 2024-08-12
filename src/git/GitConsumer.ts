import { simpleGit as Git, type SimpleGit } from 'simple-git';
import type { GitChange, GitChangeType } from './GitChange';

export class GitConsumer {
  readonly repo: SimpleGit;

  constructor(path: string) {
    this.repo = Git(path);
  }

  async getFileContents(filePath: string): Promise<string> {
    return await this.repo.show([`main:${filePath}`]);
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

  async getLatestChanges(pointer: string = "HEAD"): Promise<GitChange[]> {
    // shows the files changed in latest commit
    return GitConsumer.parseShowOutput(await this.repo.show(["--name-status", "--oneline", pointer]));
  }
}
