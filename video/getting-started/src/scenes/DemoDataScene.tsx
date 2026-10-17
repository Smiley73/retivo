/** Step 4: load the demo data from the first-run dialog, after which the dashboard fills in. */
import React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  AppSidebar,
  C,
  Cursor,
  FIRST_CLIP_FRAME,
  LeftColumn,
  Narration,
  RightArea,
  Stage,
  StepDots,
  UiButton,
} from "@retivo/video-kit";

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

// What the demo data fills in, appearing as the narration names each one. No
// counts on purpose: the demo data's size changes, the list of what's in it
// rarely does.
const LOADED = [
  { label: "Accounts", at: 157 },
  { label: "Balances", at: 180 },
  { label: "Income", at: 202 },
  { label: "Expenses", at: 219 },
  { label: "Scenarios", at: 244 },
];

const LoadedPills: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, height: 26 }}>
      {LOADED.map((item) => (
        <div
          key={item.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            height: 26,
            boxSizing: "border-box",
            padding: "0 10px 0 8px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            backgroundColor: C.accentSubtle,
            color: C.accentLink,
            opacity: interpolate(frame, [item.at, item.at + 10], [0, 1], clamp),
            translate: interpolate(
              frame,
              [item.at, item.at + 10],
              ["0px 6px", "0px 0px"],
              clamp,
            ),
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width={11}
            height={11}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path
              d="M3 8.5l3 3 7-7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {item.label}
        </div>
      ))}
    </div>
  );
};

const Bars: React.FC<{ at: number }> = ({ at }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 160 }}
    >
      {Array.from({ length: 10 }, (_, i) => {
        const total = 0.36 + i * 0.065;
        const pre = 0.5 - i * 0.008;
        const roth = 0.15 + i * 0.008;
        const cash = 0.12 - i * 0.004;
        const taxable = 1 - pre - roth - cash;
        const grow = interpolate(frame, [at + i * 3, at + i * 3 + 18], [0, 1], {
          ...clamp,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        });
        const h = 160 * total * grow;
        return (
          <div
            key={i}
            style={{
              width: 28,
              height: h,
              display: "flex",
              flexDirection: "column-reverse",
              borderRadius: 3,
              overflow: "hidden",
            }}
          >
            <div style={{ height: h * pre, backgroundColor: C.pretax }} />
            <div style={{ height: h * roth, backgroundColor: C.roth }} />
            <div style={{ height: h * taxable, backgroundColor: C.taxable }} />
            <div style={{ height: h * cash, backgroundColor: C.cash }} />
          </div>
        );
      })}
    </div>
  );
};

