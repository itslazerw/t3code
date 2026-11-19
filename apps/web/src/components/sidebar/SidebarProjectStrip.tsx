import type { ContextMenuSource } from "@t3tools/contracts";
import { LayoutGridIcon } from "lucide-react";
import {
  useState,
  type ComponentProps,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";

import type { ProjectFaviconProject } from "../ProjectFavicon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

/** Drag data a project carries onto the strip: its projectKey. Folder headers set it too. */
export const PROJECT_STRIP_DRAG_TYPE = "application/x-t3-project-key";

export interface SidebarProjectStripProject extends ProjectFaviconProject {
  readonly projectKey: string;
  readonly displayName: string;
  readonly pinned: boolean;
}

export interface SidebarProjectStripProps {
  /** The project filter's own list: open projects, pinned first, in its order. Only pinned ones show. */
  readonly projects: ReadonlyArray<SidebarProjectStripProject>;
  readonly selectedKeys: ReadonlyArray<string>;
  readonly onShowAll: () => void;
  readonly onShowOnly: (projectKey: string) => void;
  readonly onToggle: (projectKey: string) => void;
  /** T3's project menu, the one a project folder header opens. */
  readonly onContextMenu: (
    projectKey: string,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  /** A drop on the strip: moves a pinned project, or pins one dragged in, before that position. */
  readonly onPlace: (projectKey: string, beforeIndex: number) => void;
  /** A pinned icon dragged out of the strip and let go. */
  readonly onUnpin: (projectKey: string) => void;
  /** The last button: T3's full project picker, for every project that is not pinned. */
  readonly more: ReactNode;
}

/** One click on a project icon under the search row does what picking it in the project filter does. */
export function SidebarProjectStrip({
  projects,
  selectedKeys,
  onShowAll,
  onShowOnly,
  onToggle,
  onContextMenu,
  onPlace,
  onUnpin,
  more,
}: SidebarProjectStripProps) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  // Set a tick after dragstart: hiding the dragged element during dragstart cancels the drag.
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const pinned = projects.filter((project) => project.pinned);
  // With no projects there is nothing to pick; with none pinned the row still holds All projects and More.
  if (projects.length === 0) return null;
  const pick = (event: ReactMouseEvent, projectKey: string) => {
    // Shift+click adds or removes a project, like Shift+click in the filter menu.
    if (event.shiftKey) {
      onToggle(projectKey);
      return;
    }
    // Clicking the only shown project again goes back to all projects.
    if (selectedKeys.length === 1 && selectedKeys[0] === projectKey) {
      onShowAll();
      return;
    }
    onShowOnly(projectKey);
  };
  const isProjectDrag = (event: ReactDragEvent) =>
    event.dataTransfer.types.includes(PROJECT_STRIP_DRAG_TYPE);
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isProjectDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropIndex(dropIndexAt(event.currentTarget, event.clientX));
  };
  const from = draggingKey === null ? -1 : pinned.findIndex((p) => p.projectKey === draggingKey);
  // Like the Dock: the icons after the landing spot slide over to open an empty slot there.
  const shiftOf = (index: number) =>
    dropIndex !== null && index >= dropIndex && index !== from ? STRIP_SLOT_PX : 0;
  // A reorder frees the dragged icon's width; anything else needs the strip one icon wider.
  const endSlotOpen = dropIndex !== null && (from < 0 || dropIndex >= pinned.length);
  return (
    <TooltipProvider delay={300} closeDelay={0}>
      <div
        role="group"
        aria-label="Show threads from one project"
        data-slot="sidebar-project-strip"
        // One track holds the row, like a segmented control: the chosen slot is the raised tile.
        className="mx-1 mt-1 flex w-fit max-w-[calc(100%-0.5rem)] gap-0.5 rounded-lg bg-input/40 p-0.75"
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropIndex(null);
        }}
        onDrop={(event) => {
          if (!isProjectDrag(event)) return;
          event.preventDefault();
          const projectKey = event.dataTransfer.getData(PROJECT_STRIP_DRAG_TYPE);
          const beforeIndex = dropIndexAt(event.currentTarget, event.clientX);
          setDropIndex(null);
          if (projectKey) onPlace(projectKey, beforeIndex);
        }}
      >
        {/* One row; more pinned projects than fit scroll sideways, the mouse wheel included. More stays put. */}
        <div
          // The vertical padding keeps the chosen tile's hairline shadow from being clipped.
          className="-my-0.75 flex min-w-0 gap-0.5 overflow-x-auto py-0.75 [scrollbar-width:none]"
          onWheel={scrollSideways}
        >
          <ProjectStripButton
            label="All projects"
            selected={selectedKeys.length === 0}
            onClick={() => onShowAll()}
          >
            <LayoutGridIcon className="size-3.5 shrink-0 fill-current" />
          </ProjectStripButton>
          {pinned.map((project, index) => (
            <span
              key={project.projectKey}
              data-strip-project=""
              data-strip-shift={shiftOf(index)}
              data-strip-collapsed={collapsedKey === project.projectKey ? "" : undefined}
              style={{ transform: `translateX(${shiftOf(index)}px)` }}
              // The dragged icon's own spot closes up instead of leaving a ghost.
              className={cn(
                "flex shrink-0 transition-transform duration-150 ease-out",
                // The negative margin also takes back its gap.
                collapsedKey === project.projectKey && "-mr-0.5 w-0 overflow-hidden opacity-0",
              )}
            >
              <ProjectStripButton
                label={project.displayName}
                selected={selectedKeys.includes(project.projectKey)}
                onClick={(event) => pick(event, project.projectKey)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onContextMenu(
                    project.projectKey,
                    { x: event.clientX, y: event.clientY },
                    contextMenuSourceOf(event),
                  );
                }}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(PROJECT_STRIP_DRAG_TYPE, project.projectKey);
                  event.dataTransfer.effectAllowed = "move";
                  setDraggingKey(project.projectKey);
                  window.setTimeout(() => setCollapsedKey(project.projectKey));
                }}
                onDragEnd={(event) => {
                  setDraggingKey(null);
                  window.setTimeout(() => setCollapsedKey(null));
                  setDropIndex(null);
                  // Let go away from the strip, and nothing took the drop: unpin, like the Dock.
                  const row = event.currentTarget.closest("[data-slot=sidebar-project-strip]");
                  if (
                    event.dataTransfer.dropEffect === "none" &&
                    row !== null &&
                    !isInside(row.getBoundingClientRect(), event.clientX, event.clientY)
                  ) {
                    onUnpin(project.projectKey);
                  }
                }}
              >
                <ProjectFavicon
                  project={project}
                  className="size-4 shrink-0"
                  monogramVariant="bare"
                />
              </ProjectStripButton>
            </span>
          ))}
          {/* The slot past the last icon, and room for the slide when a project comes in from the picker. */}
          <span
            aria-hidden
            data-strip-end-slot={endSlotOpen ? "open" : "closed"}
            // Its negative margin cancels the row gap, so a closed slot takes no room.
            className="-ml-0.5 shrink-0 transition-[width] duration-150 ease-out"
            style={{ width: endSlotOpen ? STRIP_SLOT_PX : 0 }}
          />
        </div>
        {more}
      </div>
    </TooltipProvider>
  );
}

