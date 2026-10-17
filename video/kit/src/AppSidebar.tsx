/**
 * A copy of the app's desktop sidebar (apps/web/src/layout/Sidebar.tsx), for
 * mock app screens: brand row, sync badge, Active Scenario picker, Dashboard,
 * then the Planning, Your Data, Settings and Help & Info groups (Planning open,
 * beta items hidden, as by default) and the account footer. Sizes are the app's
 * Tailwind values in CSS px. Static, so it carries no frame logic.
 */
import React from "react";
import { C, MONO } from "./theme";

const Icon: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flex: "none", opacity: 0.85 }}
  >
    {children}
  </svg>
);

const DashboardIcon = () => (
  <Icon>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Icon>
);

const ProjectionIcon = () => (
  <Icon>
    <polyline points="3 17 9 11 13 15 21 5" />
    <polyline points="15 5 21 5 21 11" />
  </Icon>
);

const ScenariosIcon = () => (
  <Icon>
    <path d="M12 3v18" />
    <path d="M5 7h7" />
    <path d="M5 14h7" />
    <path d="M19 11h-7" />
    <path d="M19 18h-7" />
  </Icon>
);

const TargetIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </Icon>
);

const ReportIcon = () => (
  <Icon>
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </Icon>
);

const Chevron: React.FC<{
  size: number;
  rotate: number;
  color: string;
}> = ({ size, rotate, color }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flex: "none", rotate: `${rotate}deg` }}
  >
    <polyline points="6 3 11 8 6 13" />
  </svg>
);

const NavRow: React.FC<{
  label: string;
  icon: React.ReactNode;
  active?: boolean;
}> = ({ label, icon, active = false }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      height: 36,
      boxSizing: "border-box",
      padding: "0 10px",
      borderRadius: 6,
      fontSize: 14,
      lineHeight: "20px",
      whiteSpace: "nowrap",
      fontWeight: active ? 600 : 400,
      color: active ? C.accentLink : C.ink,
      backgroundColor: active ? C.accentSubtle : "transparent",
    }}
  >
    {icon}
    <span>{label}</span>
  </div>
);

const GroupHeader: React.FC<{ label: string; open: boolean }> = ({
  label,
  open,
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 6,
      height: 28,
      boxSizing: "border-box",
      padding: "0 10px",
      fontSize: 12,
      lineHeight: "16px",
      fontWeight: 500,
      color: C.muted,
    }}
  >
    <Chevron size={10} rotate={open ? 90 : 0} color={C.muted} />
    <span>{label}</span>
  </div>
);

/** Width of the app's desktop sidebar column (Tailwind w-64). */
export const SIDEBAR_WIDTH = 256;

/**
 * The sidebar, signed in as `email` and viewing `activeScenario`. The defaults
 * are what a first run on a local copy shows: the documented dev account and the
 * base scenario, which the picker labels "Base (Base)".
 */
export const AppSidebar: React.FC<{
  email?: string;
  activeScenario?: string;
}> = ({ email = "dev@local.test", activeScenario = "Base (Base)" }) => (
  <div
    style={{
      width: SIDEBAR_WIDTH,
      height: "100%",
      boxSizing: "border-box",
      padding: 12,
      display: "flex",
      flexDirection: "column",
      flex: "none",
      backgroundColor: C.surfaceRaised,
      borderRight: `1px solid ${C.line}`,
      color: C.ink,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px 14px",
        fontSize: 16,
        lineHeight: "24px",
        fontWeight: 700,
        letterSpacing: "-0.025em",
      }}
    >
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: C.brand,
          flex: "none",
        }}
      />
      <span>RETIVO</span>
    </div>

    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
      <div style={{ padding: "0 10px 8px" }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            boxSizing: "border-box",
            padding: "2px 10px",
            borderRadius: 999,
            border: `1px solid oklch(0.52 0.16 145 / 0.4)`,
            backgroundColor: C.surfaceSunken,
            color: C.positive,
            fontSize: 12,
            lineHeight: "16px",
            fontWeight: 500,
          }}
        >
          <svg
            width="1.8em"
            height="1.8em"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.3A4 4 0 0117 18H7z" />
            <polyline points="9.5 13.5 11 15 14.5 11.5" />
          </svg>
          <span>Synced just now</span>
        </div>
      </div>

      <div>
        <div
          style={{
            marginBottom: 4,
            fontFamily: MONO,
            fontSize: 11,
            lineHeight: "16px",
            fontWeight: 600,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.muted,
          }}
        >
          Active Scenario
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            height: 38,
            boxSizing: "border-box",
            padding: "0 12px",
            borderRadius: 6,
            border: `1px solid ${C.inputLine}`,
            backgroundColor: C.surface,
            fontSize: 14,
          }}
        >
          <span>{activeScenario}</span>
          <Chevron size={16} rotate={90} color={C.muted} />
        </div>
      </div>

      <div>
        <div style={{ margin: "2px 0 8px" }}>
          <NavRow label="Dashboard" icon={<DashboardIcon />} active />
        </div>

        <div style={{ marginBottom: 2 }}>
          <GroupHeader label="Planning" open />
          <div
            style={{
              marginTop: 2,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            <NavRow label="Projections" icon={<ProjectionIcon />} />
            <NavRow label="Scenarios" icon={<ScenariosIcon />} />
            <NavRow label="Social Security claim-age" icon={<TargetIcon />} />
            <NavRow label="Roth conversion comparison" icon={<TargetIcon />} />
            <NavRow label="Report" icon={<ReportIcon />} />
          </div>
        </div>
        <div style={{ marginBottom: 2 }}>
          <GroupHeader label="Your Data" open={false} />
        </div>
        <div style={{ marginBottom: 2 }}>
          <GroupHeader label="Settings" open={false} />
        </div>
        <div style={{ marginBottom: 2 }}>
          <GroupHeader label="Help & Info" open={false} />
        </div>
      </div>
    </div>

    <div
      style={{
        marginTop: 8,
        borderTop: `1px solid ${C.line}`,
        padding: "14px 10px 2px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 14, lineHeight: "20px", fontWeight: 600 }}>
        {email}
      </div>
      <div
        style={{
          boxSizing: "border-box",
          height: 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          border: `1px solid ${C.lineStrong}`,
          fontSize: 14,
          fontWeight: 500,
          color: C.accentLink,
        }}
      >
        Sign out
      </div>
    </div>
    <div
      style={{
        marginTop: 8,
        borderTop: `1px solid ${C.line}`,
        padding: "12px 10px 2px",
        fontSize: 12,
        lineHeight: "16px",
        fontWeight: 500,
        color: C.accentLink,
        textDecoration: "underline",
        textUnderlineOffset: 2,
      }}
    >
      RETIVO is open source
    </div>
  </div>
);
