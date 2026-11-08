export type IdentityErrorCode = "invalid_name" | "already_exists" | "project_not_found";

/**
 * A request the identity operations cannot carry out, for a reason the caller can act on. The
 * message is fixed text per code and never contains the rejected input.
 */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode) {
    super(
      {
        invalid_name: "name must be 1 to 200 characters",
        already_exists: "an item with that name already exists",
        project_not_found: "project not found",
      }[code],
    );
    this.name = "IdentityError";
    this.code = code;
  }
}
