/**
 * Encoding tests.
 *
 * The first two cases are not invented: they are the real directory names this
 * machine's DSH produced for two real workspaces. They are the regression anchor
 * that keeps the reimplemented encoding honest against the shipped backend.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { encodeSegment, projectKey } from "../../lib/host/encode.js";

test("projectKey reproduces a real ASCII+CJK workspace directory", () => {
  assert.equal(
    projectKey("/Users/example/Desktop/work/研究"),
    "/--Users-example-Desktop-work-~7814~7A76--"
  );
});

test("projectKey reproduces a second real workspace directory", () => {
  assert.equal(projectKey("/Users/example/Desktop/work/插件"), "/--Users-example-Desktop-work-~63D2~4EF6--");
});

test("projectKey collapses separator runs and strips leading dashes", () => {
  assert.equal(projectKey("/a//b///c"), "--a-b-c--");
  assert.equal(projectKey("/"), "--root--");
});

test("projectKey treats a drive separator like a path separator", () => {
  assert.equal(projectKey("C:\\Users\\x"), "--C-Users-x--");
});

test("projectKey escapes characters that would be unsafe in a path segment", () => {
  assert.equal(projectKey("/tmp/a b"), "--tmp-a~0020b--");
  assert.equal(projectKey("/tmp/a~b"), "--tmp-a~007Eb--");
});

test("projectKey truncates the readable part to a filesystem-safe length", () => {
  const key = projectKey(`/${"x".repeat(500)}`);
  // `--` + 251 readable + `--`, matching the backend's component-limit bound.
  assert.equal(key.length, 255);
  assert.ok(key.startsWith("--"));
  assert.ok(key.endsWith("--"));
});

test("projectKey rejects an empty path", () => {
  assert.throws(() => projectKey(""), /empty project path/);
});

test("encodeSegment keeps safe ids literal", () => {
  const id = "session-11111111-2222-3333-4444-555555555555";
  assert.equal(encodeSegment(id), id);
});

test("encodeSegment neutralizes traversal", () => {
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  // A dot is a safe code unit, so only the separators are escaped here; the
  // result stays a single file name and is the exact bytes the backend produces.
  assert.equal(encodeSegment("../etc/passwd"), "..~002Fetc~002Fpasswd");
  assert.equal(encodeSegment("a/b"), "a~002Fb");
  assert.equal(encodeSegment("a\0b"), "a~0000b");
});

test("no encoding of a hostile id can escape a directory", () => {
  for (const hostile of ["..", "../..", "../../etc/passwd", "a/../../b", "/abs", "C:\\x"]) {
    const encoded = encodeSegment(hostile);
    assert.ok(!encoded.includes("/"), `separator survived in ${encoded}`);
    assert.ok(!encoded.includes("\\"), `backslash survived in ${encoded}`);
    assert.notEqual(encoded, ".");
    assert.notEqual(encoded, "..");
  }
});

test("encodeSegment escapes its own escape character", () => {
  assert.equal(encodeSegment("a~b"), "a~007Eb");
});

test("encodeSegment rejects an empty segment", () => {
  assert.throws(() => encodeSegment(""), /cannot encode an empty path segment/);
});

test("encodeSegment handles a non-BMP character as two code units", () => {
  // U+1F600 -> surrogate pair D83D DE00, escaped per code unit.
  assert.equal(encodeSegment("\u{1F600}"), "~D83D~DE00");
});

test("encodeSegment and projectKey round-trip through the documented escapes", () => {
  const raw = "a b~/../\u7814";
  const encoded = encodeSegment(raw);
  const decoded = encoded.replace(/~([0-9A-F]{4})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  assert.equal(decoded, raw);
});
