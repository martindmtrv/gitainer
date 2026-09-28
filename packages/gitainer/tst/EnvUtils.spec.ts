import { expect, test } from "bun:test";
import { changedEnvKeys, parseBooleanEnv, referencesEnv } from "../src/server/envUtils";

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

test("changedEnvKeys ignores variables that only moved in the env dump", () => {
  const previous = "LOCAL_IP=192.168.1.150\nPATH=/bin\nDOMAIN=chromart.cc\n";
  const current = "PATH=/bin\nDOMAIN=chromart.cc\nLOCAL_IP=192.168.1.150\n";

  expect(changedEnvKeys(previous, current)).toEqual([]);
});

test("changedEnvKeys reports new and changed keys, not removed ones", () => {
  const previous = "KEEP=same\nCHANGED=old\nREMOVED=gone\n";
  const current = "CHANGED=new\nKEEP=same\nADDED=value\n";

  expect(changedEnvKeys(previous, current)).toEqual(["CHANGED", "ADDED"]);
});

test("changedEnvKeys keeps everything after the first = in the value", () => {
  expect(changedEnvKeys("URL=a?x=1\n", "URL=a?x=2\n")).toEqual(["URL"]);
  expect(changedEnvKeys("URL=a?x=1\n", "URL=a?x=1\n")).toEqual([]);
});

test("changedEnvKeys treats an empty previous dump as everything new", () => {
  expect(changedEnvKeys("", "A=1\nB=2\n")).toEqual(["A", "B"]);
});

test("referencesEnv matches $VAR and ${VAR} forms", () => {
  expect(referencesEnv("image: $LOCAL_ECR/caddy:latest", "LOCAL_ECR")).toBe(true);
  expect(referencesEnv("image: ${LOCAL_ECR}/caddy:latest", "LOCAL_ECR")).toBe(true);
  expect(referencesEnv("image: ${LOCAL_ECR:-192.168.1.150:9120}/caddy", "LOCAL_ECR")).toBe(true);
  expect(referencesEnv("url: http://$LOCAL_IP", "LOCAL_IP")).toBe(true);
});

test("referencesEnv does not match a longer variable with the same prefix", () => {
  expect(referencesEnv("image: $LOCAL_ECR_DIRECT/caddy:latest", "LOCAL_ECR")).toBe(false);
  expect(referencesEnv("image: ${LOCAL_ECR_DIRECT}/caddy:latest", "LOCAL_ECR")).toBe(false);
  expect(referencesEnv("image: $LOCAL_ECR2/caddy", "LOCAL_ECR")).toBe(false);
  expect(referencesEnv("LOCAL_ECR is not a reference", "LOCAL_ECR")).toBe(false);
});
