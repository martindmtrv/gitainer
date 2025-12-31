import { simpleGit as Git, GitError, type SimpleGit } from 'simple-git';
import { GitChangeType, type GitChange } from './GitChange';
import { GitainerServer } from './GitainerServer';
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";

export class GitConsumer {
  readonly repo: SimpleGit;

  static readonly IMPORT_REGEX: RegExp = /^#!\s*(.*?)\s*$/mg;

  static condenseNewLines(str: string): string {
    return str.split('\n').filter(line => line).join('\n');
  }

  constructor(path: string) {
    this.repo = Git(path);
  }

  async getAllStackNames(): Promise<string[]> {
    const stacks = await this.getAllStacks();

    return stacks.map(stack => (GitainerServer.stackPattern.exec(stack.file) as RegExpExecArray)[1])
  }

  async getStack(stackName: string): Promise<string | undefined> {
    let fileContents = await this.getFileContents(`stacks/${stackName}/docker-compose.yaml`);

    if (!fileContents) {
      fileContents = await this.getFileContents(`stacks/${stackName}/docker-compose.yml`);
    }

    if (!fileContents) {
      return undefined;
    }

    // append extensions
    if (process.env.FRAGMENTS_PATH) {
      // fragment import like #!<fragmentpath>
      let importedFragments = Array.from(fileContents.matchAll(GitConsumer.IMPORT_REGEX)).map(match => match[1]).filter(importLine => importLine !== "#!");

      // clear out the import lines and condense the compose empty newlines
      fileContents = GitConsumer.condenseNewLines(fileContents.replaceAll(GitConsumer.IMPORT_REGEX, ""));

      // console.log("= fragments to be imported =");
      // console.log(importedFragments);

      // get the fragments
      let fragmentsList = await Promise.all(importedFragments.map(fragment => this.getFileContents(fragment).then(content => {
        if (!content) {
          throw new Error(`Fragment ${fragment} does not exist`);
        }

        return `# fragment -> ${fragment}\n` + GitConsumer.condenseNewLines(content);
      })));

      const composeStart = fileContents.search(/^services:\s*/m);

      fileContents = [
        fileContents.slice(0, composeStart),
        "# === fragments start ===\n",
        fragmentsList.join('\n'),
        "\n# === fragments end ===\n",
        fileContents.slice(composeStart)
      ].join("\n");
    }

    // console.log("= After resolving fragments =");

    // console.log(fileContents);

    return fileContents;
  }

  async getFileContents(filePath: string): Promise<string | undefined> {
    return this.repo
      .show([`main:${filePath}`])
      .catch((err: GitError) => {
        if (!err.message.includes("does not exist")) {
          console.error(err);
        }
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

  async getAllStacks(): Promise<{ file: string, contents: string }[]> {
    const files = await this.listAllFiles("stacks");

    return Promise.all(files
      .filter(file => GitainerServer.stackPattern.test(file))
      .map(file => this.getFileContents(file).then(contents => ({
        file,
        contents: contents as string,
      }))));
  }

  async listStacksWithEnvReference(envVars: string[], fragments: string[] = []): Promise<GitChange[]> {
    const promises = await this.getAllStacks();

    const results = [];

    for (const file of promises) {
      const matches: string[] = [];
      envVars.forEach(envVar => {
        if (
          [`$${envVar}`, '${' + envVar + '}']
            .some(envPattern => file.contents.includes(envPattern))
        ) {
          matches.push(envVar);
        }
      });

      fragments.forEach(fragment => {
        if (file.contents.includes(fragment)) {
          matches.push(fragment);
        }
      });

      if (matches.length !== 0) {
        results.push({
          file: file.file,
          type: GitChangeType.MODIFY,
          reason: `Stack contains references to ${matches}`,
        });
      }
    }

    return results;
  }

  async writeAllStacksToDir(dir: string): Promise<void> {
    if (existsSync(dir)) {
      rmSync(dir + '/*', { force: true, recursive: true });
    } else {
      mkdirSync(dir);
    }

    const stackNames = await this.getAllStackNames();

    const promises = stackNames.map(name =>
      this.getStack(name)
        .then(contents => {
          mkdirSync(`${dir}/stacks/${name}`, { recursive: true });
          writeFileSync(`${dir}/stacks/${name}/docker-compose.yaml`, contents as string);
        })
    );

    await Promise.all(promises);
  }
}
