/** Step 7: the compactor, snapshots in S3, the janitor and restore. */
import React from "react";
import { sceneTiming } from "../clips";
import { Arrow, Box, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const SNAP_TIMING = sceneTiming("snap");

/** Snapshots scene. */
export const SnapshotsScene: React.FC = () => {
  const T = SNAP_TIMING;
  const write = clipAt(T, "snap-2");
  const expire = clipAt(T, "snap-3");
  const keep = clipAt(T, "snap-4");
  return (
    <StepFrame
      scene="snap"
      timing={T}
      step={7}
      headline="Snapshots"
      sub="Compact the log, keep restore points."
    >
      <Box x={0} y={0} w={270} h={130} title="Mutation log" sub="DynamoDB" tone="cipher" at={write} />
      <Box x={315} y={0} w={270} h={130} title="Compactor" sub="Lambda · hourly" tone="accent" at={write + 20} />
      <Box x={630} y={0} w={270} h={130} title="Snapshots" sub="S3 · encrypted" tone="cipher" at={write + 40} />
      <Arrow from={[270, 65]} to={[315, 65]} at={write + 20} />
      <Arrow from={[585, 65]} to={[630, 65]} at={write + 40} />
      <Arrow
        from={[450, 130]}
        to={[135, 250]}
        at={write + 90}
        label="then trims covered rows"
        labelOffset={[10, 10]}
      />

      <Box
        x={0}
        y={250}
        w={430}
        h={140}
        title="Log trimmed"
        sub="only what the snapshot provably holds"
        at={write + 90}
      />

      <Box
        x={0}
        y={440}
        w={430}
        h={140}
        title="Old cursor?"
        sub="CURSOR_EXPIRED → bootstrap again"
        tone="warn"
        at={expire}
      />
      <Arrow from={[215, 390]} to={[215, 440]} at={expire + 10} />
      <Box
        x={630}
        y={440}
        w={270}
        h={140}
        title="Janitor"
        sub="daily cleanup"
        tone="accent"
        at={keep}
      />
      <Arrow from={[765, 440]} to={[765, 130]} at={keep + 20} />

      <Box
        x={0}
        y={630}
        w={900}
        h={120}
        title="Restore"
        sub="Rebuild versions first, flip the pointer last."
        at={keep + 50}
      />
    </StepFrame>
  );
};
