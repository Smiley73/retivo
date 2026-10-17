/** Step 3: copy and confirm the recovery key in the app's save dialog. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  C,
  Cursor,
  FIRST_CLIP_FRAME,
  LeftColumn,
  MONO,
  Narration,
  RightArea,
  Stage,
  StepDots,
  UiButton,
} from "@retivo/video-kit";

/** Step 3 of 4: save the recovery key. */
export const RecoveryKeyScene: React.FC = () => {
  const frame = useCurrentFrame();
  const checked = frame >= 310;

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
          <StepDots current={3} total={4} />
        </Interactive.Div>

        <Interactive.Div
          name="Headline"
          style={{
            fontSize: 108,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.04,
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
          Save your recovery key
        </Interactive.Div>

        <Interactive.Div
          name="Point 1"
          style={{
            fontSize: 46,
            lineHeight: 1.25,
            color: C.stageInk,
            fontWeight: 600,
            opacity: interpolate(frame, [96, 112], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: interpolate(frame, [96, 112], ["0px 20px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          It’s the only way back in if you forget your password.
        </Interactive.Div>

        <Interactive.Div
          name="Point 2"
          style={{
            fontSize: 46,
            lineHeight: 1.25,
            color: C.stageMuted,
            opacity: interpolate(frame, [248, 264], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: interpolate(frame, [248, 264], ["0px 20px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Copy it into a password manager.
        </Interactive.Div>

        <Interactive.Div
          name="Point 3"
          style={{
            fontSize: 46,
            lineHeight: 1.25,
            color: C.stageMuted,
            opacity: interpolate(frame, [290, 306], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            translate: interpolate(frame, [290, 306], ["0px 20px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Tick the box, then Continue.
        </Interactive.Div>
      </LeftColumn>

      <RightArea>
        <Interactive.Div
          name="App"
          style={{ position: "relative", width: 520, height: 460, scale: 1.55 }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              boxSizing: "border-box",
              padding: 24,
              borderRadius: 14,
              backgroundColor: C.surfaceRaised,
              boxShadow: "0 28px 80px oklch(0.05 0 0 / 0.55)",
              color: C.ink,
              opacity: interpolate(frame, [0, 22, 336, 356], [0, 1, 1, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: interpolate(frame, [0, 22], ["0px 36px", "0px 0px"], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            <div
              style={{
                height: 28,
                fontSize: 18,
                lineHeight: "28px",
                fontWeight: 600,
              }}
            >
              Save your recovery key
            </div>
            <div
              style={{
                marginTop: 12,
                height: 80,
                fontSize: 14,
                lineHeight: "20px",
              }}
            >
              This recovery key is the only way back into your encrypted data if
              you ever forget your password. Forgetting your password alone is
              enough to need it. Store it somewhere safe, separate from your
              password; a password manager is ideal.
            </div>

            <div style={{ position: "relative", marginTop: 12 }}>
              <div
                style={{
                  boxSizing: "border-box",
                  height: 64,
                  padding: 12,
                  borderRadius: 6,
                  fontSize: 14,
                  lineHeight: "20px",
                  backgroundColor: C.warningSubtle,
                  border: `1px solid ${C.warning}`,
                }}
              >
                We can’t recover it for you, so if you lose both your password
                and this key, your encrypted data is gone for good. No one can
                read it.
              </div>
              <div
                style={{
                  position: "absolute",
                  inset: -5,
                  borderRadius: 10,
                  border: `3px solid ${C.warning}`,
                  opacity: interpolate(
                    frame,
                    [192, 200, 210, 220, 230, 242],
                    [0, 1, 0.3, 1, 0.3, 0],
                    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                  ),
                }}
              />
            </div>

            <div style={{ position: "relative", marginTop: 16 }}>
              <div
                style={{
                  boxSizing: "border-box",
                  height: 52,
                  padding: 16,
                  borderRadius: 6,
                  border: `1px solid ${C.lineStrong}`,
                  backgroundColor: C.surface,
                  fontFamily: MONO,
                  fontSize: 14,
                  lineHeight: "20px",
                  letterSpacing: "0.05em",
                  whiteSpace: "nowrap",
                }}
              >
                7F3A-91C2-0B4E-D85A-26F1-C3E9-4A70-B58D
              </div>
              <div
                style={{
                  position: "absolute",
                  top: -9,
                  right: 12,
                  padding: "1px 8px",
                  borderRadius: 4,
                  backgroundColor: C.ink,
                  color: C.surfaceRaised,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                }}
              >
                EXAMPLE ONLY
              </div>
            </div>

            <div
              style={{
                marginTop: 16,
                height: 38,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <UiButton
                label="Copy recovery key"
                variant="secondary"
                pressAt={256}
              />
              <div
                style={{
                  fontSize: 12,
                  color: C.muted,
                  opacity: interpolate(
                    frame,
                    [258, 264, 312, 320],
                    [0, 1, 1, 0],
                    {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    },
                  ),
                }}
              >
                Copied to clipboard.
              </div>
            </div>

            <div
              style={{
                marginTop: 16,
                height: 20,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 14,
              }}
            >
              <div
                style={{
                  boxSizing: "border-box",
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  border: `1px solid ${checked ? C.accent : C.inputLine}`,
                  backgroundColor: checked ? C.accent : C.surface,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  scale: interpolate(frame, [310, 314, 319], [1, 0.85, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                <svg
                  viewBox="0 0 16 16"
                  width={14}
                  height={14}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={2.5}
                  style={{ opacity: checked ? 1 : 0 }}
                >
                  <path
                    d="M3 8.5l3 3 7-7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              I have saved my recovery key
            </div>

            <div
              style={{ marginTop: 20, height: 38, display: "flex", gap: 12 }}
            >
              <UiButton label="Continue" disabled={!checked} pressAt={334} />
              <UiButton label="Cancel" variant="secondary" />
            </div>
          </div>

          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 20,
              opacity: interpolate(frame, [342, 360], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              scale: interpolate(frame, [342, 360], [0.8, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 48,
                backgroundColor: C.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg
                viewBox="0 0 16 16"
                width={52}
                height={52}
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
            <div
              style={{
                fontSize: 30,
                fontWeight: 800,
                letterSpacing: "-0.02em",
                color: C.stageInk,
              }}
            >
              Key saved
            </div>
          </div>

          <Cursor
            points={[
              { frame: 226, x: 440, y: 300 },
              { frame: 248, x: 104, y: 323 },
              { frame: 266, x: 104, y: 323 },
              { frame: 302, x: 34, y: 368 },
              { frame: 314, x: 34, y: 368 },
              { frame: 328, x: 71, y: 417 },
              { frame: 342, x: 71, y: 417 },
            ]}
            clicks={[256, 310, 334]}
            hideAt={340}
          />
        </Interactive.Div>
      </RightArea>
      <Narration clip="key-1" from={FIRST_CLIP_FRAME} />
      <Narration clip="key-2" from={96} />
      <Narration clip="key-3" from={248} />
    </Stage>
  );
};
