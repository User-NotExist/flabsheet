/**
 * The link preview image messaging apps show for every Flabsheet URL, served
 * at /opengraph-image and rendered once at build time. Satori draws it, so
 * styles are inline flexbox and colors are hex (the theme's oklch tokens from
 * globals.css, converted). The font is Geist Regular, which next/og bundles.
 */

import { ImageResponse } from "next/og";

import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

export const alt = `${SITE_NAME}: ${SITE_DESCRIPTION}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Dark theme tokens: chat apps show the card on light and dark backgrounds,
// and the dark one stands out on both
const BACKGROUND = "#0a0a0a"; // --background
const FOREGROUND = "#fafafa"; // --foreground
const MUTED = "#a1a1a1"; // --muted-foreground
const PRIMARY = "#57bf5a"; // --primary

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          background: BACKGROUND,
          borderTop: `12px solid ${PRIMARY}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 28,
            fontSize: 120,
            letterSpacing: "-0.04em",
            color: FOREGROUND,
          }}
        >
          <div style={{ width: 28, height: 28, borderRadius: 999, background: PRIMARY }} />
          {SITE_NAME}
        </div>
        <div
          style={{
            marginTop: 32,
            maxWidth: 900,
            fontSize: 44,
            lineHeight: 1.35,
            color: MUTED,
          }}
        >
          {SITE_DESCRIPTION}
        </div>
      </div>
    ),
    size,
  );
}
