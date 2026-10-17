/** Closing card. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { C, FIRST_CLIP_FRAME, Narration, Stage } from "@retivo/video-kit";

/** The closing card. */
export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <Stage>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
        }}
      >
        <Interactive.Div
          name="Headline"
          style={{
            fontSize: 168,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1,
            opacity: interpolate(frame, [0, 20], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [0, 20], ["0px 36px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          That’s it.
        </Interactive.Div>
        <Interactive.Div
          name="Subhead"
          style={{
            fontSize: 52,
            color: C.stageMuted,
            opacity: interpolate(frame, [10, 28], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          Thanks for watching.
        </Interactive.Div>
      </div>
      <Narration clip="outro-1" from={FIRST_CLIP_FRAME} />
    </Stage>
  );
};
