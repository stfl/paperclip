import { describe, expect, it } from "vitest";
import { connectPostgres } from "./connect-postgres.js";

describe("connectPostgres", () => {
  it("reads the host URI parameter as a unix socket directory, as libpq does", async () => {
    const sql = connectPostgres("postgres://paperclip:secret@localhost:54329/paperclip?host=%2Frun%2Fpaperclip%2Fdb");
    try {
      expect(sql.options.path).toBe("/run/paperclip/db/.s.PGSQL.54329");
      expect(sql.options.user).toBe("paperclip");
      expect(sql.options.pass).toBe("secret");
      expect(sql.options.database).toBe("paperclip");
      expect(sql.options.connection).not.toHaveProperty("host");
    } finally {
      await sql.end();
    }
  });

  it("keeps the TCP host of a URL without the parameter and passes the options through", async () => {
    const sql = connectPostgres("postgres://paperclip:secret@127.0.0.1:5432/paperclip?sslmode=disable", { max: 3 });
    try {
      expect(sql.options.path).toBe(false);
      expect(sql.options.host).toEqual(["127.0.0.1"]);
      expect(sql.options.max).toBe(3);
    } finally {
      await sql.end();
    }
  });
});