/** Step 4 of 4: load the demo data. */
export const DemoDataScene: React.FC = () => {
  const frame = useCurrentFrame();
  const loaded = frame >= 138;

  return (
    <Stage>
      <LeftColumn>
        <Interactive.Div
          name="Step"
          style={{
            opacity: interpolate(frame, [0, 14], [0, 1], clamp),
          }}
        >
          <StepDots current={4} total={4} />
        </Interactive.Div>

        <Interactive.Div
          name="Headline"
          style={{
            fontSize: 108,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.04,
            opacity: interpolate(frame, [4, 24], [0, 1], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
            translate: interpolate(frame, [4, 24], ["0px 30px", "0px 0px"], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Load the
          <br />
          demo data
        </Interactive.Div>

        <Interactive.Div
          name="Point 1"
          style={{
            fontSize: 46,
            lineHeight: 1.25,
            color: C.stageInk,
            fontWeight: 600,
            opacity: interpolate(frame, [30, 46], [0, 1], clamp),
            translate: interpolate(frame, [30, 46], ["0px 20px", "0px 0px"], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          A ready-made sample household: accounts, balances, income, expenses
          and scenarios.
        </Interactive.Div>

        <Interactive.Div
          name="Point 2"
          style={{
            fontSize: 46,
            lineHeight: 1.25,
            color: C.stageMuted,
            opacity: interpolate(frame, [226, 242], [0, 1], clamp),
            translate: interpolate(frame, [226, 242], ["0px 20px", "0px 0px"], {
              ...clamp,
              easing: Easing.bezier(0.16, 1, 0.3, 1),
            }),
          }}
        >
          Not now? Skip it, and load it later from Settings → Workspace.
        </Interactive.Div>
      </LeftColumn>

      <RightArea>
        <Interactive.Div
          name="App"
          style={{ position: "relative", width: 780, height: 657, scale: 1.2 }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              overflow: "hidden",
              borderRadius: 14,
              backgroundColor: C.surface,
              boxShadow: "0 28px 80px oklch(0.05 0 0 / 0.55)",
              color: C.ink,
              opacity: interpolate(frame, [0, 22], [0, 1], clamp),
              translate: interpolate(frame, [0, 22], ["0px 36px", "0px 0px"], {
                ...clamp,
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            <AppSidebar />

            <div
              style={{ flex: 1, padding: "24px 16px", position: "relative" }}
            >
              <div
                style={{
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    letterSpacing: "-0.02em",
                  }}
                >
                  Dashboard
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {[
                    { n: "John Doe", at: 150 },
                    { n: "Jane Doe", at: 156 },
                  ].map((m) => (
                    <div
                      key={m.n}
                      style={{
                        padding: "2px 10px",
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 600,
                        backgroundColor: C.accentSubtle,
                        color: C.accentLink,
                        opacity: interpolate(
                          frame,
                          [m.at, m.at + 10],
                          [0, 1],
                          clamp,
                        ),
                      }}
                    >
                      {m.n}
                    </div>
                  ))}
                </div>
              </div>

              <div
                style={{
                  position: "absolute",
                  top: 68,
                  left: 16,
                  right: 16,
                  boxSizing: "border-box",
                  padding: 18,
                  borderRadius: 10,
                  border: `1px solid ${C.line}`,
                  backgroundColor: C.surfaceRaised,
                  opacity: interpolate(
                    frame,
                    [30, 44, 138, 148],
                    [0, 1, 1, 0],
                    clamp,
                  ),
                  display: loaded && frame > 148 ? "none" : "block",
                }}
              >
                <div
                  style={{ fontSize: 14, lineHeight: "20px", color: C.muted }}
                >
                  No accounts yet.{" "}
                  <span
                    style={{ color: C.accentLink, textDecoration: "underline" }}
                  >
                    Set up your household
                  </span>{" "}
                  or{" "}
                  <span
                    style={{ color: C.accentLink, textDecoration: "underline" }}
                  >
                    add your first account
                  </span>
                  .
                </div>
              </div>

              {frame >= 140 ? (
                <div style={{ marginTop: 16 }}>
                  <LoadedPills />
                  <div
                    style={{
                      marginTop: 12,
                      height: 250,
                      boxSizing: "border-box",
                      padding: "12px 16px",
                      borderRadius: 10,
                      border: `1px solid ${C.line}`,
                      backgroundColor: C.surfaceRaised,
                      opacity: interpolate(frame, [152, 164], [0, 1], clamp),
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        marginBottom: 14,
                      }}
                    >
                      Portfolio allocation{" "}
                      <span style={{ fontWeight: 400, color: C.muted }}>
                        - by account type
                      </span>
                    </div>
                    <Bars at={170} />
                    <div
                      style={{
                        display: "flex",
                        gap: 14,
                        marginTop: 12,
                        fontSize: 11,
                        color: C.muted,
                      }}
                    >
                      {[
                        { l: "Pre-tax", c: C.pretax },
                        { l: "Roth", c: C.roth },
                        { l: "Taxable", c: C.taxable },
                        { l: "Cash", c: C.cash },
                      ].map((k) => (
                        <div
                          key={k.l}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                          }}
                        >
                          <div
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: 2,
                              backgroundColor: k.c,
                            }}
                          />
                          {k.l}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div
              style={{
                position: "absolute",
                inset: 0,
                backgroundColor: C.overlay,
                opacity: interpolate(
                  frame,
                  [12, 30, 138, 150],
                  [0, 1, 1, 0],
                  clamp,
                ),
                display: frame > 152 ? "none" : "block",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 298,
                top: 213,
                width: 440,
                boxSizing: "border-box",
                padding: 24,
                borderRadius: 14,
                backgroundColor: C.surfaceRaised,
                boxShadow: "0 20px 60px oklch(0.1 0 0 / 0.35)",
                opacity: interpolate(
                  frame,
                  [14, 34, 138, 150],
                  [0, 1, 1, 0],
                  clamp,
                ),
                scale: interpolate(frame, [14, 34], [0.95, 1], {
                  ...clamp,
                  easing: Easing.bezier(0.16, 1, 0.3, 1),
                }),
                display: frame > 152 ? "none" : "block",
              }}
            >
              <div
                style={{
                  height: 28,
                  fontSize: 18,
                  lineHeight: "28px",
                  fontWeight: 600,
                }}
              >
                Try the demo dataset?
              </div>
              <div
                style={{
                  marginTop: 12,
                  height: 40,
                  fontSize: 14,
                  lineHeight: "20px",
                  color: C.muted,
                }}
              >
                This looks like a fresh workspace. Load a sample household to
                see how the app works.
              </div>
              <div
                style={{
                  marginTop: 12,
                  height: 32,
                  fontSize: 12,
                  lineHeight: "16px",
                  color: C.muted,
                }}
              >
                You can always start from scratch instead by skipping this and
                adding your own primary member on the Household page.
              </div>
              <div
                style={{ marginTop: 20, height: 38, display: "flex", gap: 12 }}
              >
                <UiButton
                  label={frame >= 120 ? "Loading…" : "Load demo data"}
                  disabled={frame >= 120}
                  pressAt={120}
                />
                <UiButton label="Skip" variant="secondary" />
              </div>
            </div>
          </div>

          <Cursor
            points={[
              { frame: 64, x: 740, y: 600 },
              { frame: 102, x: 390, y: 400 },
              { frame: 128, x: 390, y: 400 },
              { frame: 154, x: 560, y: 520 },
            ]}
            clicks={[120]}
            hideAt={160}
          />
        </Interactive.Div>
      </RightArea>
      <Narration clip="demo-1" from={FIRST_CLIP_FRAME} />
      <Narration clip="demo-2" from={94} />
    </Stage>
  );
};
