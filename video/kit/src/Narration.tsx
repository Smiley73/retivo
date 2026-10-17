/** Plays a video's narration clips inside its scenes. */
import React from "react";
import { Audio } from "@remotion/media";
import { staticFile } from "remotion";

/**
 * One narration clip, `public/voiceover/<clip>.mp3` of the video it is used in,
 * starting at local frame `from` of the surrounding scene.
 */
export const Narration: React.FC<{ clip: string; from: number }> = ({
  clip,
  from,
}) => <Audio src={staticFile(`voiceover/${clip}.mp3`)} from={from} />;
