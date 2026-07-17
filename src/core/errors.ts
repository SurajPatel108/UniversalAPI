/*
Purpose: provide transport-neutral errors for expected application failures.
Responsibilities: carry a stable error code and safe details from services to API/worker boundaries.
Connections: services throw these; routes map them to HTTP and workers map them to retry policy.
Future: add error-to-status mapping and machine-readable problem responses.
Best practice: do not expose vendor errors or secrets to API clients.
*/

export class ApplicationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = "ApplicationError";
  }
}

