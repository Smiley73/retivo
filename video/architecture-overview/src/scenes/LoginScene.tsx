/** Step 4: sign-in (tokens) and then unlocking the household key from a slot. */
import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { BrandRow, C, Field, UiButton } from "@retivo/video-kit";
import { sceneTiming } from "../clips";
import { Arrow, Box, Chip, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const LOGIN_TIMING = sceneTiming("login");

/** Sign-in and unlock scene. */
export const LoginScene: React.FC = () => {
  const T = LOGIN_TIMING;
  const frame = useCurrentFrame();
  const signIn = clipAt(T, "login-2");
  const cardIn = interpolate(frame, [signIn - 20, signIn - 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const slots = clipAt(T, "login-4");
  return (
    <StepFrame
      scene="login"
      timing={T}
      headline="Sign in & unlock"
      sub="Signing in proves who you are. Unlocking opens your data."
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 380,
          boxSizing: "border-box",
          padding: 28,
          borderRadius: 18,
          backgroundColor: C.surfaceRaised,
          color: C.ink,
          boxShadow: "0 24px 70px oklch(0.05 0 0 / 0.5)",
          transformOrigin: "0 0",
          scale: 1.1,
          opacity: cardIn,
        }}
      >
        <BrandRow />
        <div style={{ marginTop: 14 }}>
          <Field label="Email" value="dev@local.test" />
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="Password" value="••••••••••••••••" />
        </div>
        <div style={{ marginTop: 16 }}>
          <UiButton label="Sign in" height={42} fullWidth pressAt={signIn + 40} />
        </div>
      </div>

      <Box
        x={470}
        y={0}
        w={430}
        h={120}
        title="Access token"
        sub="5 minutes · memory only"
        tone="accent"
        at={signIn + 50}
      />
      <Box
        x={470}
        y={140}
        w={430}
        h={120}
        title="Refresh token"
        sub="HttpOnly cookie · rotates"
        tone="accent"
        at={clipAt(T, "login-3")}
      />
      <Chip
        x={470}
        y={290}
        text="2nd factor on deployed stacks"
        tone="warn"
        at={clipAt(T, "login-3") + 110}
      />

      <Box x={0} y={470} w={280} h={100} title="Password" sub="slot" at={slots} />
      <Box x={310} y={470} w={280} h={100} title="Recovery key" sub="slot" at={slots + 24} />
      <Box x={620} y={470} w={280} h={100} title="Passkey" sub="optional slot" dashed at={slots + 48} />
      <Arrow from={[140, 570]} to={[340, 650]} at={clipAt(T, "login-5")} />
      <Arrow from={[450, 570]} to={[450, 650]} at={clipAt(T, "login-5") + 6} />
      <Arrow from={[760, 570]} to={[560, 650]} at={clipAt(T, "login-5") + 12} />
      <Box
        x={220}
        y={650}
        w={460}
        h={100}
        title="Household key"
        sub="opened in the browser only"
        tone="accent"
        at={clipAt(T, "login-5")}
      />
    </StepFrame>
  );
};
