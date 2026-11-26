import { FemtoError } from "../core/errors";

/** Maps any thrown value to the API error shape. Unexpected errors are logged, never leaked. */
export function errorResponse(err: unknown): Response {
  if (err instanceof FemtoError) {
    const error: Record<string, unknown> = { code: err.code, message: err.message };
    if (err.issues) error.issues = err.issues;
    if (err.hint) error.hint = err.hint;
    return Response.json({ error }, { status: err.status });
  }
  console.error(err);
  return Response.json({ error: { code: "internal", message: "Internal error" } }, { status: 500 });
}
