/** The frame every content scene shares: headline and subhead on the left, the diagram on the right. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  C,
  LeftColumn,
  Narration,
  RightArea,
  Stage,
} from "@retivo/video-kit";
import { SCENE_CLIPS, type SceneKey, type SceneTiming } from "./clips";
import { Canvas } from "./diagram";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/** One content scene: text on the left, `children` drawn on the canvas. */
export const StepFrame: React.FC<{
  scene: SceneKey;
  timing: SceneTiming;
  headline: string;
  sub: string;
  children: React.ReactNode;
}> = ({ scene, timing, headline, sub, children }) => {
  const frame = useCurrentFrame();
  const rise = Easing.bezier(0.16, 1, 0.3, 1);
  return (
    <Stage>
      <LeftColumn>
        <Interactive.Div
          name="Headline"
          style={{
            fontSize: 100,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.04,
            opacity: interpolate(frame, [4, 24], [0, 1], {
              ...clamp,
              easing: rise,
            }),
            translate: interpolate(frame, [4, 24], ["0px 30px", "0px 0px"], {
              ...clamp,
              easing: rise,
            }),
          }}
        >
          {headline}
        </Interactive.Div>
        <Interactive.Div
          name="Subhead"
          style={{
            fontSize: 44,
            lineHeight: 1.25,
            color: C.stageMuted,
            opacity: interpolate(frame, [34, 50], [0, 1], clamp),
          }}
        >
          {sub}
        </Interactive.Div>
      </LeftColumn>
      <RightArea>
        <Canvas>{children}</Canvas>
      </RightArea>
      {SCENE_CLIPS[scene].map((id) => (
        <Narration key={id} clip={id} from={timing.start[id] ?? 0} />
      ))}
    </Stage>
  );
};
