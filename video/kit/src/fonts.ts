/** Loads the app's brand fonts for a video. */
import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

/**
 * Loads the app's own variable fonts (copied from apps/web/public/fonts), so
 * every video sets type in the same faces as the product. Call once at the top
 * of a project's Root.tsx.
 *
 * The files live once, in kit/fonts. Each video's `public/fonts` must be a symlink
 * to them, so Studio and render both serve them.
 */
export const loadBrandFonts = (): void => {
  loadFont({
    family: "Hanken Grotesk",
    url: staticFile("fonts/hanken-grotesk-var.woff2"),
    weight: "100 900",
  });
  loadFont({
    family: "JetBrains Mono",
    url: staticFile("fonts/jetbrains-mono-var.woff2"),
    weight: "100 800",
  });
};
