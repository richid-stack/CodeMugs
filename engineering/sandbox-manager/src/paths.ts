/**
 * Paths use a small alphabet. A comma, a colon, an equals sign or a space has a meaning in the
 * mount syntax of a container runtime, and a path that contains one could add an option to the
 * mount. Rejecting them here means no driver has to escape anything.
 */
const SAFE_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** True for an absolute path with a plain alphabet, no trailing slash and no '.' or '..' part. */
export function isPlainAbsolutePath(path: string): boolean {
  return (
    SAFE_PATH.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/** Whether `path` is the same place as `folder` or inside it. Both must be plain absolute paths. */
export function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}
