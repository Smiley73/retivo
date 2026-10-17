// Tests for new-video.mjs: name validation, the template copy filter, and a
// scaffold into a temporary folder (no npm install).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createVideoFiles, nameProblem, shouldCopy } from "./new-video.mjs";

test("accepts lower-case words joined by hyphens", () => {
  for (const name of ["demo", "weekly-update", "q4-2026-review", "a1"]) {
    assert.equal(nameProblem(name), null, name);
  }
});

test("rejects names that are empty, upper-case, or not hyphenated words", () => {
  for (const name of [
    undefined,
    "",
    "Demo",
    "weekly_update",
    "-demo",
    "demo-",
    "demo--clip",
    "2fa",
    "../escape",
    "a b",
  ]) {
    assert.ok(nameProblem(name), `${name} should be rejected`);
  }
});

test("rejects names that clash with a video/ folder or a git-ignored folder", () => {
  for (const name of ["kit", "template", "scripts", "models", "out", "dist"]) {
    assert.match(nameProblem(name), /reserved/, name);
  }
});

test("copy filter skips generated folders, by whole path segment", () => {
  assert.equal(shouldCopy("node_modules"), false);
  assert.equal(shouldCopy(join("node_modules", "remotion", "index.js")), false);
  assert.equal(shouldCopy("out"), false);
  assert.equal(shouldCopy(join("out", "video.mp4")), false);
  assert.equal(shouldCopy(join("public", "voiceover")), false);
  assert.equal(shouldCopy(join("public", "voiceover", "title-1.mp3")), false);
});

test("copy filter keeps files whose names merely start like a skipped folder", () => {
  for (const kept of [
    "package.json",
    join("src", "outline.ts"),
    "output-notes.md",
    join("public", "fonts"),
    join("public", "voiceover-notes.txt"),
    "node_modules.md",
  ]) {
    assert.equal(shouldCopy(kept), true, kept);
  }
});

test("scaffolds from a checkout whose own path contains /out", () => {
  // The path of the checkout itself must not affect what is copied.
  const videoDir = mkdtempSync(join(tmpdir(), "outbox-"));
  try {
    const template = join(videoDir, "template");
    mkdirSync(join(template, "src"), { recursive: true });
    mkdirSync(join(template, "public"), { recursive: true });
    mkdirSync(join(template, "out"), { recursive: true });
    mkdirSync(join(template, "node_modules"), { recursive: true });
    writeFileSync(
      join(template, "package.json"),
      JSON.stringify({ name: "@retivo/video-template", description: "x" }),
    );
    writeFileSync(
      join(template, "src", "Root.tsx"),
      'id="TemplateVideo" component={TemplateVideo}',
    );
    writeFileSync(
      join(template, "src", "Video.tsx"),
      "export const TemplateVideo = 1;",
    );
    writeFileSync(join(template, "src", "outline.ts"), "export {};");
    writeFileSync(join(template, "out", "old.mp4"), "generated");
    writeFileSync(join(template, "node_modules", "x.js"), "installed");
    symlinkSync("../../kit/fonts", join(template, "public", "fonts"));

    const compositionId = createVideoFiles(videoDir, "weekly-update");
    const created = join(videoDir, "weekly-update");

    assert.equal(compositionId, "WeeklyUpdate");
    const pkg = JSON.parse(readFileSync(join(created, "package.json"), "utf8"));
    assert.equal(pkg.name, "@retivo/video-weekly-update");
    const root = readFileSync(join(created, "src", "Root.tsx"), "utf8");
    assert.match(root, /id="WeeklyUpdate"/);
    assert.match(root, /component=\{WeeklyUpdateVideo\}/);
    assert.match(
      readFileSync(join(created, "src", "Video.tsx"), "utf8"),
      /export const WeeklyUpdateVideo/,
    );
    assert.ok(existsSync(join(created, "src", "outline.ts")));
    assert.ok(!existsSync(join(created, "out")));
    assert.ok(!existsSync(join(created, "node_modules")));
    assert.ok(lstatSync(join(created, "public", "fonts")).isSymbolicLink());
    assert.match(
      readFileSync(join(created, "README.md"), "utf8"),
      /^# Weekly update/,
    );

    // A new video named like the template itself keeps its composition id.
    createVideoFiles(videoDir, "template-video");
    const selfRoot = readFileSync(
      join(videoDir, "template-video", "src", "Root.tsx"),
      "utf8",
    );
    assert.match(selfRoot, /id="TemplateVideo"/);
    assert.match(selfRoot, /component=\{TemplateVideoVideo\}/);

    // A name that equals an import of Video.tsx must not become the component's name.
    createVideoFiles(videoDir, "react");
    const reactRoot = readFileSync(
      join(videoDir, "react", "src", "Root.tsx"),
      "utf8",
    );
    assert.match(reactRoot, /id="React"/);
    assert.match(reactRoot, /component=\{ReactVideo\}/);
  } finally {
    rmSync(videoDir, { recursive: true, force: true });
  }
});
