import type { AttentionViewCounts } from "@t3tools/client-runtime/state/thread-attention";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenu } from "./home-list-filter-menu";

const counts: AttentionViewCounts = {
  all: 4,
  "needs-approval": 1,
  failed: 0,
  "waiting-for-me": 2,
};

describe("buildHomeListFilterMenu", () => {
  it("adds a project scope submenu that selects and clears the same scope as the chips", () => {
    const onProjectChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [
        { key: "environment-1:project-1", label: "Codething" },
        { key: "environment-1:project-2", label: "Website" },
      ],
      selectedEnvironmentId: null,
      selectedProjectKey: "environment-1:project-1",
      attentionView: "all",
      attentionCounts: counts,
      unavailableEnvironmentCount: 0,
      onEnvironmentChange: vi.fn(),
      onProjectChange,
      onAttentionChange: vi.fn(),
    });

    const projectMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Project",
    );
    expect(menu.items.some((item) => item.title === "Settings")).toBe(false);
    expect(projectMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All projects", state: "off" },
        { title: "Codething", state: "on" },
        { title: "Website", state: "off" },
      ],
    });
    if (projectMenu?.type !== "submenu") throw new Error("Expected project submenu");

    projectMenu.items[0]?.onPress();
    projectMenu.items[2]?.onPress();
    expect(onProjectChange).toHaveBeenNthCalledWith(1, null);
    expect(onProjectChange).toHaveBeenNthCalledWith(2, "environment-1:project-2");
  });

  it("selects a saved attention view and can return to All", () => {
    const onAttentionChange = vi.fn();
    const menu = buildHomeListFilterMenu({
      environments: [],
      projects: [],
      selectedEnvironmentId: null,
      selectedProjectKey: null,
      attentionView: "needs-approval",
      attentionCounts: counts,
      unavailableEnvironmentCount: 1,
      onEnvironmentChange: vi.fn(),
      onProjectChange: vi.fn(),
      onAttentionChange,
    });

    const attentionMenu = menu.items.find(
      (item) => item.type === "submenu" && item.title === "Attention",
    );
    expect(attentionMenu).toMatchObject({
      type: "submenu",
      items: [
        { title: "All", state: "off", subtitle: undefined },
        { title: "Needs approval", state: "on", subtitle: "Count unavailable" },
        { title: "Failed", state: "off", subtitle: "Count unavailable" },
        { title: "Waiting for me", state: "off", subtitle: "Count unavailable" },
      ],
    });
    if (attentionMenu?.type !== "submenu") throw new Error("Expected attention submenu");

    attentionMenu.items[0]?.onPress();
    attentionMenu.items[1]?.onPress();
    expect(onAttentionChange).toHaveBeenNthCalledWith(1, "all");
    expect(onAttentionChange).toHaveBeenNthCalledWith(2, "needs-approval");
  });
});
