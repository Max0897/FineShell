import { describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useAiSidebarController,
  type AiSidebarWindowAdapter,
} from "./useAiSidebarController";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createWindowAdapter(options?: {
  fullscreen?: boolean;
  maximized?: boolean;
  setSizeError?: Error;
  width?: number;
}) {
  let width = options?.width ?? 1_200;
  let height = 800;
  let fullscreen = options?.fullscreen ?? false;
  let maximized = options?.maximized ?? false;
  let resizeListener: (() => void) | undefined;
  const sizeRequests: Array<{ height: number; width: number }> = [];
  const adapter: AiSidebarWindowAdapter = {
    getInnerSize: async () => ({ height, width }),
    isFullscreen: async () => fullscreen,
    isMaximized: async () => maximized,
    onResized: async (listener) => {
      resizeListener = listener;
      return () => {
        resizeListener = undefined;
      };
    },
    setInnerSize: async (nextWidth, nextHeight) => {
      if (options?.setSizeError) throw options.setSizeError;
      sizeRequests.push({ height: nextHeight, width: nextWidth });
      width = nextWidth;
      height = nextHeight;
    },
  };
  return {
    adapter,
    currentWidth: () => width,
    emitResize: () => resizeListener?.(),
    setFullscreen: (value: boolean) => {
      fullscreen = value;
    },
    setMaximized: (value: boolean) => {
      maximized = value;
    },
    sizeRequests,
  };
}

function renderController(
  adapter: AiSidebarWindowAdapter,
  options?: {
    onResizeFailure?: (error: unknown, operation: string) => void;
    sidebarWidth?: number;
  },
) {
  return renderHook(() =>
    useAiSidebarController({
      getWorkspaceWidth: () => 1_200,
      onResizeFailure: options?.onResizeFailure,
      sidebarWidth: options?.sidebarWidth ?? 440,
      windowAdapter: adapter,
    }),
  );
}

describe("useAiSidebarController", () => {
  test("expands by the current sidebar width and restores the window", async () => {
    const window = createWindowAdapter();
    const view = renderController(window.adapter, { sidebarWidth: 520 });

    act(() => {
      void view.result.current.open();
    });
    expect(view.result.current.phase).toBe("opening");
    expect(view.result.current.active).toBe(true);
    expect(view.result.current.mounted).toBe(true);
    expect(view.result.current.visible).toBe(false);
    await waitFor(() => expect(view.result.current.phase).toBe("open"));
    expect(window.currentWidth()).toBe(1_720);
    expect(view.result.current.visible).toBe(true);

    act(() => {
      void view.result.current.close();
    });
    expect(view.result.current.phase).toBe("closing");
    expect(view.result.current.mounted).toBe(true);
    expect(view.result.current.visible).toBe(false);
    await waitFor(() => expect(view.result.current.phase).toBe("closed"));
    expect(view.result.current.mounted).toBe(false);
    expect(window.currentWidth()).toBe(1_200);
  });

  test("serializes a close request made while expansion is running", async () => {
    const gate = deferred();
    const window = createWindowAdapter();
    const originalSetSize = window.adapter.setInnerSize;
    let firstResize = true;
    window.adapter.setInnerSize = async (width, height) => {
      if (firstResize) {
        firstResize = false;
        await gate.promise;
      }
      await originalSetSize(width, height);
    };
    const view = renderController(window.adapter);

    act(() => {
      void view.result.current.open();
    });
    await waitFor(() => expect(firstResize).toBe(false));
    act(() => {
      void view.result.current.close();
    });
    expect(view.result.current.phase).toBe("closing");
    gate.resolve();

    await waitFor(() => expect(view.result.current.phase).toBe("closed"));
    expect(window.currentWidth()).toBe(1_200);
    expect(window.sizeRequests.map((request) => request.width)).toEqual([
      1_640, 1_200,
    ]);
  });

  test("reopens cleanly while a collapse is still running", async () => {
    const gate = deferred();
    const window = createWindowAdapter();
    const originalSetSize = window.adapter.setInnerSize;
    let resizeCount = 0;
    window.adapter.setInnerSize = async (width, height) => {
      resizeCount += 1;
      if (resizeCount === 2) await gate.promise;
      await originalSetSize(width, height);
    };
    const view = renderController(window.adapter);

    act(() => {
      void view.result.current.open();
    });
    await waitFor(() => expect(view.result.current.phase).toBe("open"));
    act(() => {
      void view.result.current.close();
    });
    await waitFor(() => expect(resizeCount).toBe(2));
    act(() => {
      void view.result.current.open();
    });
    expect(view.result.current.phase).toBe("opening");
    gate.resolve();

    await waitFor(() => expect(view.result.current.phase).toBe("open"));
    expect(window.currentWidth()).toBe(1_640);
    expect(window.sizeRequests.map((request) => request.width)).toEqual([
      1_640, 1_200, 1_640,
    ]);
  });

  test("opens inside maximized windows without changing native size", async () => {
    const window = createWindowAdapter({ maximized: true });
    const view = renderController(window.adapter);

    act(() => {
      void view.result.current.open();
    });
    await waitFor(() => expect(view.result.current.phase).toBe("open"));

    expect(window.sizeRequests).toHaveLength(0);
    expect(view.result.current.visible).toBe(true);
  });

  test("falls back to the current window when expansion fails", async () => {
    const onResizeFailure = mock((_error: unknown, _operation: string) => {});
    const window = createWindowAdapter({
      setSizeError: new Error("resize rejected"),
    });
    const view = renderController(window.adapter, { onResizeFailure });

    act(() => {
      void view.result.current.open();
    });
    await waitFor(() => expect(view.result.current.phase).toBe("open"));

    expect(view.result.current.visible).toBe(true);
    expect(onResizeFailure).toHaveBeenCalledTimes(1);
    expect(onResizeFailure.mock.calls[0]?.[1]).toBe("expand");
  });

  test("defers restoring an expanded window until fullscreen ends", async () => {
    const window = createWindowAdapter();
    const view = renderController(window.adapter);

    act(() => {
      void view.result.current.open();
    });
    await waitFor(() => expect(view.result.current.phase).toBe("open"));
    window.setFullscreen(true);
    act(() => {
      void view.result.current.close();
    });
    await waitFor(() => expect(view.result.current.phase).toBe("closed"));
    expect(window.currentWidth()).toBe(1_640);

    window.setFullscreen(false);
    window.emitResize();
    await waitFor(() => expect(window.currentWidth()).toBe(1_200));
  });
});
