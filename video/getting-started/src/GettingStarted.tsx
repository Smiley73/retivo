/** The video's timeline: six scenes joined by fades. */
import React from "react";
import { TransitionSeries } from "@remotion/transitions";
import { sceneFade } from "@retivo/video-kit";
import { TitleScene } from "./scenes/TitleScene";
import { StartScene } from "./scenes/StartScene";
import { SignInScene } from "./scenes/SignInScene";
import { RecoveryKeyScene } from "./scenes/RecoveryKeyScene";
import { DemoDataScene } from "./scenes/DemoDataScene";
import { OutroScene } from "./scenes/OutroScene";

// 155 + 294 + 268 + 392 + 311 + 150 = 1570 frames, minus 5 fades (FADE_FRAMES) = 1470.
/** The full video. */
export const GettingStarted: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence name="Title" durationInFrames={155}>
      <TitleScene />
    </TransitionSeries.Sequence>
    {sceneFade()}
    <TransitionSeries.Sequence name="Start it" durationInFrames={294}>
      <StartScene />
    </TransitionSeries.Sequence>
    {sceneFade()}
    <TransitionSeries.Sequence name="Sign in" durationInFrames={268}>
      <SignInScene />
    </TransitionSeries.Sequence>
    {sceneFade()}
    <TransitionSeries.Sequence name="Recovery key" durationInFrames={392}>
      <RecoveryKeyScene />
    </TransitionSeries.Sequence>
    {sceneFade()}
    <TransitionSeries.Sequence name="Demo data" durationInFrames={311}>
      <DemoDataScene />
    </TransitionSeries.Sequence>
    {sceneFade()}
    <TransitionSeries.Sequence name="Outro" durationInFrames={150}>
      <OutroScene />
    </TransitionSeries.Sequence>
  </TransitionSeries>
);
