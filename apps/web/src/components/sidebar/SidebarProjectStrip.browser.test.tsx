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
          more={null}
        />
      </div>
    </SidebarProvider>,
  );
  const iconA = screen.getByRole("button", { name: "Project a" }).element();
  const iconB = screen.getByRole("button", { name: "Project b" }).element();
  const row = iconA.closest("[data-slot=sidebar-project-strip]")!;
  const slotOf = (icon: Element) => icon.closest("[data-strip-project]")!;

  iconA.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(onContextMenu).toHaveBeenCalledWith("a", { x: 0, y: 0 }, "mouse");
  screen
    .getByRole("button", { name: "All projects" })
    .element()
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(onContextMenu).toHaveBeenCalledTimes(1);

  // Drag a past b: a's spot closes, an empty slot opens after b, no line; the drop places a at the end.
  const move = new DataTransfer();
  drag(iconA, "dragstart", move, iconA.getBoundingClientRect().left + 2);
  expect(move.getData(PROJECT_STRIP_DRAG_TYPE)).toBe("a");
  await vi.waitFor(() => expect(slotOf(iconA).hasAttribute("data-strip-collapsed")).toBe(true));
  drag(iconB, "dragover", move, iconB.getBoundingClientRect().right - 1);
  await vi.waitFor(() => expect(row.querySelector("[data-strip-end-slot=open]")).not.toBeNull());
  expect(slotOf(iconB).getAttribute("data-strip-shift")).toBe("0");
  drag(iconB, "drop", move, iconB.getBoundingClientRect().right - 1);
  expect(onPlace).toHaveBeenLastCalledWith("a", 2);
  drag(iconA, "dragend", move, iconB.getBoundingClientRect().right - 1);
  await vi.waitFor(() => expect(slotOf(iconA).hasAttribute("data-strip-collapsed")).toBe(false));

  // A project from the list held before a: a and b slide over to open its slot, then the drop.
  const pin = new DataTransfer();
  pin.setData(PROJECT_STRIP_DRAG_TYPE, "c");
  drag(iconA, "dragover", pin, iconA.getBoundingClientRect().left + 1);
  await vi.waitFor(() => expect(slotOf(iconA).getAttribute("data-strip-shift")).toBe("26"));
  expect(slotOf(iconB).getAttribute("data-strip-shift")).toBe("26");
  expect(row.querySelector("[data-strip-drop-line]")).toBeNull();
  drag(iconA, "drop", pin, iconA.getBoundingClientRect().left - 25);
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

it("keeps All projects and More with nothing pinned, and greys only the unchosen icons", async () => {
  const strip = (selectedKeys: string[], projects: SidebarProjectStripProject[]) => (
    <SidebarProvider>
      <SidebarProjectStrip
        projects={projects}
        selectedKeys={selectedKeys}
        onShowAll={vi.fn()}
        onShowOnly={vi.fn()}
        onToggle={vi.fn()}
        onContextMenu={vi.fn()}
        onPlace={vi.fn()}
        onUnpin={vi.fn()}
        more={<button type="button">More</button>}
      />
    </SidebarProvider>
  );
  {
    await using screen = await render(strip([], [project("c", false)]));
    await expect.element(screen.getByRole("button", { name: "All projects" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "More" })).toBeVisible();
    expect(screen.container.querySelectorAll("[data-strip-project]")).toHaveLength(0);
  }
  await using screen = await render(strip(["a"], [project("a", true), project("b", true)]));
  const iconOf = (name: string) => screen.getByRole("button", { name }).element();
  expect(iconOf("Project a")?.getAttribute("data-strip-icon")).toBe("chosen");
  expect(iconOf("Project b")?.getAttribute("data-strip-icon")).toBe("quiet");
  expect(iconOf("All projects")?.getAttribute("data-strip-icon")).toBe("quiet");
  // No check badge over the chosen icon any more.
  expect(screen.container.querySelector("svg.lucide-check")).toBeNull();
});
