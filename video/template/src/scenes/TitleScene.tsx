/** Opening title card: the wordmark and the video's title. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { C, Narration, Stage, TITLE_FIRST_CLIP_FRAME } from "@retivo/video-kit";

/** The opening title card. */
export const TitleScene: React.FC = () => {
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
          gap: 40,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <Interactive.Div
            name="Logo mark"
            style={{
              width: 76,
              height: 76,
              borderRadius: 38,
              backgroundColor: C.brand,
              scale: interpolate(frame, [0, 20], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
                output: "perceptual-scale",
              }),
            }}
          />
          <Interactive.Div
            name="Wordmark"
            style={{
              fontSize: 76,
              fontWeight: 800,
              letterSpacing: "-0.03em",
              lineHeight: 1,
              color: C.stageMuted,
              opacity: interpolate(frame, [6, 22], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            RETIVO
          </Interactive.Div>
        </div>

        <Interactive.Div
          name="Title"
          style={{
            fontSize: 132,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.04,
            textAlign: "center",
            opacity: interpolate(frame, [10, 32], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [10, 32], ["0px 36px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Your video title
        </Interactive.Div>
      </div>
      <Narration clip="title-1" from={TITLE_FIRST_CLIP_FRAME} />
    </Stage>
  );
};
