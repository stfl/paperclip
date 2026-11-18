import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createIssueSchema, updateIssueSchema } from "@paperclipai/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { rejectUnknownIssueFields, rejectUnknownQueryParameters } from "../middleware/validate.js";

function buildApp(...middleware: express.RequestHandler[]) {
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(200).json({ ok: true });
  });
  const app = express();
  app.use(express.json());
  app.all("/target", ...middleware, handler);
  app.use(errorHandler);
  return { app, handler };
}

describe("rejectUnknownIssueFields", () => {
  it("passes a body whose keys the schema declares, under the preprocess pipe", async () => {
    const { app, handler } = buildApp(rejectUnknownIssueFields(createIssueSchema));
    const res = await request(app).post("/target").send({ title: "Known", description: "text" });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("answers 422 naming each undeclared key", async () => {
    const { app, handler } = buildApp(rejectUnknownIssueFields(createIssueSchema));
    const res = await request(app).post("/target").send({ title: "Known", body: "lost", note: "lost" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unknown fields: body, note");
    expect(res.body.details).toEqual({ unknownFields: ["body", "note"] });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes a tolerated key and refuses the rest", async () => {
    const { app } = buildApp(rejectUnknownIssueFields(updateIssueSchema, ["originId"]));
    expect((await request(app).post("/target").send({ originId: "x" })).status).toBe(200);
    expect((await request(app).post("/target").send({ originKind: "x" })).status).toBe(422);
  });

  it("leaves a body that is not an object to the schema", async () => {
    const { app, handler } = buildApp(rejectUnknownIssueFields(createIssueSchema));
    const res = await request(app).post("/target").send([1]);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses a schema without an object shape", () => {
    expect(() => rejectUnknownIssueFields(createIssueSchema.shape as never)).toThrow();
  });
});

describe("rejectUnknownQueryParameters", () => {
  it("passes the allowed parameters and names the others", async () => {
    const { app } = buildApp(rejectUnknownQueryParameters(new Set(["status", "limit"])));
    expect((await request(app).get("/target").query({ status: "todo", limit: "5" })).status).toBe(200);
    const res = await request(app).get("/target").query({ status: "todo", identifier: "PAP-1" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unknown query parameter: identifier");
    expect(res.body.details).toEqual({ unknownParameters: ["identifier"] });
  });
});
