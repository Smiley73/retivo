/** Step 5: an edit travels from IndexedDB through the queue and encryption to the server, and out to other devices. */
import React from "react";
import { sceneTiming } from "../clips";
import { Arrow, Box, clipAt } from "../diagram";
import { StepFrame } from "../StepFrame";

/** Timing of this scene's clips. */
export const SYNC_TIMING = sceneTiming("sync");

/** Sync scene. */
export const SyncScene: React.FC = () => {
  const T = SYNC_TIMING;
  const edit = clipAt(T, "sync-2");
  const push = clipAt(T, "sync-3");
  const check = clipAt(T, "sync-4");
  const pull = clipAt(T, "sync-5");
  return (
    <StepFrame
      scene="sync"
      timing={T}
      step={5}
      headline="Sync"
      sub="Queue, encrypt, push, pull."
    >
      <Box x={0} y={0} w={340} h={110} title="IndexedDB" sub="updated first" tone="accent" at={edit} />
      <Box x={0} y={170} w={340} h={110} title="Mutation queue" sub="one create/update/delete" at={edit + 40} />
      <Box x={0} y={340} w={340} h={110} title="Encrypt" sub="in the browser" at={push} />
      <Arrow from={[170, 110]} to={[170, 170]} at={edit + 40} />
      <Arrow from={[170, 280]} to={[170, 340]} at={push} />

      <Arrow
        from={[340, 395]}
        to={[560, 395]}
        at={push + 30}
        label="POST /sync/push"
        labelOffset={[-95, -40]}
      />
      <Box
        x={560}
        y={340}
        w={340}
        h={130}
        title="Version check"
        sub="refuses plaintext"
        tag="applied | rejected"
        tone="cipher"
        at={check}
      />
      <Box
        x={560}
        y={530}
        w={340}
        h={110}
        title="Mutation log"
        sub="ciphertext in DynamoDB"
        tone="cipher"
        at={check + 40}
      />
      <Arrow from={[730, 470]} to={[730, 530]} at={check + 40} />

      <Box
        x={0}
        y={640}
        w={340}
        h={110}
        title="Other device"
        sub="new device: bootstrap"
        at={pull}
      />
      <Arrow
        from={[560, 620]}
        to={[340, 680]}
        at={pull + 20}
        label="GET /sync/pull?since="
        labelOffset={[-100, 30]}
      />
    </StepFrame>
  );
};
