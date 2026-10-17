/** Closing card: a checklist of what was done and a pointer to the user guide. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { C, FIRST_CLIP_FRAME, Narration, Stage } from "@retivo/video-kit";

const ITEMS = [
  { label: "Started locally", at: 14 },
  { label: "Signed in, encryption on", at: 26 },
  { label: "Recovery key saved", at: 38 },
  { label: "Demo household loaded", at: 50 },
];

/** The closing card. */
export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <Stage>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 0,
          bottom: 0,
          width: 800,
          display: "flex",
          flexDirection: "column",
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
          You’re in.
        </Interactive.Div>
        <Interactive.Div
          name="Subhead"
          style={{
            fontSize: 52,
            lineHeight: 1.25,
            color: C.stageMuted,
            opacity: interpolate(frame, [10, 28], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          Your encrypted household is ready to explore.
        </Interactive.Div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 1000,
          right: 100,
          top: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 26,
        }}
      >
        {ITEMS.map((item) => (
          <div
            key={item.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 28,
              fontSize: 54,
              fontWeight: 600,
              opacity: interpolate(frame, [item.at, item.at + 12], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: interpolate(
                frame,
                [item.at, item.at + 12],
                ["30px 0px", "0px 0px"],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                },
              ),
            }}
          >
            <div
              style={{
                width: 72,
                height: 72,
                flex: "none",
                borderRadius: 36,
                backgroundColor: C.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                viewBox="0 0 16 16"
                width={40}
                height={40}
                fill="none"
                stroke="#fff"
                strokeWidth={2}
                style={{ display: "block" }}
              >
                <path
                  d="M3 8.5l3 3 7-7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            {item.label}
          </div>
        ))}
      </div>

      <Interactive.Div
        name="Footer"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 100,
          textAlign: "center",
          fontSize: 40,
          color: C.stageMuted,
          opacity: interpolate(frame, [80, 96], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        Take the tour in{" "}
        <strong style={{ color: C.stageInk }}>docs/user-guide.md</strong>
      </Interactive.Div>
      <Narration clip="outro-1" from={FIRST_CLIP_FRAME} />
    </Stage>
  );
};
