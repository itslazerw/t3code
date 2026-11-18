import { CheckIcon, FolderIcon } from "lucide-react";
import type {
  MouseEvent as ReactMouseEvent,
  ReactNode,
  WheelEvent as ReactWheelEvent,
} from "react";

import type { ProjectFaviconProject } from "../ProjectFavicon";
import { ProjectFavicon } from "../ProjectFavicon";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

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
}

/** One click on a project icon under the search row does what picking it in the project filter does. */
export function SidebarProjectStrip({
  projects,
  selectedKeys,
  onShowAll,
  onShowOnly,
  onToggle,
}: SidebarProjectStripProps) {
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
  return (
    <TooltipProvider delay={300} closeDelay={0}>
      <div
        role="group"
        aria-label="Show threads from one project"
        data-slot="sidebar-project-strip"
        // One row; more pinned projects than fit scroll sideways, the mouse wheel included.
        className="flex overflow-x-auto px-1 pt-1 [scrollbar-width:none]"
        onWheel={scrollSideways}
      >
        <StripButton
          label="All projects"
          selected={selectedKeys.length === 0}
          onClick={() => onShowAll()}
        >
          <FolderIcon className="size-4 shrink-0" />
        </StripButton>
        {pinned.map((project) => (
          <StripButton
            key={project.projectKey}
            label={project.displayName}
            selected={selectedKeys.includes(project.projectKey)}
            onClick={(event) => pick(event, project.projectKey)}
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

function StripButton(props: {
  label: string;
  selected: boolean;
  onClick: (event: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <SidebarHeaderIconButton
      label={props.label}
      aria-pressed={props.selected}
      className="size-6"
      onClick={props.onClick}
    >
      {/* The same check badge the project filter menu puts on a chosen project. */}
      <span className="relative flex shrink-0">
        {props.children}
        {props.selected ? (
          <span className="pointer-events-none absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-primary ring-2 ring-sidebar">
            <CheckIcon className="size-2 text-primary-foreground" strokeWidth={4} aria-hidden />
          </span>
        ) : null}
      </span>
    </SidebarHeaderIconButton>
  );
}
