import { expect, test } from "bun:test";
import { parseBooleanEnv } from "../src/server/envUtils";

test("parseBooleanEnv treats explicit truthy values as enabled", () => {
  for (const value of ["1", "true", "TRUE", "True", "yes", "on", " 1 "]) {
    expect(parseBooleanEnv(value)).toBe(true);
  }
});

test("parseBooleanEnv treats falsy, unknown and missing values as disabled", () => {
  for (const value of ["0", "false", "FALSE", "no", "off", "", "  ", "2", undefined]) {
    expect(parseBooleanEnv(value)).toBe(false);
  }
});
