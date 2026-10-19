/**
 * Path encoding for the JSONL session store.
 *
 * The shipped `@deepseek-ai/dsh-session-persistence-jsonl` backend keeps one
 * directory per session at `<root>/<projectKey(cwd)>/<encodeSegment(sessionId)>`.
 * Neither helper is exported by that package (it publishes only its plugin
 * export plus config types), so this module reimplements the two pure
 * functions. They are verified against real directories produced by the
 * backend; {@link projectKey} is only ever a *fallback* — the primary locator
 * asks the backend's own `locate()` method (see `locate.js`).
 *
 * Both functions are pure and dependency-free so the mapping stays testable.
 *
 * @module dsh-session-trash/host/encode
 */

/** Code units that may appear literally in a path segment. */
const SAFE_UNIT = /^[A-Za-z0-9._-]$/;

/** Escape one UTF-16 code unit as `~XXXX` (upper-case hex, at least 4 digits). */
function escapeUnit(code) {
  return `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Encode one arbitrary string into a single filesystem-safe path segment,
 * decodable back to the input.
 *
 * This mirrors the backend exactly: `.` and `..` are special-cased to prevent
 * traversal, safe code units stay literal, and every other code unit —
 * including `~` itself — becomes `~XXXX`. Operating on code units (not code
 * points) preserves lone surrogates.
 *
 * @param {string} raw - non-empty string to encode.
 * @returns {string} the escaped segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== "string") throw new TypeError("encodeSegment: raw must be a string");
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && SAFE_UNIT.test(ch)) out += ch;
    else out += escapeUnit(code);
  }
  return out;
}

/**
 * Build the readable, bounded directory key for a workspace path.
 *
 * Filesystem separators and drive separators become `-` (runs collapse to one
 * dash); unsafe code units use the same `~XXXX` escape. Separator replacement
 * and truncation are intentionally lossy, following the backend's
 * human-navigable project-directory convention.
 *
 * @param {string} cwd - the session's absolute project directory.
 * @returns {string} the single filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== "string") throw new TypeError("projectKey: cwd must be a string");
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && SAFE_UNIT.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += escapeUnit(code);
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
