# Architecture Overview

A narrated [Remotion](https://www.remotion.dev) walkthrough of how Retivo fits
together, for people changing its code. Eight steps: local-first, the
components, local versus Amazon runs, sign-in and unlocking, sync, conflicts and
repair, snapshots, and what the server can see.

The content follows [docs/architecture.md](../../docs/architecture.md) and
[docs/security.md](../../docs/security.md). The sign-in card mirrors the app's own
(`LoginPage`); the diagrams are schematic. Numbers shown (five-minute access
token, hourly compactor) come from those docs, so re-check the video when they
change.

The look (colours, fonts, layout, fades), the narration voice and the
pronunciations are shared by all videos; see the [video README](../README.md).
This folder holds only this video's content.

## Commands

Run from this folder, after the [one-time setup](../README.md#one-time-setup-macos).

```console
npm run voiceover    # first time on a checkout, and after editing narration.json
npm run dev          # Remotion Studio, composition "ArchitectureOverview"
npx remotion render ArchitectureOverview out/architecture-overview.mp4
```

The clips in `public/voiceover/` are generated and git-ignored. Without
`npm run voiceover` a render stops with a 404 for the first missing clip.

## Layout

- `narration.json` — the spoken script, one clip per line.
- `src/clips.ts` — the length of every clip and the scene timings derived from
  them. Scenes start their clips one after another, so a scene's length and every
  reveal follow from this table.
- `src/Video.tsx` — the timeline: ten scenes, one fade between each.
- `src/StepFrame.tsx` — the frame the eight content scenes share.
- `src/diagram.tsx` — boxes, frames, chips and arrows that fade in at a given frame.
- `src/scenes/` — one file per scene.

## Timings follow the speech

After changing `narration.json` or the voice, run `npm run voiceover`, copy the
printed frame counts into `CLIP_FRAMES` in `src/clips.ts`, and check each scene.
Scene lengths and the composition's total are computed from that table.
