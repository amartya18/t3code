import * as Schema from "effect/Schema";

export const CLIENT_DIAGNOSTIC_MAX_BYTES = 2 * 1024 * 1024;

/** One crash or diagnostic report a device collected, such as an iOS MetricKit payload. */
export const ClientDiagnosticSubmitInput = Schema.Struct({
  json: Schema.String,
});
export type ClientDiagnosticSubmitInput = typeof ClientDiagnosticSubmitInput.Type;

const CLIENT_DIAGNOSTIC_FAILURE_MESSAGES = {
  too_large: "The diagnostic report is larger than the server accepts.",
  invalid_json: "The diagnostic report is not valid JSON.",
  write_failed: "The server could not save the diagnostic report.",
} as const;

export class ClientDiagnosticSubmitError extends Schema.TaggedError<ClientDiagnosticSubmitError>()(
  "ClientDiagnosticSubmitError",
  {
    reason: Schema.Literals(
      Object.keys(CLIENT_DIAGNOSTIC_FAILURE_MESSAGES) as Array<
        keyof typeof CLIENT_DIAGNOSTIC_FAILURE_MESSAGES
      >,
    ),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return CLIENT_DIAGNOSTIC_FAILURE_MESSAGES[this.reason];
  }
}
