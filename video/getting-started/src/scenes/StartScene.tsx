/** Step 1: start the app locally, typed into a terminal, then open it in the browser. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  C,
  FIRST_CLIP_FRAME,
  LeftColumn,
  MONO,
  Narration,
  SANS,
  Stage,
  StepDots,
} from "@retivo/video-kit";

const LINES = [
  { cmd: "pnpm install", start: 76, note: "", noteAt: 0 },
  { cmd: "cp .env.example .env", start: 96, note: "", noteAt: 0 },
  { cmd: "pnpm emu:up", start: 140, note: "Docker emulators", noteAt: 156 },
  { cmd: "pnpm dev", start: 169, note: "API :3001 · web :5173", noteAt: 184 },
];

/** Step 1 of 4: start it. */
export const StartScene: React.FC = () => {
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
          <StepDots current={1} total={4} />
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
          Start it
        </Interactive.Div>

        <Interactive.Div
          name="Subhead"
          style={{
            fontSize: 48,
            lineHeight: 1.25,
            color: C.stageMuted,
            opacity: interpolate(frame, [14, 34], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [14, 34], ["0px 24px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Four commands. Everything runs on your machine.
        </Interactive.Div>

        <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
          {[
            { label: "Node 24", at: 40 },
            { label: "pnpm 10", at: 48 },
            { label: "Docker", at: 56 },
          ].map((p) => (
            <div
              key={p.label}
              style={{
                padding: "10px 24px",
                borderRadius: 999,
                border: `2px solid ${C.stageLine}`,
                backgroundColor: C.stageRaised,
                fontSize: 34,
                fontWeight: 600,
                opacity: interpolate(frame, [p.at, p.at + 12], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }),
              }}
            >
              {p.label}
            </div>
          ))}
        </div>
      </LeftColumn>

      <div
        style={{
          position: "absolute",
          left: 900,
          right: 100,
          top: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 36,
        }}
      >
        <Interactive.Div
          name="Terminal"
          style={{
            borderRadius: 20,
            overflow: "hidden",
            backgroundColor: C.stageRaised,
            border: `2px solid ${C.stageLine}`,
            boxShadow: "0 30px 80px oklch(0.05 0 0 / 0.5)",
            opacity: interpolate(frame, [6, 26], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [6, 26], ["0px 40px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "20px 24px",
              borderBottom: `2px solid ${C.stageLine}`,
            }}
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  backgroundColor: C.stageLine,
                }}
              />
            ))}
            <div
              style={{
                marginLeft: 12,
                fontFamily: MONO,
                fontSize: 24,
                color: C.stageMuted,
              }}
            >
              retivo — zsh
            </div>
          </div>
          <div
            style={{
              padding: "28px 32px 32px",
              fontFamily: MONO,
              fontSize: 36,
              display: "flex",
              flexDirection: "column",
              gap: 26,
            }}
          >
            {LINES.map((l) => {
              const chars = Math.floor(
                interpolate(
                  frame,
                  [l.start, l.start + l.cmd.length * 0.8],
                  [0, l.cmd.length],
                  {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  },
                ),
              );
              const done = chars >= l.cmd.length;
              return (
                <div
                  key={l.cmd}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    height: 48,
                  }}
                >
                  <div style={{ opacity: frame >= l.start ? 1 : 0.0 }}>
                    <span style={{ color: C.accentLinkDark }}>$ </span>
                    {l.cmd.slice(0, chars)}
                    {!done && frame >= l.start ? (
                      <span style={{ color: C.stageMuted }}>▍</span>
                    ) : null}
                  </div>
                  {l.note ? (
                    <div
                      style={{
                        fontFamily: SANS,
                        fontSize: 28,
                        fontWeight: 600,
                        padding: "6px 18px",
                        borderRadius: 999,
                        color: C.accentLinkDark,
                        backgroundColor: "oklch(0.26 0.06 165)",
                        opacity: interpolate(
                          frame,
                          [l.noteAt, l.noteAt + 10],
                          [0, 1],
                          {
                            extrapolateLeft: "clamp",
                            extrapolateRight: "clamp",
                          },
                        ),
                      }}
                    >
                      {l.note}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Interactive.Div>

        <Interactive.Div
          name="Address bar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
            padding: "22px 32px",
            borderRadius: 999,
            backgroundColor: C.surfaceRaised,
            color: C.ink,
            boxShadow: "0 20px 60px oklch(0.05 0 0 / 0.45)",
            fontSize: 38,
            fontWeight: 500,
            opacity: interpolate(frame, [210, 226], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [210, 226], ["0px 30px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: C.brand,
            }}
          />
          <span>
            http://<strong style={{ fontWeight: 800 }}>localhost</strong>:5173
          </span>
        </Interactive.Div>

        <Interactive.Div
          name="Localhost tip"
          style={{
            fontSize: 34,
            color: C.stageMuted,
            marginTop: -12,
            paddingLeft: 32,
            opacity: interpolate(frame, [238, 252], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          Open it as localhost, not 127.0.0.1.
        </Interactive.Div>
      </div>
      <Narration clip="start-1" from={FIRST_CLIP_FRAME} />
      <Narration clip="start-2" from={76} />
      <Narration clip="start-3" from={203} />
    </Stage>
  );
};
