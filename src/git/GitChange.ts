
export enum GitChangeType {
  ADD = "A",
  DELETE = "D",
  MODIFY = "M",
  RENAME = "R",
};

export interface GitChange {
  file: string;
  type: GitChangeType;
  reason: string;
};
