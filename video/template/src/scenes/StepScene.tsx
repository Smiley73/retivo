/** One example step: text on the left, a mock card with a click on the right. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  BrandRow,
  C,
  Cursor,
  FIRST_CLIP_FRAME,
  Field,
  LeftColumn,
  Narration,
  RightArea,
  Stage,
  StepDots,
  UiButton,
} from "@retivo/video-kit";

/** An example step scene. */
export const StepScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <Stage>
      <LeftColumn>
        <Interactive.Div
          name="Step"
          style={{
            opacity: interpolate(frame, [0, 14], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          <StepDots current={1} total={1} />
        </Interactive.Div>

        <Interactive.Div
          name="Headline"
          style={{
            fontSize: 116,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.02,
            opacity: interpolate(frame, [4, 24], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [4, 24], ["0px 30px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Describe the step
        </Interactive.Div>

        <Interactive.Div
          name="Subhead"
          style={{
            fontSize: 48,
            lineHeight: 1.25,
            color: C.stageMuted,
            opacity: interpolate(frame, [34, 50], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          One sentence about what happens on screen.
        </Interactive.Div>
      </LeftColumn>

      <RightArea>
        <Interactive.Div
          name="App"
          style={{ position: "relative", width: 430, height: 252, scale: 1.6 }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              boxSizing: "border-box",
              padding: 32,
              borderRadius: 20,
              backgroundColor: C.surfaceRaised,
              boxShadow: "0 24px 70px oklch(0.05 0 0 / 0.5)",
              color: C.ink,
              opacity: interpolate(frame, [4, 24], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}
          >
            <BrandRow />
            <div style={{ marginTop: 16 }}>
              <Field label="Email" value="dev@local.test" />
            </div>
            <div style={{ marginTop: 16 }}>
              <UiButton label="Continue" height={42} fullWidth pressAt={110} />
            </div>
          </div>
          <Cursor
            points={[
              { frame: 50, x: 380, y: 230 },
              { frame: 100, x: 215, y: 199 },
              { frame: 130, x: 215, y: 199 },
            ]}
            clicks={[110]}
          />
        </Interactive.Div>
      </RightArea>
      <Narration clip="step-1" from={FIRST_CLIP_FRAME} />
    </Stage>
  );
};
