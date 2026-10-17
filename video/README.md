# Videos

Product videos for Retivo, made with [Remotion](https://www.remotion.dev). One npm
workspace: install once here, and every video shares the same look and tooling.

| Folder | What it is |
|---|---|
| [kit/](kit/) | The shared look: colour tokens, the app's fonts, the mock-UI pieces (sidebar, buttons, cursor, step dots), the two-column layout, fade and timing constants, the narration player |

These are npm projects, outside the pnpm workspace, so lint, knip, typecheck and CI
of the app do not see them. `npm run lint` here checks the kit and every video. Dependabot watches `video/` on its own entry in
`.github/dependabot.yml`; zod and Remotion major updates are left to be done by
hand, together with Remotion, after reading the upstream licence terms.

Remotion has its own licence terms. Whether you can use it for free depends on who
you are, so read the [upstream terms](https://www.remotion.dev/docs/license) before
using it in your organisation.

## One-time setup (macOS)

You need [Node.js](https://nodejs.org) 20.19 or newer, 22.13 or newer, or 24 (the
repo itself uses 24). Then, from this folder:

```console
npm install
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

When asking Claude to build scenes, tell it to import from `@retivo/video-kit`
instead of restyling from scratch.

## The look: `kit/`

Import from `@retivo/video-kit`. Change the kit and every video follows the next
time it is rendered.

- **Tokens and type:** `C` (the app's Graphite Spectrum colours, copied from
  `apps/web/src/styles.css`), `SANS`, `MONO`, and `loadBrandFonts()`, which loads
  the app's own fonts. Call it once at the top of a video's `Root.tsx`. The font files
  live once, in `kit/fonts`; each video's `public/fonts` must be a symlink to them,
  so Studio and render both serve them.
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
