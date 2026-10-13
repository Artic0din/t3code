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
  readonly onDelete: (presetId: string) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [includeAgentSettings, setIncludeAgentSettings] = useState(true);
  const [replaceInstructions, setReplaceInstructions] = useState(true);

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
            const saved = props.onSave({
              ...(editingId ? { id: editingId } : {}),
              name,
              instructions: props.draftText,
              includeAgentSettings,
              replaceInstructions: editingId === null || replaceInstructions,
            });
            if (saved) {
              setName("");
              setEditingId(null);
              setReplaceInstructions(true);
            }
          }}
        >
          <input
            aria-label="Preset name"
            value={name}
            placeholder="Preset name"
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            onChange={(event) => setName(event.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={includeAgentSettings}
              onChange={(event) => setIncludeAgentSettings(event.target.checked)}
            />
            Include provider, model, and mode
          </label>
          {editingId ? (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={replaceInstructions}
                onChange={(event) => setReplaceInstructions(event.target.checked)}
              />
              Replace instructions with the current draft
            </label>
          ) : null}
          <button
            type="submit"
            className="h-8 rounded-md bg-primary px-2 text-sm text-primary-foreground"
          >
            {editingId ? "Update preset" : "Save preset"}
          </button>
          {props.error ? <p className="text-sm text-destructive">{props.error}</p> : null}
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
                      setEditingId(preset.id);
                      setName(preset.name);
                      setReplaceInstructions(false);
                    }}
                  >
                    Edit
                  </PresetAction>
                  <PresetAction
                    label={`Delete ${preset.name}`}
                    onClick={() => props.onDelete(preset.id)}
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

function PresetAction(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      className="text-sm text-muted-foreground"
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
