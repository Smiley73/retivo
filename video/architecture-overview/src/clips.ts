/**
 * Narration clip lengths and the scene timings derived from them.
 *
 * `CLIP_FRAMES` is copied from the output of `npm run voiceover`. After changing
 * narration.json or the voice, regenerate the clips and update this table: every
 * clip start, reveal and scene length follows from it.
 */
import { FIRST_CLIP_FRAME, SCENE_TAIL_FRAMES, TITLE_FIRST_CLIP_FRAME } from "@retivo/video-kit";

/** Frames per clip, from `npm run voiceover`. */
export const CLIP_FRAMES: Record<string, number> = {
  "title-1": 105,
  "local-1": 33,
  "local-2": 123,
  "local-3": 205,
  "local-4": 159,
  "parts-1": 31,
  "parts-2": 180,
  "parts-3": 136,
  "parts-4": 219,
  "env-1": 49,
  "env-2": 250,
  "env-2b": 210,
  "env-3": 305,
  "env-4": 278,
  "login-1": 28,
  "login-2": 249,
  "login-3": 267,
  "login-4": 280,
  "login-5": 126,
  "sync-1": 23,
  "sync-2": 187,
  "sync-3": 98,
  "sync-4": 168,
  "sync-5": 180,
  "repair-1": 40,
  "repair-2": 148,
  "repair-3": 254,
  "repair-4": 253,
  "snap-1": 28,
  "snap-2": 203,
  "snap-3": 196,
  "snap-4": 171,
  "see-1": 40,
  "see-2": 157,
  "see-3": 57,
  "see-4": 169,
  "outro-1": 197,
};

/** Silence between two clips of one scene, in frames. */
const CLIP_GAP = 14;

/** The clips of each scene, in the order they are spoken. */
export const SCENE_CLIPS = {
  title: ["title-1"],
  local: ["local-1", "local-2", "local-3", "local-4"],
  parts: ["parts-1", "parts-2", "parts-3", "parts-4"],
  env: ["env-1", "env-2", "env-2b", "env-3", "env-4"],
  login: ["login-1", "login-2", "login-3", "login-4", "login-5"],
  sync: ["sync-1", "sync-2", "sync-3", "sync-4", "sync-5"],
  repair: ["repair-1", "repair-2", "repair-3", "repair-4"],
  snap: ["snap-1", "snap-2", "snap-3", "snap-4"],
  see: ["see-1", "see-2", "see-3", "see-4"],
  outro: ["outro-1"],
} as const;

/** The name of a scene. */
export type SceneKey = keyof typeof SCENE_CLIPS;

/** When a scene's clips start and how long the scene lasts. */
export type SceneTiming = {
  /** Local start frame of each clip. */
  start: Record<string, number>;
  /** Scene length in frames. */
  length: number;
};

/** Lays a scene's clips out one after another and derives the scene length. */
export const sceneTiming = (key: SceneKey): SceneTiming => {
  let cursor = key === "title" ? TITLE_FIRST_CLIP_FRAME : FIRST_CLIP_FRAME;
  const start: Record<string, number> = {};
  for (const id of SCENE_CLIPS[key]) {
    const frames = CLIP_FRAMES[id];
    if (frames === undefined) throw new Error(`No length for clip ${id}`);
    start[id] = cursor;
    cursor += frames + CLIP_GAP;
  }
  return { start, length: cursor - CLIP_GAP + SCENE_TAIL_FRAMES };
};
