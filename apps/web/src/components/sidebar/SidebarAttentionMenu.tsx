import {
  ATTENTION_VIEWS,
  attentionViewCountText,
  attentionViewLabel,
  readAttentionView,
  type AttentionViewCounts,
  type AttentionViewId,
} from "@t3tools/client-runtime/state/thread-attention";
import { ListFilterIcon } from "lucide-react";

import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

export function SidebarAttentionMenu(props: {
  readonly view: AttentionViewId;
  readonly counts: AttentionViewCounts;
  readonly unavailableEnvironmentCount: number;
  readonly onChange: (view: AttentionViewId) => void;
}) {
  const label = props.view === "all" ? "Attention" : attentionViewLabel(props.view);
  return (
    <Menu>
      <MenuTriggerButton label={label} pressed={props.view !== "all"} />
      <MenuPopup align="end" className="w-56">
        <MenuRadioGroup
          value={props.view}
          onValueChange={(value) => props.onChange(readAttentionView(value))}
        >
          {ATTENTION_VIEWS.map((entry) => {
            const count = attentionViewCountText({
              view: entry.id,
              matchedCount: props.counts[entry.id],
              unavailableEnvironmentCount: props.unavailableEnvironmentCount,
            });
            return (
              <MenuRadioItem key={entry.id} value={entry.id}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span>{entry.label}</span>
                  {count === undefined ? null : (
                    <span className="text-muted-foreground text-xs">{count}</span>
                  )}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function MenuTriggerButton(props: { readonly label: string; readonly pressed: boolean }) {
  return (
    <MenuTrigger
      render={
        <SidebarHeaderIconButton label={props.label} pressed={props.pressed}>
          <ListFilterIcon />
        </SidebarHeaderIconButton>
      }
    />
  );
}
