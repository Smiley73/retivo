/** Step 6: a rejected change, auto-repair, the sync badge, quarantine and the freshness counter. */
import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C } from "@retivo/video-kit";
import { sceneTiming } from "../clips";
import { Arrow, Box, Chip, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const REPAIR_TIMING = sceneTiming("repair");

/** Conflicts and repair scene. */
export const RepairScene: React.FC = () => {
  const T = REPAIR_TIMING;
  const frame = useCurrentFrame();
  const conflict = clipAt(T, "repair-2");
  const repair = clipAt(T, "repair-3");
  const safety = clipAt(T, "repair-4");
  const badgeAt = repair + 150;
  const badge = interpolate(frame, [badgeAt, badgeAt + 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <StepFrame
      scene="repair"
      timing={T}
      headline="Conflicts & repair"
      sub="Fix silently where possible. Ask when not."
    >
      <Box x={0} y={0} w={380} h={110} title="Push" sub="saw version 4" at={conflict} />
      <Arrow from={[380, 55]} to={[520, 55]} at={conflict + 10} />
      <Box
        x={520}
        y={0}
        w={380}
        h={110}
        title="Rejected"
        sub="CONFLICT · server has 5"
        tone="warn"
        at={conflict + 24}
      />

      <Arrow from={[710, 110]} to={[450, 200]} at={repair} dashed />
      <Box
        x={0}
        y={200}
        w={900}
        h={110}
        title="Auto-repair"
        sub="picks an action per rejection"
        at={repair}
      />
      <Chip x={0} y={330} text="drop: same result already there" tone="accent" at={repair + 50} />
      <Chip x={440} y={330} text="re-apply on the server's version" tone="accent" at={repair + 90} />

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 430,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "12px 24px",
          borderRadius: 999,
          backgroundColor: C.warningSubtle,
          color: C.warning,
          fontSize: 26,
          fontWeight: 600,
          opacity: badge,
        }}
      >
        <div
          style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: C.warning }}
        />
        Sync badge: needs your decision
      </div>

      <Box
        x={0}
        y={540}
        w={430}
        h={200}
        title="Quarantine"
        sub="A row that won't decrypt is set aside on this device. The rest loads."
        tone="cipher"
        at={safety}
      />
      <Box
        x={470}
        y={540}
        w={430}
        h={200}
        title="Freshness counter"
        sub="Refuses a server that serves older data than seen before."
        tone="cipher"
        at={safety + 70}
      />
    </StepFrame>
  );
};
