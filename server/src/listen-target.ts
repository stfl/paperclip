/**
 * Where the HTTP server listens: a socket systemd passed by socket
 * activation (sd_listen_fds(3)), or the configured host and port.
 *
 * A socket held by systemd stays bound while the server restarts, so no
 * other process of the same user can take the port in between. A configured
 * port that is busy otherwise falls back to the next free port, unless
 * `PAPERCLIP_LISTEN_STRICT` refuses the fallback.
 */

const SD_LISTEN_FDS_START = 3;

export type ListenTarget =
  | { kind: "inherited-fd"; fd: number; port: number }
  | { kind: "host-port"; host: string; port: number };

export type DetectPort = (options: { port: number; hostname: string }) => Promise<number>;

function parsePositiveInteger(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Reads the socket-activation variables and removes them from `env`, so no
 * child process sees them. Returns the first passed fd when the variables
 * name this process.
 */
export function takeSystemdListenFd(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): number | null {
  const listenPid = parsePositiveInteger(env.LISTEN_PID);
  const listenFds = parsePositiveInteger(env.LISTEN_FDS);
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;
  if (listenPid !== pid || listenFds === null) return null;
  return SD_LISTEN_FDS_START;
}

export function isListenStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = env.PAPERCLIP_LISTEN_STRICT?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export class ListenPortBusyError extends Error {
  constructor(host: string, port: number, nextFreePort: number) {
    super(
      `Configured port ${host}:${port} is busy and PAPERCLIP_LISTEN_STRICT is set; ` +
        `refusing to fall back to port ${nextFreePort}`,
    );
    this.name = "ListenPortBusyError";
  }
}

export async function resolveListenTarget(input: {
  host: string;
  port: number;
  inheritedFd: number | null;
  strict: boolean;
  detectPort: DetectPort;
}): Promise<ListenTarget> {
  if (input.inheritedFd !== null) {
    return { kind: "inherited-fd", fd: input.inheritedFd, port: input.port };
  }
  const port = await input.detectPort({ port: input.port, hostname: input.host });
  if (input.strict && port !== input.port) {
    throw new ListenPortBusyError(input.host, input.port, port);
  }
  return { kind: "host-port", host: input.host, port };
}

export function describeListenTarget(target: ListenTarget): string {
  return target.kind === "inherited-fd"
    ? `fd ${target.fd} (systemd socket activation, port ${target.port})`
    : `${target.host}:${target.port}`;
}
