
export enum GitChangeType {
  ADD = "A",
  DELETE = "D",
  MODIFY = "M",
};

export interface GitChange {
  file: string;
  type: GitChangeType;
  reason: string[];
};
