/** Registers the video and each of its scenes with Remotion, so scenes also preview on their own. */
import { Composition, Folder } from "remotion";
import {
  FPS,
  HEIGHT,
  WIDTH,
  loadBrandFonts,
  totalDuration,
} from "@retivo/video-kit";
import { GettingStarted } from "./GettingStarted";
import { TitleScene } from "./scenes/TitleScene";
import { StartScene } from "./scenes/StartScene";
import { SignInScene } from "./scenes/SignInScene";
import { RecoveryKeyScene } from "./scenes/RecoveryKeyScene";
import { DemoDataScene } from "./scenes/DemoDataScene";
import { OutroScene } from "./scenes/OutroScene";

loadBrandFonts();

/** Every composition of this video. */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="GettingStarted-Scenes">
        <Composition
          id="Title"
          component={TitleScene}
          width={WIDTH}
          height={HEIGHT}
          fps={FPS}
          durationInFrames={155}
        />
        <Composition
          id="StartIt"
          component={StartScene}
          width={WIDTH}
          height={HEIGHT}
          fps={FPS}
          durationInFrames={294}
        />
        <Composition
          id="SignIn"
          component={SignInScene}
          width={WIDTH}
          height={HEIGHT}
          fps={FPS}
          durationInFrames={268}
        />
        <Composition
          id="RecoveryKey"
          component={RecoveryKeyScene}
          width={WIDTH}
          height={HEIGHT}
          fps={FPS}
          durationInFrames={392}
        />
        <Composition
          id="DemoData"
          component={DemoDataScene}
          width={WIDTH}
          height={HEIGHT}
          fps={FPS}
          durationInFrames={311}
        />
        <Composition
          id="Outro"
          component={OutroScene}
          width={WIDTH}
          height={HEIGHT}
          fps={FPS}
          durationInFrames={150}
        />
      </Folder>
      <Composition
        id="GettingStarted"
        component={GettingStarted}
        width={WIDTH}
        height={HEIGHT}
        fps={FPS}
        // The scene lengths in GettingStarted.tsx, in order. Keep the two in sync.
        durationInFrames={totalDuration([155, 294, 268, 392, 311, 150])}
      />
    </>
  );
};
