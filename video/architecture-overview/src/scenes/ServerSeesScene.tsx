/** Step 8: what the server can and cannot read, and the on-device caveat. */
import React from "react";
import { C, MONO } from "@retivo/video-kit";
import { sceneTiming } from "../clips";
import { Box, Chip, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const SEE_TIMING = sceneTiming("see");

/** What the server can see scene. */
export const ServerSeesScene: React.FC = () => {
  const T = SEE_TIMING;
  const sees = clipAt(T, "see-2");
  const blind = clipAt(T, "see-3");
  const caveat = clipAt(T, "see-4");
  return (
    <StepFrame
      scene="see"
      timing={T}
      step={8}
      headline="What the server sees"
      sub="Metadata, never contents."
    >
      <Box
        x={0}
        y={0}
        w={430}
        h={330}
        title="Server can see"
        sub="Account details, and per change: record id, type, version, time, size"
        tone="accent"
        at={sees}
      />
      <Box
        x={470}
        y={0}
        w={430}
        h={330}
        title="Server cannot read"
        sub="The contents of a plan"
        tone="cipher"
        at={blind}
      />
      <div
        style={{
          position: "absolute",
          left: 500,
          top: 215,
          fontFamily: MONO,
          fontSize: 24,
          color: C.stageMuted,
          opacity: 0.8,
        }}
      >
        a9f3 c07e 51bd 88e2…
      </div>
      <Chip x={0} y={390} text="Why? The key never leaves the browser." tone="default" at={blind + 40} />
      <Box
        x={0}
        y={500}
        w={900}
        h={200}
        title="Caveat: the device"
        sub="IndexedDB and the cached key are not encrypted at rest. Lock your screen, encrypt your disk."
        tone="warn"
        at={caveat}
      />
    </StepFrame>
  );
};
