/** Opening title card: the wordmark, the video's title and its four step pills. */
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
          Getting Started
          <br />
          with Retivo locally
        </Interactive.Div>

        <div style={{ display: "flex", gap: 20, marginTop: 28 }}>
          {[
            { n: "1", label: "Start it", at: 76 },
            { n: "2", label: "Sign in", at: 84 },
            { n: "3", label: "Save your key", at: 92 },
            { n: "4", label: "Load demo data", at: 100 },
          ].map((s) => (
            <div
              key={s.n}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "16px 30px 16px 18px",
                borderRadius: 999,
                border: `2px solid ${C.stageLine}`,
                backgroundColor: C.stageRaised,
                fontSize: 36,
                fontWeight: 600,
                opacity: interpolate(frame, [s.at, s.at + 14], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                }),
                translate: interpolate(
                  frame,
                  [s.at, s.at + 14],
                  ["0px 20px", "0px 0px"],
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
                  width: 48,
                  height: 48,
                  borderRadius: 24,
                  backgroundColor: C.accent,
                  color: C.accentInk,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 30,
                  fontWeight: 700,
                }}
              >
                {s.n}
              </div>
              {s.label}
            </div>
          ))}
        </div>
      </div>
      <Narration clip="title-1" from={TITLE_FIRST_CLIP_FRAME} />
    </Stage>
  );
};
