import { expect, test } from "bun:test";
import { changedEnvKeys, envSnapshot, parseBooleanEnv } from "../src/server/envUtils";

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

test("changedEnvKeys ignores HOSTNAME, which Docker sets to the container id", () => {
  expect(changedEnvKeys("HOSTNAME=abc123\nA=1\n", "HOSTNAME=def456\nA=1\n")).toEqual([]);
  expect(changedEnvKeys("", "HOSTNAME=def456\nA=1\n")).toEqual(["A"]);
});

test("envSnapshot keeps a multiline value as one entry", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB=\n-----END CERTIFICATE-----\n";
  const snapshot = envSnapshot({ A: "1", CERT: pem, UNSET: undefined });

  expect(changedEnvKeys(snapshot, envSnapshot({ CERT: pem, A: "1" }))).toEqual([]);
  expect(changedEnvKeys(snapshot, envSnapshot({ A: "1", CERT: pem.replace("MIIB", "MIIC") }))).toEqual(["CERT"]);
  // not the lines of the value: "MIIB=" would read as a key of its own
  expect(changedEnvKeys("", snapshot)).toEqual(["A", "CERT"]);
});

test("changedEnvKeys reads an `env` dump written before envSnapshot() against a snapshot", () => {
  expect(changedEnvKeys("A=1\nB=2\n", envSnapshot({ A: "1", B: "2" }))).toEqual([]);
  expect(changedEnvKeys("A=1\nB=2\n", envSnapshot({ A: "1", B: "3", C: "4" }))).toEqual(["B", "C"]);
});
