import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodIssue, type ZodSchema, type core } from "zod";
import { unprocessable } from "../errors.js";

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}

// The issue create/update contract requires HTTP 422 (not the generic Zod 400)
// when a request pins an invalid executionWorkspaceSettings.workspaceStrategy
// .existingBranch: bad branch syntax, placement outside isolated_workspace +
// git_worktree, or combination with branchTemplate. All three semantic checks
// report this exact path suffix, including when an issue-creating route nests
// the settings (for example accepted-plan-decomposition children). Requests
// that also fail unrelated validation keep the long-standing 400.
const EXISTING_BRANCH_SETTINGS_PATH = [
  "executionWorkspaceSettings",
  "workspaceStrategy",
  "existingBranch",
] as const;

export function isExistingBranchSemanticsZodIssue(issue: Pick<ZodIssue, "path">): boolean {
  const pathOffset = issue.path.length - EXISTING_BRANCH_SETTINGS_PATH.length;
  return (
    pathOffset >= 0 &&
    EXISTING_BRANCH_SETTINGS_PATH.every((segment, index) => issue.path[pathOffset + index] === segment)
  );
}

export function validateIssueMutationBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
    } catch (err) {
      if (
        err instanceof ZodError &&
        err.issues.length > 0 &&
        err.issues.every(isExistingBranchSemanticsZodIssue)
      ) {
        // Same body shape as the generic Zod 400 response, so the
        // field-specific details are preserved verbatim.
        throw unprocessable("Validation error", err.issues);
      }
      throw err;
    }
    next();
  };
}

// The issue mutation schemas are plain z.object shapes, which drop a key they
// do not declare. A client that sends one (a report in `body` where the text
// belongs in `comment`) gets a success and loses the text, so these routes
// refuse the key by name. The object sits under the pipe z.preprocess makes
// and under optional/nullable wrappers.
function schemaObjectShape(schema: ZodSchema): Record<string, unknown> | null {
  let current: core.$ZodType | undefined = schema;
  while (current) {
    const def = current._zod.def as { type: string; shape?: Record<string, unknown>; out?: core.$ZodType; innerType?: core.$ZodType };
    if (def.type === "object") return def.shape ?? null;
    current = def.type === "pipe" ? def.out : def.innerType;
  }
  return null;
}

/**
 * Answers 422 naming every top-level body key the schema's object does not
 * declare. `tolerated` keys are accepted without being declared, for callers
 * that send a key the route has always dropped.
 */
export function rejectUnknownIssueFields(schema: ZodSchema, tolerated: readonly string[] = []) {
  const shape = schemaObjectShape(schema);
  if (!shape) {
    throw new Error("rejectUnknownIssueFields: the schema has no object shape");
  }
  return (req: Request, _res: Response, next: NextFunction) => {
    const body = req.body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const unknown = Object.keys(body).filter(
        (key) => !Object.hasOwn(shape, key) && !tolerated.includes(key),
      );
      if (unknown.length > 0) {
        throw unprocessable(`Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, {
          unknownFields: unknown,
        });
      }
    }
    next();
  };
}

/** Answers 422 naming every query parameter outside `allowed`. */
export function rejectUnknownQueryParameters(allowed: ReadonlySet<string>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const unknown = Object.keys(req.query).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw unprocessable(`Unknown query parameter${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`, {
        unknownParameters: unknown,
      });
    }
    next();
  };
}
