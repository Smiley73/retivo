/** Step 3: the same API on a laptop with emulators, and on AWS. */
import React from "react";
import { sceneTiming } from "../clips";
import { Arrow, Box, Chip, Frame, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const ENV_TIMING = sceneTiming("env");

/** Local versus AWS scene. */
export const EnvironmentsScene: React.FC = () => {
  const T = ENV_TIMING;
  const local = clipAt(T, "env-2");
  const aws = clipAt(T, "env-3");
  const same = clipAt(T, "env-4");
  return (
    <StepFrame
      scene="env"
      timing={T}
      headline="Local vs AWS"
      sub="Same API code. Different endpoints."
    >
      <Frame x={0} y={0} w={900} h={290} label="ON YOUR MACHINE" at={local} />
      <Chip
        x={30}
        y={222}
        text="data lost on restart · for development and testing only"
        tone="warn"
        mono
        at={clipAt(T, "env-2b")}
      />
      <Box x={30} y={70} w={190} h={130} title="Browser" at={local} />
      <Box
        x={300}
        y={70}
        w={230}
        h={130}
        title="API"
        sub="Node process"
        tone="accent"
        at={local + 12}
      />
      <Box
        x={610}
        y={70}
        w={260}
        h={130}
        title="Emulators"
        sub="DynamoDB Local, Moto"
        at={local + 24}
      />
      <Arrow from={[220, 135]} to={[300, 135]} at={local + 18} />
      <Arrow from={[530, 135]} to={[610, 135]} at={local + 32} />

      <Chip
        x={0}
        y={306}
        text="same API code"
        tone="accent"
        at={same}
      />

      <Frame x={0} y={400} w={900} h={350} label="ON AWS" at={aws} />
      <Box x={20} y={525} w={150} h={100} title="Browser" at={aws} />
      <Box
        x={200}
        y={525}
        w={210}
        h={100}
        title="CloudFront"
        tone="accent"
        at={aws + 12}
      />
      <Box x={460} y={450} w={410} h={90} title="S3" sub="web app files" at={aws + 24} />
      <Box
        x={460}
        y={620}
        w={190}
        h={115}
        title="API"
        sub="Gateway + Lambda"
        tone="accent"
        at={aws + 36}
      />
      <Box
        x={680}
        y={620}
        w={190}
        h={115}
        title="Data"
        sub="DynamoDB, S3"
        at={aws + 48}
      />
      <Arrow from={[170, 575]} to={[200, 575]} at={aws + 18} />
      <Arrow from={[410, 550]} to={[460, 505]} at={aws + 30} />
      <Arrow from={[410, 600]} to={[460, 665]} at={aws + 42} label="/api/*" labelOffset={[-70, 20]} />
      <Arrow from={[650, 677]} to={[680, 677]} at={aws + 54} />

      <Chip x={250} y={306} text="UI work: mock transport, no server" tone="cipher" mono at={same + 70} />
    </StepFrame>
  );
};
