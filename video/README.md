# Videos

Product videos for Retivo, made with [Remotion](https://www.remotion.dev). One npm
workspace: install once here, and every video shares the same look, narration
voice and tooling.

| Folder or file | What it is |
|---|---|
| [kit/](kit/) | The shared look: colour tokens, the app's fonts, the mock-UI pieces (sidebar, buttons, cursor, step dots), the two-column layout, fade and timing constants, the narration player |
| [template/](template/) | The starter every new video is copied from |
| [getting-started/](getting-started/README.md) | "Getting Started with Retivo locally", a narrated, under-a-minute first-run walkthrough |
| [architecture-overview/](architecture-overview/README.md) | "Architecture Overview", a narrated walkthrough for contributors: local-first, components, local vs AWS, sign-in and unlock, sync, repair, snapshots, what the server sees |
| `voice.json` | Which Kokoro voice, and how fast. Used by every video |
| `pronunciations.json` | Exact IPA for words the voice gets wrong, e.g. **Retivo** → "reh-TEE-voh" |
| `scripts/` | `generate_voiceover.py` (narration) and `new-video.mjs` (new video), with their tests |
| `models/` | The Kokoro model files (git-ignored, one copy for all videos) |

These are npm projects, outside the pnpm workspace, so lint, knip, typecheck and CI
of the app do not see them. `npm run lint` here checks the scripts, the kit, the
template and every video; `npm test` runs the script tests (they need `python3`,
3.9 or newer). Dependabot watches `video/` on its own entry in
`.github/dependabot.yml`; zod and Remotion major updates are left to be done by
hand, together with Remotion, after reading the upstream licence terms.

Remotion has its own licence terms. Whether you can use it for free depends on who
you are, so read the [upstream terms](https://www.remotion.dev/docs/license) before
using it in your organisation.

## One-time setup (macOS)

You need [Node.js](https://nodejs.org) 20.19 or newer, 22.13 or newer, or 24 (the
repo itself uses 24), plus two tools for the narration:

```console
brew install ffmpeg uv
```

([ffmpeg](https://ffmpeg.org/download.html),
[uv](https://docs.astral.sh/uv/getting-started/installation/)). uv fetches
Python 3.13 and the generator's Python packages (pinned, with a lockfile next to the
script) the first time you generate narration. Then, from this folder:

```console
npm install
mkdir -p models
curl -L -o models/kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx   # 325 MB
curl -L -o models/voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin    # 28 MB
shasum -a 256 models/*
```

The checksums should read:

```text
7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5  models/kokoro-v1.0.onnx
bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d  models/voices-v1.0.bin
```

## Remotion in Claude Code

Install the official Remotion plugin. It adds the `remotion` skills to Claude
Code (create a video, best practices, render, studio and so on). Full steps:
[Remotion's Claude Code plugin page](https://www.remotion.dev/docs/ai/claude-code-plugin).

- **Desktop app:** open **Code → Customize → Plugins → Discover**, search for
  `remotion` and add the one from `remotion-dev/claude-code-plugin`.
- **Terminal:**

  ```console
  claude plugin marketplace add remotion-dev/claude-code-plugin
  claude plugin install remotion@remotion
  ```

Then restart Claude Code. Without the plugin, the skills alone can be installed
into a project; see [Agent Skills](https://www.remotion.dev/docs/ai/skills) and
[Remotion with Claude Code](https://www.remotion.dev/docs/ai/claude-code).

For a new video, don't use `/remotion:remotion-create` to scaffold a project: start
from the template (next section) so it gets the shared look and narration, then
ask Claude to build the scenes in it. Tell it to use `@retivo/video-kit`.

## A new video

```console
npm run new -- my-video-name
```

This copies [template/](template/) to `video/my-video-name/`, registers it as a
workspace and installs. If anything fails it undoes the copy. Then, from that folder:

1. Edit `narration.json` (one clip per line) and the scenes in `src/scenes/`.
2. `npm run voiceover` makes the narration clips in `public/voiceover/`. They are
   generated and git-ignored, so run it on every fresh checkout. Without them a
   render stops with a 404 for the first missing clip.
3. `npm run dev` opens Remotion Studio.
4. `npx remotion render <CompositionId> out/my-video-name.mp4`. `out/` is git-ignored.

A video holds only its content: scenes, narration text and timings. Everything
below comes from the shared files.

### The look: `kit/`

Import from `@retivo/video-kit`. Change the kit and every video follows the next
time it is rendered.

- **Tokens and type:** `C` (the app's Graphite Spectrum colours, copied from
  `apps/web/src/styles.css`), `SANS`, `MONO`, and `loadBrandFonts()`, which loads
  the app's own fonts. Call it once at the top of a video's `Root.tsx`. The font files
  live once, in `kit/fonts`; each video's `public/fonts` is a symlink to them (the
  template ships it, `npm run new` keeps it), so Studio and render both serve them.
- **Pieces:** `Stage` (the backdrop every scene sits on), `StepDots` (`current` and
  `total`), `BrandRow`, `Field`, `UiButton`, `Cursor` (with its `CursorPoint` keyframes),
  and `AppSidebar` (a copy of the app's sidebar, to keep in step with
  `apps/web/src/layout/Sidebar.tsx`; `email` and `activeScenario` props, and
  `SIDEBAR_WIDTH`).
- **Layout:** `LeftColumn` and `RightArea`, the text-left, app-right frame.
- **Timing:** `FPS`, `WIDTH`, `HEIGHT`, `FADE_FRAMES` (20), `sceneFade()` for the
  fade between scenes, `totalDuration([...])` for the length of scenes joined by
  fades, `FIRST_CLIP_FRAME` (26), `TITLE_FIRST_CLIP_FRAME` (12) and
  `SCENE_TAIL_FRAMES` (44).
- **Narration:** `<Narration clip="key-2" from={96} />` plays
  `public/voiceover/key-2.mp3` at that frame of the scene.

### Narration

`npm run voiceover` (run in a video's folder) reads that video's `narration.json`
and writes one MP3 per line, using [Kokoro](https://github.com/thewh1teagle/kokoro-onnx),
an open-source neural voice that runs locally. No account, no API key, nothing sent
over the network. Clip ids are lower-case letters, digits and hyphens; clips of lines
you removed or renamed are deleted.

- **Voice:** `voice.json` sets it for every video. `VOICE=am_adam SPEED=0.95`
  in front of the command overrides it once. The
  [voice list](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
  has the names.
- **Pronunciation:** names the voice would guess wrong live in
  `pronunciations.json` as exact IPA, and the generator speaks those words from the
  IPA, so a word sounds the same in every clip of every video. Write "Retivo"
  normally in `narration.json`. To add or change a word, edit that file and re-run
  `npm run voiceover` in each video. Entries are single words (letters and digits).
  It matches whole words, ignoring case, and handles "Retivo's". It prints the phonemes for every clip that uses an entry, and
  stops with an error if Kokoro doesn't know a symbol. Write the IPA the way espeak
  does: `ˈ` before the stressed syllable, `ː` for a long vowel; "tea" is `tˈiː`.
- **Timing:** the on-screen actions are keyed to the speech, so after changing the
  wording or the voice, re-check them. The convention: a scene's first clip starts
  at `FIRST_CLIP_FRAME`, and the scene lasts until the last clip ends plus
  `SCENE_TAIL_FRAMES`, which leaves about 1.7 seconds of silence between screens.
  The generator prints each clip's length in frames.
