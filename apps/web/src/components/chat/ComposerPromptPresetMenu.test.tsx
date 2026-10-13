// @vitest-environment jsdom
import { act, useState } from "react";
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
const presets = [
  { id: "existing", name: "Existing", instructions: "Saved instructions" },
  { id: "other", name: "Other", instructions: "Other instructions" },
];
const remove = vi.fn<(id: string) => Promise<boolean>>(async () => true);

function Composer({
  targetKey = "env-a/thread-a",
  hidden = false,
  presetsOverride,
  delaySubscription = false,
}: {
  targetKey?: string;
  hidden?: boolean;
  presetsOverride?: typeof presets;
  delaySubscription?: boolean;
}) {
  const [entries, setEntries] = useState(presets);
  const [open, setOpen] = useComposerMenuState(hidden, targetKey);
  return (
    <form onSubmit={() => dispatchTurn("Nonempty ordinary draft")}>
      <button type="button" onClick={() => setOpen(true)}>
        Presets
      </button>
      {open &&
        createPortal(
          <ComposerPromptPresetMenu
            presets={presetsOverride ?? entries}
            draftText="Nonempty ordinary draft"
            error={null}
            onApply={() => true}
            onSave={save}
            onDelete={async (id) => {
              const removed = await remove(id);
              if (removed && !delaySubscription)
                setEntries((current) => current.filter((entry) => entry.id !== id));
              return removed;
            }}
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
  await act(async () => {
    button!.click();
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  portal = document.createElement("div");
  document.body.append(container, portal);
  root = createRoot(container);
  save.mockClear();
  dispatchTurn.mockClear();
  remove.mockReset();
  remove.mockResolvedValue(true);
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

it("exits editing after confirmed deletion so submit cannot recreate the deleted ID", async () => {
  await click('[aria-label="Edit Existing"]');
  await click('[aria-label="Delete Existing"]');
  expect(document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe("");
  expect(document.querySelector('button[type="submit"]')?.textContent).toBe("Save preset");
  await click('button[type="submit"]');
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("id");
});

it("retains the edited preset when asynchronous deletion fails", async () => {
  remove.mockResolvedValue(false);
  await click('[aria-label="Edit Existing"]');
  await click('[aria-label="Delete Existing"]');
  expect(document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe(
    "Existing",
  );
  await click('button[type="submit"]');
  expect(save.mock.calls[0]?.[0]).toHaveProperty("id", "existing");
});

it("exits editing on successful deletion before the config subscription catches up", async () => {
  await act(() => root.render(<Composer delaySubscription />));
  await click('[aria-label="Edit Existing"]');
  await click('[aria-label="Delete Existing"]');
  expect(document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe("");
  await click('button[type="submit"]');
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("id");
});

it("blocks Update while deletion is pending and retains the editor after failure", async () => {
  let finish: (removed: boolean) => void = () => {};
  remove.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await click('[aria-label="Edit Existing"]');
  await click('[aria-label="Delete Existing"]');
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await act(async () =>
    document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')!.form!.requestSubmit(),
  );
  expect(save).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  await click('button[type="submit"]');
  expect(save.mock.calls[0]?.[0]).toHaveProperty("id", "existing");
});

it("keeps editing an unrelated preset when another is deleted", async () => {
  await click('[aria-label="Edit Existing"]');
  await click('[aria-label="Delete Other"]');
  expect(document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe(
    "Existing",
  );
  await click('button[type="submit"]');
  expect(save.mock.calls[0]?.[0]).toHaveProperty("id", "existing");
});

it("leaves edit mode when the preset is removed by another client", async () => {
  await click('[aria-label="Edit Existing"]');
  await act(() => root.render(<Composer presetsOverride={[presets[1]!]} />));
  expect(document.querySelector<HTMLInputElement>('[aria-label="Preset name"]')?.value).toBe("");
  await click('button[type="submit"]');
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty("id");
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
