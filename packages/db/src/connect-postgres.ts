import postgres from "postgres";

/**
 * Opens a postgres.js client for a connection URL. libpq reads the `host` URI
 * parameter as the server's host, which for a path is a unix socket directory;
 * postgres.js sends it to the server as a startup parameter instead. A URL
 * carrying `host` therefore reaches the server over the socket in that
 * directory, as it does for `psql` and `pg_dump`.
 */
export function connectPostgres(url: string, options: Record<string, unknown> = {}) {
  let socketDirectory: string | null = null;
  let driverUrl = url;
  try {
    const parsed = new URL(url);
    socketDirectory = parsed.searchParams.get("host");
    if (socketDirectory) {
      parsed.searchParams.delete("host");
      driverUrl = parsed.toString();
    }
  } catch {
    // A value `new URL()` rejects goes to the driver as it is.
  }
  return postgres(driverUrl, socketDirectory ? { ...options, host: socketDirectory } : options);
}
