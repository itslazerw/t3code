import type { ContextMenuSource } from "@t3tools/contracts";
import { CheckIcon, FolderIcon } from "lucide-react";
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
import { TooltipProvider } from "../ui/tooltip";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

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
}: SidebarProjectStripProps) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const pinned = projects.filter((project) => project.pinned);
  // Pinned projects only; with none pinned there is no row.
  if (pinned.length === 0) return null;
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
  // No line where the drop would leave the order as it is.
  const shownDropIndex =
    dropIndex === null || (from >= 0 && (dropIndex === from || dropIndex === from + 1))
      ? null
      : dropIndex;
  return (
    <TooltipProvider delay={300} closeDelay={0}>
      <div
        role="group"
        aria-label="Show threads from one project"
        data-slot="sidebar-project-strip"
        // One row; more pinned projects than fit scroll sideways, the mouse wheel included.
        className="flex overflow-x-auto px-1 pt-1 [scrollbar-width:none]"
        onWheel={scrollSideways}
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
        <StripButton
          label="All projects"
          selected={selectedKeys.length === 0}
          onClick={() => onShowAll()}
        >
          <FolderIcon className="size-4 shrink-0" />
        </StripButton>
        {pinned.map((project, index) => (
          <StripButton
            key={project.projectKey}
            label={project.displayName}
            selected={selectedKeys.includes(project.projectKey)}
            onClick={(event) => pick(event, project.projectKey)}
            data-strip-project=""
            dropLine={
              shownDropIndex === index
                ? "before"
                : shownDropIndex === pinned.length && index === pinned.length - 1
                  ? "after"
                  : null
            }
            dimmed={draggingKey === project.projectKey}
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
            }}
            onDragEnd={(event) => {
              setDraggingKey(null);
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
            <ProjectFavicon project={project} className="size-4 shrink-0" />
          </StripButton>
        ))}
      </div>
    </TooltipProvider>
  );
}

function scrollSideways(event: ReactWheelEvent<HTMLDivElement>) {
  const row = event.currentTarget;
  if (row.scrollWidth <= row.clientWidth || event.deltaX !== 0 || event.deltaY === 0) return;
  row.scrollLeft += event.deltaY;
}

/** The position among the pinned icons the pointer is over: before the first icon past its middle. */
function dropIndexAt(row: HTMLElement, clientX: number) {
  const icons = [...row.querySelectorAll<HTMLElement>("[data-strip-project]")];
  const index = icons.findIndex((icon) => {
    const rect = icon.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2;
  });
  return index < 0 ? icons.length : index;
}

function isInside(rect: DOMRect, x: number, y: number) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function StripButton({
  label,
  selected,
  dropLine = null,
  dimmed = false,
  children,
  ...rest
}: {
  label: string;
  selected: boolean;
  dropLine?: "before" | "after" | null;
  /** The icon being dragged. */
  dimmed?: boolean;
  onClick: (event: ReactMouseEvent) => void;
  children: ReactNode;
} & Omit<ComponentProps<typeof SidebarHeaderIconButton>, "label" | "children">) {
  return (
    <SidebarHeaderIconButton label={label} aria-pressed={selected} className="size-6" {...rest}>
      {/* Where a dragged project lands. */}
      {dropLine ? (
        <span
          aria-hidden
          data-strip-drop-line={dropLine}
          className={cn(
            "pointer-events-none absolute inset-y-0.5 w-0.5 rounded-full bg-primary",
            dropLine === "before" ? "left-0" : "right-0",
          )}
        />
      ) : null}
      {/* The same check badge the project filter menu puts on a chosen project. */}
      <span className={cn("relative flex shrink-0", dimmed && "opacity-40")}>
        {children}
        {selected ? (
          <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-sidebar">
            <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
          </span>
        ) : null}
      </span>
    </SidebarHeaderIconButton>
  );
}
