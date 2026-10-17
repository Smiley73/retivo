// Start a new video from video/template/:
//
//   npm run new -- my-video-name        (from the video/ folder)
//
// Copies the template to video/<name>/, names it, registers it as an npm
// workspace and installs. The new video gets the shared look (kit), the shared
// narration voice and pronunciations, and the same scripts as every other video.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Folders of video/ itself, plus the generated folders its .gitignore hides: a
// video with one of these names would clash with them or be silently ignored.
const RESERVED_NAMES = [
  "kit",
  "template",
  "scripts",
  "models",
  "node_modules",
  "out",
  "dist",
];

/** Why `name` can't be used for a new video, or null when it can. */
export function nameProblem(name) {
  if (!name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    return "Use lower-case words joined by hyphens, starting with a letter, e.g. weekly-update.";
  }
  if (RESERVED_NAMES.includes(name)) {
    return `"${name}" is reserved. Pick another name.`;
  }
  return null;
}

// Generated or installed folders of the template, never copied to a new video.
const SKIPPED_FROM_TEMPLATE = [
  "node_modules",
  "out",
  join("public", "voiceover"),
];

/**
 * Whether a file or folder of the template is copied, given its path relative
 * to the template folder. Compares whole path segments, so `src/outline.ts` or
 * a checkout that lives under a folder called `outbox` is not mistaken for `out`.
 */
export function shouldCopy(relativePath) {
  return !SKIPPED_FROM_TEMPLATE.some(
    (skipped) =>
      relativePath === skipped || relativePath.startsWith(skipped + sep),
  );
}

/** "weekly-update" -> "WeeklyUpdate", the composition id. */
const compositionIdFor = (name) =>
  name
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");

/** The video's exported component: never the bare name, which may match an import. */
const componentNameFor = (compositionId) => `${compositionId}Video`;

/** "weekly-update" -> "Weekly update", the title. */
const titleFor = (name) => {
  const [first, ...rest] = name.split("-");
  return [first[0].toUpperCase() + first.slice(1), ...rest].join(" ");
};

/**
 * Copy video/template to video/<name> and give it its names. Touches only the
 * new folder. Returns the composition id.
 */
export function createVideoFiles(videoDir, name) {
  const templateDir = join(videoDir, "template");
  const destination = join(videoDir, name);
  const compositionId = compositionIdFor(name);
  const componentName = componentNameFor(compositionId);
  const title = titleFor(name);

  cpSync(templateDir, destination, {
    recursive: true,
    verbatimSymlinks: true, // keep public/fonts as the relative link to kit/fonts
    filter: (source) => shouldCopy(relative(templateDir, source)),
  });

  // A scoped package name can never collide with an npm dependency.
  const packagePath = join(destination, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.name = `@retivo/video-${name}`;
  pkg.description = title;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  for (const file of ["src/Root.tsx", "src/Video.tsx"]) {
    const path = join(destination, file);
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replaceAll("TemplateVideo", componentName)
        .replaceAll(`id="${componentName}"`, `id="${compositionId}"`),
    );
  }
  writeFileSync(
    join(destination, "README.md"),
    `# ${title}\n\nStarted from the template. Run from this folder:\n\n` +
      "```console\nnpm run voiceover     # generate the narration clips from narration.json\nnpm run dev           # Remotion Studio\n" +
      `npx remotion render ${compositionId} out/${name}.mp4\n\`\`\`\n\nSee the [video README](../README.md) for the shared kit, voice and pronunciations.\n`,
  );
  return compositionId;
}

function main(name) {
  const problem = nameProblem(name);
  if (problem) {
    console.error(`Usage: npm run new -- <name>\n${problem}`);
    process.exit(1);
  }
  const videoDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const destination = join(videoDir, name);
  if (existsSync(destination)) {
    console.error(`video/${name} already exists. Pick another name.`);
    process.exit(1);
  }

  const rootPackagePath = join(videoDir, "package.json");
  const lockPath = join(videoDir, "package-lock.json");
  const rootPackageBefore = readFileSync(rootPackagePath, "utf8");
  const lockBefore = existsSync(lockPath)
    ? readFileSync(lockPath, "utf8")
    : null;

  try {
    const compositionId = createVideoFiles(videoDir, name);
    const rootPackage = JSON.parse(rootPackageBefore);
    rootPackage.workspaces.push(name);
    writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
    execFileSync("npm", ["install", "--no-fund", "--no-audit"], {
      cwd: videoDir,
      stdio: "inherit",
    });
    console.log(`
Created video/${name} (composition "${compositionId}").

Next, from video/${name}:
  1. Edit narration.json and the scenes in src/scenes/.
  2. npm run voiceover     (needs the Kokoro model: see ../README.md)
  3. npm run dev
`);
  } catch (error) {
    // Leave nothing half-done: no new folder, no workspace entry, same lockfile.
    rmSync(destination, { recursive: true, force: true });
    writeFileSync(rootPackagePath, rootPackageBefore);
    if (lockBefore !== null) writeFileSync(lockPath, lockBefore);
    console.error(`Could not create video/${name}; undid the changes.`);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
