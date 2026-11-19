import type { ProjectIconColor } from "@t3tools/contracts";
import { projectIconColorClassName } from "../projectIconColors";
import { cn } from "~/lib/utils";

const monogramSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectMonogram({
  text,
  color,
  className,
  variant = "tile",
}: {
  readonly text: string;
  readonly color: ProjectIconColor;
  readonly className?: string | undefined;
  /** "bare": just the letters in the UI font, no tile, for places that draw their own. */
  readonly variant?: "tile" | "bare" | undefined;
}) {
  if (variant === "bare") {
    return (
      <span
        aria-hidden="true"
        data-slot="project-monogram"
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center whitespace-nowrap font-sans text-2xs leading-none select-none",
          projectIconColorClassName(color),
          className,
        )}
      >
        {text}
      </span>
    );
  }
  // Wrap the tile to avoid menu/button SVG margin trimming.
  return (
    <span
      aria-hidden="true"
      data-slot="project-monogram"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-mono select-none",
          projectIconColorClassName(color),
        )}
        style={{
          backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          className="font-mono"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(monogramSegmenter.segment(text)).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
