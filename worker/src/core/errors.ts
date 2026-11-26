export type ErrorCode =
  | "unauthorized" | "forbidden" | "not_found" | "validation_failed"
  | "conflict" | "confirmation_required" | "bad_request" | "payload_too_large";

export interface Issue {
  path: string;
  message: string;
  expected?: string;
  received?: unknown;
}

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  confirmation_required: 400,
  bad_request: 400,
  payload_too_large: 413,
};

export class FemtoError extends Error {
  readonly status: number;
  readonly issues?: Issue[];
  readonly hint?: string;

  constructor(
    readonly code: ErrorCode,
    message: string,
    opts?: { issues?: Issue[]; hint?: string },
  ) {
    super(message);
    this.name = "FemtoError";
    this.status = STATUS[code];
    this.issues = opts?.issues;
    this.hint = opts?.hint;
  }
}
