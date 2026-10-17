/** Frame rate, size, and the fade and narration timing every video follows. */
import React from "react";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";

/** Frame rate, width and height of every video: 30 fps at 1080p. */
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/** Length of the fade between two scenes. Both scenes play during it. */
export const FADE_FRAMES = 20;

/**
 * Local frame a scene's first narration clip should start at, so the speech
 * begins just after the fade-in has finished.
 */
export const FIRST_CLIP_FRAME = 26;

/**
 * Same, for an opening title scene, which has no fade-in to wait for: its first
 * clip starts as the title settles.
 */
export const TITLE_FIRST_CLIP_FRAME = 12;

/**
 * Silence to leave after a scene's last narration clip before the next screen
 * starts speaking: the scene's tail is `lastClipEnd + SCENE_TAIL_FRAMES`, which
 * includes the fade out.
 */
export const SCENE_TAIL_FRAMES = 44;

/**
 * The fade between two scenes. Call it as a child of <TransitionSeries>:
 * `{sceneFade()}`. (A wrapper component would not be recognised there.)
 */
export const sceneFade = (): React.ReactElement => (
  <TransitionSeries.Transition
    presentation={fade()}
    timing={linearTiming({ durationInFrames: FADE_FRAMES })}
  />
);

/** Total length of scenes joined with `sceneFade()`: the fades overlap them. */
export const totalDuration = (sceneFrames: number[]): number =>
  sceneFrames.reduce((sum, frames) => sum + frames, 0) -
  FADE_FRAMES * Math.max(0, sceneFrames.length - 1);
