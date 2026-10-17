/** The frames scenes are laid out in. */
import React from "react";

/**
 * The two-column frame most scenes use: a text column on the left (step, headline,
 * points) and the mock app on the right. Keeping the geometry here keeps every
 * video's screens lined up the same way.
 */
export const LeftColumn: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      position: "absolute",
      left: 120,
      top: 0,
      bottom: 0,
      width: 700,
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      gap: 28,
    }}
  >
    {children}
  </div>
);

/** The area right of `LeftColumn`, centring the mock app. */
export const RightArea: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      position: "absolute",
      left: 900,
      right: 60,
      top: 0,
      bottom: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {children}
  </div>
);
