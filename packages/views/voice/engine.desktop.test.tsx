import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@multica/core/api", () => ({ api: { createVoiceSession: vi.fn() } }));

const localModels = { engineAvailable: true, models: [] };

// The session connects one runtime per page, so each case loads fresh modules.
async function load() {
  vi.resetModules();
  const { configStore } = await import("@multica/core/config");
  const engine = await import("./engine");
  return { configStore, ...engine };
}

beforeEach(() => {
  (window as unknown as { desktopAPI: unknown }).desktopAPI = {
    voice: {
      listModels: vi.fn(async () => localModels),
      onModelsChanged: vi.fn(() => () => {}),
      transcribe: vi.fn(),
      prepare: vi.fn(),
    },
  };
});

afterEach(() => {
  delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
});

describe("useVoiceModels on Desktop", () => {
  it("waits for the config, then streams to the server when it offers speech", async () => {
    const { configStore, useVoiceModels, SERVER_VOICE_MODEL } = await load();
    const { result } = renderHook(() => useVoiceModels());
    expect(result.current).toBeNull();

    act(() => configStore.getState().setVoiceTranscriptionEnabled(true));
    await waitFor(() => expect(result.current).toEqual({ engineAvailable: true, models: [SERVER_VOICE_MODEL] }));
    const voice = (window as unknown as { desktopAPI: { voice: { listModels: ReturnType<typeof vi.fn> } } }).desktopAPI.voice;
    expect(voice.listModels).not.toHaveBeenCalled();
  });

  it("uses the on-device engine when the server has no speech provider", async () => {
    const { configStore, useVoiceModels } = await load();
    const { result } = renderHook(() => useVoiceModels());
    act(() => configStore.getState().setVoiceTranscriptionEnabled(false));
    await waitFor(() => expect(result.current).toEqual(localModels));
  });

  it("offers voice input on Desktop either way, and reports which engine is in use", async () => {
    const { configStore, useVoiceInputAvailable, useServerVoiceEngine } = await load();
    const { result } = renderHook(() => [useVoiceInputAvailable(), useServerVoiceEngine()]);
    expect(result.current).toEqual([true, null]);
    act(() => configStore.getState().setVoiceTranscriptionEnabled(true));
    expect(result.current).toEqual([true, true]);
  });
});
