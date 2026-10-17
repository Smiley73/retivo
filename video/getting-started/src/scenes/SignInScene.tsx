/** Step 2: sign in with the pre-filled dev account, then set up encryption. */
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

const cardStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  width: 430,
  boxSizing: "border-box",
  padding: 32,
  borderRadius: 20,
  backgroundColor: C.surfaceRaised,
  boxShadow: "0 24px 70px oklch(0.05 0 0 / 0.5)",
  color: C.ink,
} as const;

const headingStyle = {
  marginTop: 16,
  height: 38,
  fontSize: 30,
  lineHeight: "38px",
  fontWeight: 800,
  letterSpacing: "-0.03em",
} as const;

/** Step 2 of 4: sign in and set up encryption. */
export const SignInScene: React.FC = () => {
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
          <StepDots current={2} total={4} />
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
          Sign in
        </Interactive.Div>

        <div style={{ position: "relative", height: 180 }}>
          <Interactive.Div
            name="Subhead sign in"
            style={{
              position: "absolute",
              inset: 0,
              fontSize: 48,
              lineHeight: 1.25,
              color: C.stageMuted,
              opacity: interpolate(frame, [14, 34, 138, 150], [0, 1, 1, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: interpolate(frame, [14, 34], ["0px 24px", "0px 0px"], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            On localhost, a ready-made dev account is pre-filled.
          </Interactive.Div>
          <Interactive.Div
            name="Subhead encryption"
            style={{
              position: "absolute",
              inset: 0,
              fontSize: 48,
              lineHeight: 1.25,
              color: C.stageMuted,
              opacity: interpolate(frame, [150, 166], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: interpolate(
                frame,
                [150, 166],
                ["0px 24px", "0px 0px"],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                },
              ),
            }}
          >
            Then set up encryption, with the same password.
          </Interactive.Div>
        </div>

        <Interactive.Div
          name="Next hint"
          style={{
            fontSize: 40,
            fontWeight: 600,
            color: C.accentLinkDark,
            opacity: interpolate(frame, [244, 258], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          Next: your recovery key →
        </Interactive.Div>
      </LeftColumn>

      <RightArea>
        <Interactive.Div
          name="App"
          style={{
            position: "relative",
            width: 430,
            height: 542,
            scale: 1.6,
          }}
        >
          <div
            style={{
              ...cardStyle,
              height: 542,
              opacity: interpolate(frame, [4, 24, 146, 160], [0, 1, 1, 0], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: interpolate(
                frame,
                [4, 24, 146, 160],
                ["0px 40px", "0px 0px", "0px 0px", "-40px 0px"],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                },
              ),
            }}
          >
            <BrandRow />
            <div style={headingStyle}>Sign in</div>
            <div style={{ marginTop: 12 }}>
              <Field label="Email" value="dev@local.test" />
            </div>
            <div style={{ marginTop: 16 }}>
              <Field label="Password" value="••••••••••••••" />
            </div>
            <div style={{ marginTop: 16 }}>
              <UiButton
                label={frame >= 128 ? "Signing in…" : "Sign in"}
                height={42}
                fullWidth
                pressAt={128}
              />
            </div>
            <div
              style={{
                marginTop: 16,
                height: 20,
                lineHeight: "20px",
                textAlign: "center",
                fontSize: 14,
                color: C.accentLink,
              }}
            >
              Forgot password?
            </div>
            <div
              style={{
                marginTop: 16,
                height: 20,
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 12,
                color: C.muted,
              }}
            >
              <div style={{ flex: 1, height: 1, backgroundColor: C.line }} />
              or
              <div style={{ flex: 1, height: 1, backgroundColor: C.line }} />
            </div>
            <div style={{ marginTop: 8 }}>
              <UiButton
                label="Sign in with a passkey"
                variant="secondary"
                height={42}
                fullWidth
              />
            </div>
            <div
              style={{
                marginTop: 16,
                height: 20,
                lineHeight: "20px",
                textAlign: "center",
                fontSize: 14,
                color: C.muted,
              }}
            >
              Don’t have an account? Sign up
            </div>
          </div>

          <div
            style={{
              ...cardStyle,
              height: 394,
              opacity: interpolate(frame, [150, 168], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              translate: interpolate(
                frame,
                [150, 168],
                ["40px 0px", "0px 0px"],
                {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                },
              ),
            }}
          >
            <BrandRow />
            <div style={headingStyle}>Set up encryption</div>
            <div
              style={{
                marginTop: 12,
                height: 80,
                fontSize: 14,
                lineHeight: "20px",
                color: C.muted,
              }}
            >
              Your financial data is encrypted before it leaves this device.
              Enter your account password (the same one you just signed in
              with). You’ll get a recovery key next, in case you ever forget it.
            </div>
            <div style={{ marginTop: 12 }}>
              <Field label="Password" value="••••••••••••••" />
            </div>
            <div style={{ marginTop: 16 }}>
              <UiButton
                label={frame >= 214 ? "Setting up…" : "Set up encryption"}
                height={42}
                fullWidth
                pressAt={214}
              />
            </div>
          </div>

          <Cursor
            points={[
              { frame: 60, x: 380, y: 500 },
              { frame: 110, x: 215, y: 331 },
              { frame: 134, x: 215, y: 331 },
              { frame: 158, x: 330, y: 450 },
              { frame: 206, x: 215, y: 341 },
              { frame: 244, x: 215, y: 341 },
            ]}
            clicks={[128, 214]}
          />
        </Interactive.Div>
      </RightArea>
      <Narration clip="signin-1" from={FIRST_CLIP_FRAME} />
      <Narration clip="signin-2" from={138} />
    </Stage>
  );
};
