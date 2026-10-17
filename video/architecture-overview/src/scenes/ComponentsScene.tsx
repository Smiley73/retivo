/** Step 2: the four packages of the monorepo. */
import React from "react";
import { sceneTiming } from "../clips";
import { Arrow, Box, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const PARTS_TIMING = sceneTiming("parts");

/** Components scene. */
export const ComponentsScene: React.FC = () => {
  const T = PARTS_TIMING;
  return (
    <StepFrame
      scene="parts"
      timing={T}
      step={2}
      headline="Components"
      sub="Four packages in one pnpm monorepo."
    >
      <Box
        x={0}
        y={40}
        w={410}
        h={210}
        title="Web app"
        sub="React: storage, sync client, encryption, engine"
        tag="apps/web"
        tone="accent"
        at={clipAt(T, "parts-2")}
      />
      <Box
        x={490}
        y={40}
        w={410}
        h={210}
        title="API"
        sub="NestJS, plus background Lambdas"
        tag="apps/api"
        tone="accent"
        at={clipAt(T, "parts-3")}
      />
      <Box
        x={245}
        y={330}
        w={410}
        h={160}
        title="Contracts"
        sub="Shared Zod schemas"
        tag="packages/contracts"
        at={clipAt(T, "parts-4")}
      />
      <Arrow from={[400, 330]} to={[205, 250]} at={clipAt(T, "parts-4") + 20} />
      <Arrow from={[500, 330]} to={[695, 250]} at={clipAt(T, "parts-4") + 20} />
      <Box
        x={245}
        y={570}
        w={410}
        h={160}
        title="Infrastructure"
        sub="Pulumi: builds the Amazon resources"
        tag="infrastructure"
        tone="cipher"
        at={clipAt(T, "parts-4") + 60}
      />
    </StepFrame>
  );
};
