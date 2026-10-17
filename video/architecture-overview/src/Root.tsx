/** Registers the video with Remotion. */
import { Composition } from "remotion";
import {
  FPS,
  HEIGHT,
  WIDTH,
  loadBrandFonts,
  totalDuration,
} from "@retivo/video-kit";
import { ArchitectureOverviewVideo, SCENE_LENGTHS } from "./Video";

loadBrandFonts();

/** The compositions of this video. */
export const RemotionRoot: React.FC = () => (
  <Composition
    id="ArchitectureOverview"
    component={ArchitectureOverviewVideo}
    width={WIDTH}
    height={HEIGHT}
    fps={FPS}
    durationInFrames={totalDuration(SCENE_LENGTHS)}
  />
);
