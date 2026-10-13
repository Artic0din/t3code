import { useCallback } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  registerActiveComposerDraftTarget,
  type ActiveComposerDraftTarget,
} from "./active-composer-draft-target";

export function useThreadComposerPresetTarget(
  target: ActiveComposerDraftTarget | null,
  questionnaireActive: boolean,
  creationFailed = false,
): void {
  useFocusEffect(
    useCallback(() => {
      if (target === null || questionnaireActive || creationFailed) return undefined;
      return registerActiveComposerDraftTarget(target);
    }, [target, questionnaireActive, creationFailed]),
  );
}
