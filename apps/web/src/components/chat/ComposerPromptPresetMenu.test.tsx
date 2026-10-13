// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ComposerPromptPresetMenu } from "./ComposerPromptPresetMenu";
import { useComposerMenuState } from "./useComposerMenuState";

let root: Root;
let container: HTMLDivElement;
let portal: HTMLDivElement;
const dispatchTurn = vi.fn();
const save = vi.fn<(input: { readonly id?: string; readonly instructions: string }) => boolean>(
  () => true,
);
const presets = [{ id: "existing", name: "Existing", instructions: "Saved instructions" }];

function Composer({ targetKey = "env-a/thread-a", hidden = false }) {
  const [open, setOpen] = useComposerMenuState(hidden, targetKey);
  return (
    <form onSubmit={() => dispatchTurn("Nonempty ordinary draft")}>
      <button type="button" onClick={() => setOpen(true)}>
        Presets
      </button>
      {open &&
        createPortal(
          <ComposerPromptPresetMenu
            presets={presets}
            draftText="Nonempty ordinary draft"
            error={null}
            onApply={() => true}
            onSave={save}
            onDelete={() => {}}
            onClose={() => setOpen(false)}
          />,
          portal,
        )}
    </form>
  );
}

async function click(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(() => button!.click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  portal = document.createElement("div");
  document.body.append(container, portal);
  root = createRoot(container);
  save.mockClear();
  dispatchTurn.mockClear();
  await act(() => root.render(<Composer />));
  await click('button[type="button"]');
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  portal.remove();
  vi.unstubAllGlobals();
});

it.each(["Save", "Update"])(
  "%s submits the preset through its portal without dispatching a turn",
  async (action) => {
    if (action === "Update") await click('[aria-label="Edit Existing"]');
    await click('button[type="submit"]');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ instructions: "Nonempty ordinary draft" });
    expect(dispatchTurn).not.toHaveBeenCalled();
  },
);

it("keyboard form submission saves a preset without dispatching a turn", async () => {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')!;
  input.focus();
  await act(() => input.form!.requestSubmit());
  expect(save).toHaveBeenCalledTimes(1);
  expect(dispatchTurn).not.toHaveBeenCalled();
});

it.each(["env-a/thread-b", "env-b/thread-a", "env-a/queued-edit:run"])(
  "discards the old editor when the reused composer navigates to %s",
  async (targetKey) => {
    await click('[aria-label="Edit Existing"]');
    await act(() => root.render(<Composer targetKey={targetKey} />));
    expect(document.querySelector('[aria-label="Preset name"]')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    await click('button[type="button"]');
    expect(document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe("");
    await click('button[type="submit"]');
    expect(save.mock.calls[0]?.[0]).not.toHaveProperty("id");
  },
);

it("discards an open preset editor during pending input and keeps it closed afterward", async () => {
  await click('[aria-label="Edit Existing"]');
  await act(() => root.render(<Composer hidden />));
  expect(document.querySelector('[aria-label="Preset name"]')).toBeNull();
  await act(() => root.render(<Composer />));
  expect(document.querySelector('[aria-label="Preset name"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
