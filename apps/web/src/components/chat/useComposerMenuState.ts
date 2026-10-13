import { useState } from "react";

/** Clear portaled menus when their measured, still-mounted triggers hide. */
export function useComposerMenuState(hidden = false, targetKey = "") {
  const [open, setOpen] = useState(false);
  const [currentTargetKey, setCurrentTargetKey] = useState(targetKey);
  // Base UI does not notify us when we close it by changing its open prop.
  // Reset the stored state too, so revealing the trigger cannot reopen it.
  if (targetKey !== currentTargetKey) {
    setCurrentTargetKey(targetKey);
    setOpen(false);
  } else if (hidden && open) {
    setOpen(false);
  }
  return [open && !hidden && targetKey === currentTargetKey, setOpen] as const;
}
