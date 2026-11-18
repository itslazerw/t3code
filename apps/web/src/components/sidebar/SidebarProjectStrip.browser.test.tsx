import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import {
  PROJECT_STRIP_DRAG_TYPE,
  SidebarProjectStrip,
  type SidebarProjectStripProject,
} from "./SidebarProjectStrip";

const environmentId = EnvironmentId.make("strip-environment");
const project = (projectKey: string, pinned: boolean) =>
  ({
    projectKey,
    displayName: `Project ${projectKey}`,
    pinned,
    environmentId,
    workspaceRoot: `/repo/${projectKey}`,
  }) as unknown as SidebarProjectStripProject;

function drag(target: Element, type: string, dataTransfer: DataTransfer, clientX: number) {
  const rect = target.getBoundingClientRect();
  target.dispatchEvent(
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

it("opens the project menu, reorders, pins a project dragged in and unpins one dragged out", async () => {
  const onContextMenu = vi.fn();
  const onPlace = vi.fn();
  const onUnpin = vi.fn();
  await using screen = await render(
    <SidebarProvider>
      <div style={{ width: 240 }}>
        <SidebarProjectStrip
          projects={[project("a", true), project("b", true), project("c", false)]}
          selectedKeys={[]}
          onShowAll={vi.fn()}
          onShowOnly={vi.fn()}
          onToggle={vi.fn()}
          onContextMenu={onContextMenu}
          onPlace={onPlace}
          onUnpin={onUnpin}
        />
      </div>
    </SidebarProvider>,
  );
  const iconA = screen.getByRole("button", { name: "Project a" }).element();
  const iconB = screen.getByRole("button", { name: "Project b" }).element();
  const row = iconA.closest("[data-slot=sidebar-project-strip]")!;

  iconA.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(onContextMenu).toHaveBeenCalledWith("a", { x: 0, y: 0 }, "mouse");
  screen
    .getByRole("button", { name: "All projects" })
    .element()
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(onContextMenu).toHaveBeenCalledTimes(1);

  // Drag a past b: a line shows after b, and the drop places a at the end.
  const move = new DataTransfer();
  drag(iconA, "dragstart", move, iconA.getBoundingClientRect().left + 2);
  expect(move.getData(PROJECT_STRIP_DRAG_TYPE)).toBe("a");
  drag(iconB, "dragover", move, iconB.getBoundingClientRect().right - 1);
  await vi.waitFor(() => expect(row.querySelector("[data-strip-drop-line=after]")).not.toBeNull());
  drag(iconB, "drop", move, iconB.getBoundingClientRect().right - 1);
  expect(onPlace).toHaveBeenLastCalledWith("a", 2);

  // A project from the list dropped before a.
  const pin = new DataTransfer();
  pin.setData(PROJECT_STRIP_DRAG_TYPE, "c");
  drag(iconA, "drop", pin, iconA.getBoundingClientRect().left + 1);
  expect(onPlace).toHaveBeenLastCalledWith("c", 0);

  // Let go far below the strip: unpin. Let go on the strip: no unpin.
  drag(iconB, "dragend", new DataTransfer(), iconB.getBoundingClientRect().left + 2);
  expect(onUnpin).not.toHaveBeenCalled();
  iconB.dispatchEvent(
    new DragEvent("dragend", {
      bubbles: true,
      dataTransfer: new DataTransfer(),
      clientX: 10,
      clientY: 500,
    }),
  );
  expect(onUnpin).toHaveBeenCalledWith("b");
});
