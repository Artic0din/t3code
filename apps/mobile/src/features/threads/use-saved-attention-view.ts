import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  readAttentionView,
  type AttentionViewId,
} from "@t3tools/client-runtime/state/thread-attention";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useSavedAttentionView() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const attentionView = loaded ? readAttentionView(preferencesResult.value.attentionView) : "all";
  const setAttentionView = useCallback(
    (view: AttentionViewId) => {
      if (!loaded) return;
      savePreferences({ attentionView: view });
    },
    [loaded, savePreferences],
  );
  return { attentionView, setAttentionView } as const;
}