function scrollSideways(event: ReactWheelEvent<HTMLDivElement>) {
  const row = event.currentTarget;
  if (row.scrollWidth <= row.clientWidth || event.deltaX !== 0 || event.deltaY === 0) return;
  row.scrollLeft += event.deltaY;
}

/** One slot plus the gap: how far the others slide to open a slot. */
const STRIP_SLOT_PX = 26;

/** The position among the pinned icons the pointer is over: before the first icon past its middle. */
function dropIndexAt(row: HTMLElement, clientX: number) {
  const icons = [...row.querySelectorAll<HTMLElement>("[data-strip-project]")];
  const index = icons.findIndex((icon) => {
    const rect = icon.getBoundingClientRect();
    // Measured where the icon sits, not where it has slid to, so the slot does not chase the pointer.
    const left = rect.left - Number(icon.dataset.stripShift ?? 0);
    return clientX < left + rect.width / 2;
  });
  return index < 0 ? icons.length : index;
}

function isInside(rect: DOMRect, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** A strip slot: muted letters on the track until chosen, then a crisp raised tile in the project's colour. */
export function ProjectStripButton({
  label,
  selected,
  children,
  ...rest
}: {
  label: string;
  selected: boolean;
  children?: ReactNode;
} & Omit<ComponentProps<"button">, "children">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={selected}
            data-strip-icon={selected ? "chosen" : "quiet"}
            {...rest}
            className={cn(
              "grid size-6 shrink-0 cursor-pointer place-items-center rounded-md border text-muted-foreground outline-hidden transition-[background-color,border-color,color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected
                ? "border-border bg-background font-bold text-foreground shadow-xs/10 dark:bg-input/72"
                : // Unchosen: no tile, letters in the muted text colour, favicons a little paler.
                  "border-transparent font-semibold hover:border-border/50 hover:bg-background/55 dark:hover:bg-input/32 [&_[data-slot=project-monogram]]:text-muted-foreground [&_img]:saturate-75 [&_svg]:text-muted-foreground",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
