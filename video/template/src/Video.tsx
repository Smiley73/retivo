/** The video's timeline: its scenes joined by fades. */
import React from "react";
import { TransitionSeries } from "@remotion/transitions";
import { sceneFade } from "@retivo/video-kit";
import { TitleScene } from "./scenes/TitleScene";
import { StepScene } from "./scenes/StepScene";
import { OutroScene } from "./scenes/OutroScene";

// Scene lengths: speech end + SCENE_TAIL_FRAMES (see @retivo/video-kit timing).
/** The full video. */
export const TemplateVideo: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence name="Title" durationInFrames={155}>
      <TitleScene />
    </TransitionSeries.Sequence>
    {sceneFade()}
    <TransitionSeries.Sequence name="Step" durationInFrames={180}>
      <StepScene />
    </TransitionSeries.Sequence>
    {sceneFade()}
    <TransitionSeries.Sequence name="Outro" durationInFrames={120}>
      <OutroScene />
    </TransitionSeries.Sequence>
  </TransitionSeries>
);
