# Getting Started with Retivo locally

A short [Remotion](https://www.remotion.dev) walkthrough of a first run on a
local copy, with a spoken narration: start it, sign in and set up encryption,
save the recovery key, load the demo data.

The steps follow [docs/local-setup.md](../../docs/local-setup.md) and
[docs/user-guide.md](../../docs/user-guide.md). The sign-in, encryption and
recovery-key screens, the demo dialog and the sidebar mirror the app's own
(`LoginPage`, `RecoveryKeyModal`, `FirstRunDemoModal`, `Sidebar`). The dashboard
behind the dialog is stylised, not a copy of the real page, and the dialog leaves
out the app's demo-data counts on purpose so the video stays true as they change.
The recovery key shown is made up and labelled as an example.

The look (colours, fonts, sidebar, layout, fades), the narration voice and the
pronunciations are shared by all videos; see the [video README](../README.md). This
folder holds only this video's content.

## Commands

Run from this folder, after the [one-time setup](../README.md#one-time-setup-macos).

```console
npm run voiceover    # first time on a checkout, and after editing narration.json
npm run dev          # Remotion Studio, composition "GettingStarted"
npx remotion render GettingStarted out/getting-started.mp4
```

The clips in `public/voiceover/` are generated and git-ignored. Without
`npm run voiceover` a render stops with a 404 for the first missing clip.

## Layout

- `narration.json` — the spoken script, one clip per line.
- `src/GettingStarted.tsx` — the timeline: six scenes, one fade between each.
- `src/scenes/` — one file per scene. Each is also registered in `src/Root.tsx` so
  it can be previewed on its own.

## Timings follow the speech

Each scene starts its clips at fixed frames (`<Narration from={…} />` at the bottom
of each scene file), and the on-screen actions are keyed to the pauses inside the
clips. If you change the wording or the voice, re-check those frames and the scene
lengths in `src/GettingStarted.tsx` and `src/Root.tsx` (the total is
`totalDuration([...])`). The convention is in the
[video README](../README.md#narration).
