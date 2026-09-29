
export enum GitChangeType {
  ADD = "A",
  DELETE = "D",
  MODIFY = "M",
  RENAME = "R",
};

export interface GitChange {
  file: string;
  // for renames, the path the file was renamed from (file holds the new path)
  oldFile?: string;
  type: GitChangeType;
  reason: string;
  // set when the stack is only pulled in by an env or fragment change it references, not by a
  // change to its own compose file. Such a stack is skipped if it isn't deployed.
  indirect?: boolean;
};
