/**
 * Boxes, frames, chips and arrows for the architecture diagrams. Everything is
 * absolutely positioned on a fixed canvas, and each piece fades in at the local
 * frame `at`, so a scene can key its reveals to the narration.
 */
import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { C, MONO } from "@retivo/video-kit";
import type { SceneTiming } from "./clips";

/** Canvas size in px; the right-hand area of a scene centres it. */
export const CANVAS_W = 900;
export const CANVAS_H = 760;

const ease = Easing.bezier(0.16, 1, 0.3, 1);

/** 0 before `at`, 1 once `dur` frames have passed. */
const useProgress = (at: number, dur = 16): number => {
  const frame = useCurrentFrame();
  return interpolate(frame, [at, at + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
};

/** Start frame of a clip within its scene. */
export const clipAt = (timing: SceneTiming, id: string): number => {
  const value = timing.start[id];
  if (value === undefined) throw new Error(`Unknown clip ${id}`);
  return value;
};

/** The area diagrams are drawn on. */
export const Canvas: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div style={{ position: "relative", width: CANVAS_W, height: CANVAS_H }}>
    {children}
  </div>
);

/** How a box is coloured. */
export type Tone = "default" | "accent" | "warn" | "cipher";

const TONES: Record<Tone, { bg: string; line: string }> = {
  default: { bg: C.stageRaised, line: C.stageLine },
  accent: { bg: "oklch(0.27 0.06 165)", line: C.accentLinkDark },
  warn: { bg: "oklch(0.27 0.05 70)", line: "oklch(0.72 0.13 70)" },
  cipher: { bg: "oklch(0.22 0.03 264)", line: "oklch(0.55 0.08 264)" },
};

/** A labelled box: title, an optional description and an optional mono tag. */
export const Box: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  tag?: string;
  tone?: Tone;
  dashed?: boolean;
  at: number;
}> = ({ x, y, w, h, title, sub, tag, tone = "default", dashed, at }) => {
  const p = useProgress(at);
  const t = TONES[tone];
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: "border-box",
        padding: "0 22px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 6,
        borderRadius: 18,
        backgroundColor: t.bg,
        border: `2px ${dashed ? "dashed" : "solid"} ${t.line}`,
        opacity: p,
        translate: `0px ${(1 - p) * 18}px`,
      }}
    >
      <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>
        {title}
      </div>
      {sub ? (
        <div style={{ fontSize: 24, lineHeight: 1.2, color: C.stageMuted }}>
          {sub}
        </div>
      ) : null}
      {tag ? (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 21,
            color: C.accentLinkDark,
            lineHeight: 1.2,
          }}
        >
          {tag}
        </div>
      ) : null}
    </div>
  );
};

/** An outline around a group, with a small caps label. */
export const Frame: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  at: number;
}> = ({ x, y, w, h, label, at }) => {
  const p = useProgress(at, 20);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: "border-box",
        borderRadius: 26,
        border: `2px dashed ${C.stageLine}`,
        opacity: p,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 22,
          top: -17,
          padding: "0 12px",
          backgroundColor: C.stage,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: "0.1em",
          color: C.stageMuted,
        }}
      >
        {label}
      </div>
    </div>
  );
};

/** A short pill of text. */
export const Chip: React.FC<{
  x: number;
  y: number;
  text: string;
  tone?: Tone;
  mono?: boolean;
  at: number;
}> = ({ x, y, text, tone = "default", mono, at }) => {
  const p = useProgress(at);
  const t = TONES[tone];
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        padding: "10px 22px",
        borderRadius: 999,
        backgroundColor: t.bg,
        border: `2px solid ${t.line}`,
        fontFamily: mono ? MONO : undefined,
        fontSize: mono ? 22 : 26,
        fontWeight: mono ? 500 : 600,
        whiteSpace: "nowrap",
        opacity: p,
        translate: `0px ${(1 - p) * 12}px`,
      }}
    >
      {text}
    </div>
  );
};

/** A line with an arrowhead that draws itself from `from` to `to`. */
export const Arrow: React.FC<{
  from: [number, number];
  to: [number, number];
  at: number;
  label?: string;
  labelOffset?: [number, number];
  dashed?: boolean;
  color?: string;
}> = ({
  from,
  to,
  at,
  label,
  labelOffset = [14, -14],
  dashed,
  color = C.accentLinkDark,
}) => {
  const p = useProgress(at, 18);
  const [x1, y1] = from;
  const [x2, y2] = to;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 16;
  const wing = (delta: number): string =>
    `${x2 - head * Math.cos(angle - delta)},${y2 - head * Math.sin(angle - delta)}`;
  return (
    <>
      <svg
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}
      >
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          pathLength={1}
          stroke={color}
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={dashed ? "10 10" : 1}
          strokeDashoffset={dashed ? 0 : 1 - p}
          opacity={dashed ? p : 1}
        />
        <polygon
          points={`${x2},${y2} ${wing(0.45)} ${wing(-0.45)}`}
          fill={color}
          opacity={p > 0.85 ? 1 : 0}
        />
      </svg>
      {label ? (
        <div
          style={{
            position: "absolute",
            left: (x1 + x2) / 2 + labelOffset[0],
            top: (y1 + y2) / 2 + labelOffset[1],
            fontFamily: MONO,
            fontSize: 21,
            color: C.stageMuted,
            whiteSpace: "nowrap",
            opacity: p,
          }}
        >
          {label}
        </div>
      ) : null}
    </>
  );
};
