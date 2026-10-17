/** The video's timeline: its scenes joined by fades. */
import React from "react";
import { TransitionSeries } from "@remotion/transitions";
import { sceneFade } from "@retivo/video-kit";
import { sceneTiming, type SceneKey } from "./clips";
import { TitleScene } from "./scenes/TitleScene";
import { LocalFirstScene } from "./scenes/LocalFirstScene";
import { ComponentsScene } from "./scenes/ComponentsScene";
import { EnvironmentsScene } from "./scenes/EnvironmentsScene";
import { LoginScene } from "./scenes/LoginScene";
import { SyncScene } from "./scenes/SyncScene";
import { RepairScene } from "./scenes/RepairScene";
import { SnapshotsScene } from "./scenes/SnapshotsScene";
import { ServerSeesScene } from "./scenes/ServerSeesScene";
import { OutroScene } from "./scenes/OutroScene";

/** The scenes in order. Lengths come from the narration clips (see clips.ts). */
export const SCENES: {
  key: SceneKey;
  name: string;
  component: React.FC;
}[] = [
  { key: "title", name: "Title", component: TitleScene },
  { key: "local", name: "Local-first", component: LocalFirstScene },
  { key: "parts", name: "Components", component: ComponentsScene },
  { key: "env", name: "Local vs AWS", component: EnvironmentsScene },
  { key: "login", name: "Sign in and unlock", component: LoginScene },
  { key: "sync", name: "Sync", component: SyncScene },
  { key: "repair", name: "Conflicts and repair", component: RepairScene },
  { key: "snap", name: "Snapshots", component: SnapshotsScene },
  { key: "see", name: "What the server sees", component: ServerSeesScene },
  { key: "outro", name: "Outro", component: OutroScene },
];

/** Length in frames of each scene, in order. */
export const SCENE_LENGTHS = SCENES.map((s) => sceneTiming(s.key).length);

/** The full video. */
export const ArchitectureOverviewVideo: React.FC = () => (
  <TransitionSeries>
    {SCENES.map(({ key, name, component: Scene }, index) => (
      <React.Fragment key={key}>
        {index > 0 ? sceneFade() : null}
        <TransitionSeries.Sequence
          name={name}
          durationInFrames={sceneTiming(key).length}
        >
          <Scene />
        </TransitionSeries.Sequence>
      </React.Fragment>
    ))}
  </TransitionSeries>
);
