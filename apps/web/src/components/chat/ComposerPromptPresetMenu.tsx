import { BookmarkIcon } from "lucide-react";
import { useState } from "react";

import type { PromptPreset } from "@t3tools/contracts";
import type { PromptPresetApplyDisposition } from "@t3tools/client-runtime/promptPresets";

import { ComposerBanner } from "./ComposerBanner";

export function ComposerPromptPresetButton(props: {
  readonly count: number;
  readonly menuOpen: boolean;
  readonly onToggleMenu: () => void;
}) {
  return (
    <ComposerBanner.Root density="comfortable" width="content" data-composer-shoulder-tab>
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-label="Prompt presets"
        aria-expanded={props.menuOpen}
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onToggleMenu}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>Presets</ComposerBanner.Content>
        {props.count > 0 ? (
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{props.count}</ComposerBanner.Count>
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}

export function ComposerPromptPresetMenu(props: {
  readonly presets: readonly PromptPreset[];
  readonly draftText: string;
  readonly error: string | null;
  readonly onApply: (presetId: string, disposition: PromptPresetApplyDisposition) => boolean;
  readonly onSave: (input: {
    readonly id?: string;
    readonly name: string;
    readonly instructions: string;
    readonly includeAgentSettings: boolean;
    readonly replaceInstructions: boolean;
  }) => boolean;
  readonly onDelete: (presetId: string) => boolean | Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [editor, setEditor] = useState(EMPTY_PRESET_EDITOR);
  const { name, editingId, includeAgentSettings, replaceInstructions } = editor;
  const [deletingIds, setDeletingIds] = useState<readonly string[]>([]);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  if (editingId !== null && !props.presets.some((preset) => preset.id === editingId)) {
    setEditor(EMPTY_PRESET_EDITOR);
  }

  return (
    <ComposerBanner.Root data-prompt-preset-menu="true">
      <ComposerBanner.Row
        render={<button type="button" />}
        aria-label="Close prompt presets"
        aria-expanded="true"
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onClose}
      >
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>Prompt presets</ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Body>
        <form
          className="flex flex-col gap-2 px-3 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (editingId !== null && deletingIds.includes(editingId)) return;
            const saved = props.onSave({
              ...(editingId ? { id: editingId } : {}),
              name,
              instructions: props.draftText,
              includeAgentSettings,
              replaceInstructions: editingId === null || replaceInstructions,
            });
            if (saved) {
              setEditor((current) => ({
                ...current,
                name: "",
                editingId: null,
                replaceInstructions: true,
              }));
            }
          }}
        >
          <input
            aria-label="Preset name"
            value={name}
            placeholder="Preset name"
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            onChange={(event) => {
              const name = event.target.value;
              setEditor((current) => ({ ...current, name }));
            }}
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={includeAgentSettings}
              onChange={(event) => {
                const includeAgentSettings = event.target.checked;
                setEditor((current) => ({ ...current, includeAgentSettings }));
              }}
            />
            Include provider, model, and mode
          </label>
          {editingId ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={replaceInstructions}
                onChange={(event) => {
                  const replaceInstructions = event.target.checked;
                  setEditor((current) => ({ ...current, replaceInstructions }));
                }}
              />
              Replace instructions with the current draft
            </label>
          ) : null}
          <button
            type="submit"
            disabled={editingId !== null && deletingIds.includes(editingId)}
            className="h-8 rounded-md bg-primary px-2 text-sm text-primary-foreground"
          >
            {editingId ? "Update preset" : "Save preset"}
          </button>
          {props.error || deletionError ? (
            <p className="text-sm text-destructive">{props.error ?? deletionError}</p>
          ) : null}
        </form>
      </ComposerBanner.Body>
      <ComposerBanner.Scroll>
        <ComposerBanner.Children render={<ul role="list" />} aria-label="Prompt presets">
          {props.presets.length === 0 ? (
            <ComposerBanner.Row render={<li />}>
              <ComposerBanner.Content className="text-muted-foreground">
                No prompt presets yet.
              </ComposerBanner.Content>
            </ComposerBanner.Row>
          ) : (
            props.presets.map((preset) => (
              <ComposerBanner.Row render={<li />} key={preset.id}>
                <ComposerBanner.Content>
                  <span className="truncate">{preset.name}</span>
                </ComposerBanner.Content>
                <ComposerBanner.Actions>
                  <PresetAction
                    label={`Apply ${preset.name}`}
                    onClick={() => {
                      if (props.onApply(preset.id, "insert")) props.onClose();
                    }}
                  >
                    Apply
                  </PresetAction>
                  <PresetAction
                    label={`Replace draft with ${preset.name}`}
                    onClick={() => {
                      if (props.onApply(preset.id, "replace")) props.onClose();
                    }}
                  >
                    Replace
                  </PresetAction>
                  <PresetAction
                    label={`Edit ${preset.name}`}
                    onClick={() => {
                      setEditor((current) => ({
                        ...current,
                        editingId: preset.id,
                        name: preset.name,
                        replaceInstructions: false,
                      }));
                    }}
                  >
                    Edit
                  </PresetAction>
                  <PresetAction
                    label={`Delete ${preset.name}`}
                    disabled={deletingIds.includes(preset.id)}
                    onClick={() => {
                      setDeletingIds((current) => [...current, preset.id]);
                      setDeletionError(null);
                      void Promise.resolve()
                        .then(() => props.onDelete(preset.id))
                        .then((deleted) => {
                          if (deleted)
                            setEditor((current) =>
                              current.editingId === preset.id ? EMPTY_PRESET_EDITOR : current,
                            );
                        })
                        .catch((error: unknown) => {
                          setDeletionError(
                            error instanceof Error
                              ? error.message
                              : "Could not delete the preset. Try again.",
                          );
                        })
                        .finally(() =>
                          setDeletingIds((current) => current.filter((id) => id !== preset.id)),
                        );
                    }}
                  >
                    Delete
                  </PresetAction>
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            ))
          )}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
    </ComposerBanner.Root>
  );
}

const EMPTY_PRESET_EDITOR = {
  name: "",
  editingId: null as string | null,
  includeAgentSettings: true,
  replaceInstructions: true,
};

function PresetAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-label={props.label}
      className="text-sm text-muted-foreground"
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
