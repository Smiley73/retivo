/** Step 1: the browser holds the plan and does the maths; the server only stores ciphertext. */
import React from "react";
import { sceneTiming } from "../clips";
import { Arrow, Box, Frame, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const LOCAL_TIMING = sceneTiming("local");

/** Local-first scene. */
export const LocalFirstScene: React.FC = () => {
  const T = LOCAL_TIMING;
  return (
    <StepFrame
      scene="local"
      timing={T}
      headline="Local-first"
      sub="The browser holds the plan and does the math."
    >
      <Frame x={0} y={0} w={900} h={480} label="BROWSER" at={clipAt(T, "local-1")} />
      <Box
        x={40}
        y={70}
        w={340}
        h={130}
        title="React app"
        sub="UI, projections, taxes"
        at={clipAt(T, "local-3")}
      />
      <Box
        x={500}
        y={70}
        w={360}
        h={130}
        title="IndexedDB"
        sub="Working copy of the plan"
        tone="accent"
        at={clipAt(T, "local-2")}
      />
      <Box
        x={40}
        y={310}
        w={340}
        h={130}
        title="Web Workers"
        sub="Monte Carlo runs"
        at={clipAt(T, "local-3") + 40}
      />
      <Arrow from={[380, 135]} to={[500, 135]} at={clipAt(T, "local-2") + 20} />
      <Arrow from={[210, 200]} to={[210, 310]} at={clipAt(T, "local-3") + 50} />
      <Arrow
        from={[450, 480]}
        to={[450, 620]}
        dashed
        at={clipAt(T, "local-4")}
        label="encrypted changes only"
      />
      <Box
        x={200}
        y={620}
        w={500}
        h={120}
        title="Server"
        sub="Stores ciphertext. No plan logic."
        tone="cipher"
        dashed
        at={clipAt(T, "local-4")}
      />
    </StepFrame>
  );
};
