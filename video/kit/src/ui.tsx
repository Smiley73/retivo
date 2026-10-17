/**
 * The small mock-UI pieces shared by every video: the scene backdrop, step
 * dots, and the app's brand row, field, button and mouse cursor. Sizes are the
 * app's own, in CSS px, so a scene scales them up as one block.
 */
import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { C, SANS } from "./theme";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

/** Soft graphite stage with a faint green glow, shared by every scene. */
export const Stage: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      backgroundColor: C.stage,
      backgroundImage: `radial-gradient(ellipse 60% 70% at 78% 50%, oklch(0.45 0.09 165 / 0.16), transparent 70%)`,
      fontFamily: SANS,
      color: C.stageInk,
    }}
  >
    {children}
  </div>
);

/** "STEP n OF total" with a bar per step; the current one is longest. */
export const StepDots: React.FC<{ current: number; total: number }> = ({
  current,
  total,
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
    {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
      <div
        key={n}
        style={{
          height: 10,
          width: n === current ? 64 : 28,
          borderRadius: 5,
          backgroundColor: n <= current ? C.accentLinkDark : C.stageLine,
        }}
      />
    ))}
    <div
      style={{
        marginLeft: 14,
        fontSize: 32,
        fontWeight: 600,
        letterSpacing: "0.08em",
        color: C.stageMuted,
      }}
    >
      STEP {current} OF {total}
    </div>
  </div>
);

/** The wordmark and tagline at the top of the app's auth cards. */
export const BrandRow: React.FC = () => (
  <div>
    <div style={{ display: "flex", alignItems: "center", gap: 12, height: 24 }}>
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: C.brand,
        }}
      />
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          letterSpacing: "-0.01em",
          color: C.ink,
        }}
      >
        RETIVO
      </div>
    </div>
    <div
      style={{
        height: 20,
        marginTop: 4,
        fontSize: 14,
        lineHeight: "20px",
        color: C.muted,
      }}
    >
      Model your retirement. See the possibilities.
    </div>
  </div>
);

/** A labelled text field showing `value`, as in the app's forms. */
export const Field: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div>
    <div
      style={{
        height: 20,
        fontSize: 14,
        lineHeight: "20px",
        fontWeight: 500,
        color: C.ink,
      }}
    >
      {label}
    </div>
    <div
      style={{
        height: 42,
        marginTop: 4,
        boxSizing: "border-box",
        border: `1px solid ${C.inputLine}`,
        borderRadius: 6,
        backgroundColor: C.surface,
        padding: "0 12px",
        display: "flex",
        alignItems: "center",
        fontSize: 14,
        color: C.ink,
      }}
    >
      {value}
    </div>
  </div>
);

/** App button; `pressAt` is the local frame the cursor clicks it. */
export const UiButton: React.FC<{
  label: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
  pressAt?: number;
  height?: number;
  fullWidth?: boolean;
}> = ({
  label,
  variant = "primary",
  disabled = false,
  pressAt,
  height = 38,
  fullWidth = false,
}) => {
  const frame = useCurrentFrame();
  const press =
    pressAt === undefined
      ? 1
      : interpolate(
          frame,
          [pressAt - 1, pressAt + 2, pressAt + 9],
          [1, 0.95, 1],
          clamp,
        );
  const primary = variant === "primary";
  return (
    <div
      style={{
        boxSizing: "border-box",
        height,
        padding: "0 16px",
        width: fullWidth ? "100%" : undefined,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        fontSize: 14,
        fontWeight: 500,
        whiteSpace: "nowrap",
        opacity: disabled ? 0.5 : 1,
        scale: press,
        backgroundColor: primary ? C.accent : C.surfaceRaised,
        color: primary ? C.accentInk : C.accentLink,
        border: primary ? "none" : `1px solid ${C.lineStrong}`,
        boxShadow: primary ? "0 1px 2px oklch(0.2 0.01 264 / 0.2)" : "none",
      }}
    >
      {label}
    </div>
  );
};

/** One keyframe of the cursor's path: where it is at a local frame. */
export type CursorPoint = { frame: number; x: number; y: number };

/**
 * Animated mouse pointer in the coordinate space of its (scaled) parent.
 * `points` are keyframes (at least two, frames strictly increasing), `clicks`
 * are the local frames it clicks on, and it fades out from `hideAt`.
 */
export const Cursor: React.FC<{
  points: CursorPoint[];
  clicks: number[];
  hideAt?: number;
}> = ({ points, clicks, hideAt }) => {
  const frame = useCurrentFrame();
  if (points.length < 2) {
    throw new Error("Cursor needs at least two points to move between");
  }
  const frames = points.map((p) => p.frame);
  const ease = Easing.bezier(0.45, 0, 0.2, 1);
  const x = interpolate(
    frame,
    frames,
    points.map((p) => p.x),
    { ...clamp, easing: ease },
  );
  const y = interpolate(
    frame,
    frames,
    points.map((p) => p.y),
    { ...clamp, easing: ease },
  );
  const fadeIn = interpolate(frame, [frames[0], frames[0] + 8], [0, 1], clamp);
  const fadeOut =
    hideAt === undefined
      ? 1
      : interpolate(frame, [hideAt, hideAt + 10], [1, 0], clamp);
  const opacity = fadeIn * fadeOut;
  return (
    <>
      {clicks.map((c, index) => {
        const t = frame - c;
        if (t < 0 || t > 18) return null;
        return (
          <div
            key={`${c}-${index}`}
            style={{
              position: "absolute",
              left: x - 18,
              top: y - 18,
              width: 36,
              height: 36,
              borderRadius: 18,
              border: `2px solid ${C.accentLink}`,
              opacity: interpolate(t, [0, 18], [0.6, 0], clamp),
              scale: interpolate(t, [0, 18], [0.3, 1.2], clamp),
            }}
          />
        );
      })}
      <svg
        width={26}
        height={26}
        viewBox="0 0 24 24"
        style={{
          position: "absolute",
          left: x - 3,
          top: y - 2,
          opacity,
          filter: "drop-shadow(0 2px 3px oklch(0.1 0 0 / 0.35))",
        }}
      >
        <path
          d="M3 2 L3 19 L7.5 14.8 L10.4 21.5 L13 20.4 L10.2 13.8 L16.5 13.8 Z"
          fill="#111"
          stroke="#fff"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};
