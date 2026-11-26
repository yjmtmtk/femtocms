import { FemtoError, type Issue } from "../core/errors";

export interface ErrorBody { error: { code: string; message: string; issues?: Issue[]; hint?: string } }

/** The API error JSON for any thrown value (shared by HTTP and MCP). Unexpected errors are logged, never leaked. */
export function errorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof FemtoError) {
    const error: ErrorBody["error"] = { code: err.code, message: err.message };
    if (err.issues) error.issues = err.issues;
    if (err.hint) error.hint = err.hint;
    return { status: err.status, body: { error } };
  }
  console.error(err);
  return { status: 500, body: { error: { code: "internal", message: "Internal error" } } };
}

/** Maps any thrown value to the API error response. */
export function errorResponse(err: unknown): Response {
  const { status, body } = errorBody(err);
  return Response.json(body, { status });
}
