
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
};
