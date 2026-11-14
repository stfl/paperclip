import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { endianness } from "node:os";

let clockTicksPerSecond: number | undefined;

export interface LinuxProcessStartOptions {
  readFile?: (path: string) => string;
  clockTicksPerSecond?: number;
}

export interface ClockTickSources {
  readAuxv: () => Uint8Array;
  getconf: () => string;
}

const AT_NULL = 0;
const AT_CLKTCK = 17;
const NATIVE_WORD_BYTES = ["arm", "ia32", "mips", "mipsel"].includes(process.arch) ? 4 : 8;

const hostClockTickSources: ClockTickSources = {
  readAuxv: () => readFileSync("/proc/self/auxv"),
  getconf: () => execFileSync("getconf", ["CLK_TCK"], {
    encoding: "utf8", timeout: 1_500, windowsHide: true,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  }),
};

const isTickFrequency = (ticks: number | undefined): ticks is number =>
  ticks !== undefined && Number.isSafeInteger(ticks) && ticks > 0;

/**
 * The auxiliary vector is a list of (type, value) pairs of native words that
 * ends at AT_NULL. Its AT_CLKTCK entry is the kernel's own statement of the
 * unit of the times in /proc/PID/stat, the entry sysconf(_SC_CLK_TCK) answers
 * from.
 */
export function clockTicksFromAuxv(
  auxv: Uint8Array,
  wordBytes: 4 | 8 = NATIVE_WORD_BYTES,
  littleEndian = endianness() === "LE",
): number | undefined {
  const view = new DataView(auxv.buffer, auxv.byteOffset, auxv.byteLength);
  const word = (offset: number) => wordBytes === 8
    ? Number(view.getBigUint64(offset, littleEndian))
    : view.getUint32(offset, littleEndian);
  for (let offset = 0; offset + 2 * wordBytes <= view.byteLength; offset += 2 * wordBytes) {
    const type = word(offset);
    if (type === AT_NULL) return undefined;
    if (type === AT_CLKTCK) return word(offset + wordBytes);
  }
  return undefined;
}

/**
 * Asks the kernel first, so the answer needs no `getconf` on the host. There
 * is no assumed default: a wrong unit would shift every start time and make a
 * live process look like a reused identifier.
 */
export function readClockTicksPerSecond(sources: ClockTickSources = hostClockTickSources): number {
  let ticks: number | undefined;
  try { ticks = clockTicksFromAuxv(sources.readAuxv()); } catch { /* getconf decides */ }
  if (!isTickFrequency(ticks)) ticks = Number(sources.getconf().trim());
  if (!isTickFrequency(ticks)) throw new Error("Invalid Linux clock tick frequency");
  return ticks;
}

/** /proc/PID directory ctime is lookup metadata, not the process's birth time. */
export function readLinuxProcessStartedAt(pid: number, options: LinuxProcessStartOptions = {}): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Linux process PID");
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const processStat = readFile(`/proc/${pid}/stat`);
  // comm can contain spaces and parentheses. Fields after its final ')' start
  // at field 3 (state), so field 22 (starttime) is index 19 in this suffix.
  const end = processStat.lastIndexOf(") ");
  const fields = end >= 0 ? processStat.slice(end + 2).trim().split(/\s+/) : [];
  const startTicks = fields[19];
  const bootSeconds = /^btime (\d+)$/m.exec(readFile("/proc/stat"))?.[1];
  if (!processStat.startsWith(`${pid} (`) || !/^\d+$/.test(startTicks ?? "") || !bootSeconds) {
    throw new Error("Invalid Linux process birth metadata");
  }
  const ticks = options.clockTicksPerSecond ?? (clockTicksPerSecond ??= readClockTicksPerSecond());
  if (!isTickFrequency(ticks)) throw new Error("Invalid Linux clock tick frequency");
  const milliseconds = BigInt(bootSeconds) * 1_000n + BigInt(startTicks!) * 1_000n / BigInt(ticks);
  const value = Number(milliseconds);
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("Invalid Linux process birth timestamp");
  }
  return new Date(value).toISOString();
}
