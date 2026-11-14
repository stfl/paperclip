import { spawn } from "node:child_process";
import { endianness } from "node:os";
import { expect, it, vi } from "vitest";
import { clockTicksFromAuxv, readClockTicksPerSecond, readLinuxProcessStartedAt } from "./linux-process-start.js";

const AT_CLKTCK = 17;
const nativeWordBytes = ["arm", "ia32", "mips", "mipsel"].includes(process.arch) ? 4 : 8;
const auxv = (
  pairs: Array<[number, number]>, wordBytes: 4 | 8 = nativeWordBytes, littleEndian = endianness() === "LE",
) => {
  const bytes = new Uint8Array(pairs.length * 2 * wordBytes);
  const view = new DataView(bytes.buffer);
  pairs.flat().forEach((word, index) => wordBytes === 8
    ? view.setBigUint64(index * 8, BigInt(word), littleEndian)
    : view.setUint32(index * 4, word, littleEndian));
  return bytes;
};
const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
const noGetconf = () => { throw Object.assign(new Error("spawnSync getconf ENOENT"), { code: "ENOENT" }); };

const stat = (ticks: string, command = "runner") => `123 (${command}) S ${Array(18).fill("0").join(" ")} ${ticks}\n`;
const options = (processStat = stat("123"), systemStat = "btime 1785546000\n", clockTicksPerSecond = 100) => ({
  clockTicksPerSecond,
  readFile: (path: string) => path === "/proc/123/stat" ? processStat : systemStat,
});

it("uses kernel birth ticks even when the command contains spaces and parentheses", () => {
  expect(readLinuxProcessStartedAt(123, options(stat("123", "a ) b ( c"))))
    .toBe(new Date(1785546001230).toISOString());
  expect(readLinuxProcessStartedAt(123, options(stat("124"))))
    .not.toBe(readLinuxProcessStartedAt(123, options()));
});

it.each([
  [stat("bad"), "btime 1785546000\n", 100],
  [stat("123").replace("123 (", "124 ("), "btime 1785546000\n", 100],
  ["123 (runner) S", "btime 1785546000\n", 100],
  [stat("123"), "btime invalid\n", 100],
  [stat("123"), "btime 1785546000\n", 0],
  [stat("123"), "btime 1785546000\n", Number.NaN],
  [stat("123"), "btime 999999999999999999999\n", 100],
])("fails closed on malformed birth metadata or clock frequency", (processStat, systemStat, frequency) => {
  expect(() => readLinuxProcessStartedAt(123, options(processStat, systemStat, frequency))).toThrow();
});

it.each([
  [8, true], [8, false], [4, true], [4, false],
] as const)("reads the clock tick frequency from a %i-byte auxiliary vector (little endian: %s)", (wordBytes, littleEndian) => {
  const pairs: Array<[number, number]> = [[6, 4096], [AT_CLKTCK, 250], [23, 0], [0, 0]];
  expect(clockTicksFromAuxv(auxv(pairs, wordBytes, littleEndian), wordBytes, littleEndian)).toBe(250);
});

it.each([
  ["no entry", [[6, 4096], [0, 0]]],
  ["an entry after the terminator", [[6, 4096], [0, 0], [AT_CLKTCK, 100]]],
  ["an empty vector", []],
] as Array<[string, Array<[number, number]>]>)("finds no clock tick frequency in an auxiliary vector with %s", (_name, pairs) => {
  expect(clockTicksFromAuxv(auxv(pairs, 8, true), 8, true)).toBeUndefined();
});

it("finds no clock tick frequency in a truncated entry", () => {
  expect(clockTicksFromAuxv(auxv([[AT_CLKTCK, 100]], 8, true).subarray(0, 12), 8, true)).toBeUndefined();
});

it("takes the clock tick frequency from the kernel without running getconf", () => {
  const getconf = vi.fn(noGetconf);
  expect(readClockTicksPerSecond({ readAuxv: () => auxv([[AT_CLKTCK, 250], [0, 0]]), getconf })).toBe(250);
  expect(getconf).not.toHaveBeenCalled();
});

it.each([
  ["is unreadable", () => { throw new Error("EACCES"); }],
  ["has no entry", () => auxv([[0, 0]])],
  ["states zero", () => auxv([[AT_CLKTCK, 0], [0, 0]])],
] as Array<[string, () => Uint8Array]>)("asks getconf when the auxiliary vector %s", (_name, readAuxv) => {
  expect(readClockTicksPerSecond({ readAuxv, getconf: () => "100\n" })).toBe(100);
});

it.each([
  ["is missing", noGetconf],
  ["answers nothing usable", () => "undefined\n"],
  ["answers zero", () => "0\n"],
] as Array<[string, () => string]>)("fails without a default when the auxiliary vector has no entry and getconf %s", (_name, getconf) => {
  expect(() => readClockTicksPerSecond({ readAuxv: () => auxv([[0, 0]]), getconf })).toThrow();
});

it.skipIf(process.platform !== "linux")("reads a child's birth time on a host without getconf", async () => {
  vi.resetModules();
  const execFileSync = vi.fn(noGetconf);
  vi.doMock("node:child_process", async importOriginal => ({
    ...await importOriginal<typeof import("node:child_process")>(), execFileSync,
  }));
  const before = Date.now();
  const child = sleeper();
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    const hostWithoutGetconf = await import("./linux-process-start.js");
    expect((await import("node:child_process")).execFileSync).toBe(execFileSync);
    const startedAt = new Date(hostWithoutGetconf.readLinuxProcessStartedAt(child.pid!)).getTime();
    // /proc/stat states the boot time in whole seconds, so the birth time
    // reads up to a second early. A wrong tick frequency moves it by a
    // multiple of the host's uptime.
    expect(startedAt).toBeGreaterThanOrEqual(before - 2_000);
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 1_000);
  } finally {
    vi.doUnmock("node:child_process");
    vi.resetModules();
    child.kill("SIGKILL"); await closed;
  }
}, 5000);

it.skipIf(process.platform !== "linux")("keeps the actual owned child's birth identity stable through a delayed observation", async () => {
  const child = sleeper();
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    expect(child.pid).toBeGreaterThan(0);
    const first = readLinuxProcessStartedAt(child.pid!);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(readLinuxProcessStartedAt(child.pid!)).toBe(first);
    child.kill("SIGTERM"); await closed;
    expect(() => readLinuxProcessStartedAt(child.pid!)).toThrow();
  } finally { child.kill("SIGTERM"); await closed; }
}, 5000);
