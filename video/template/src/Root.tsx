/** Registers the video with Remotion. */
import { Composition } from "remotion";
import {
  FPS,
  HEIGHT,
  WIDTH,
  loadBrandFonts,
  totalDuration,
} from "@retivo/video-kit";
import { TemplateVideo } from "./Video";

loadBrandFonts();

/** The compositions of this video. */
export const RemotionRoot: React.FC = () => (
  <Composition
    id="TemplateVideo"
    component={TemplateVideo}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    // The scene lengths in Video.tsx, in order. Keep the two in sync.
    durationInFrames={totalDuration([155, 180, 120])}
  />
);
