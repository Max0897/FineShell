import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { aiWindowTargetWidth } from "../ai-sidebar";

export type AiSidebarPhase = "closed" | "opening" | "open" | "closing";

export interface AiSidebarWindowAdapter {
  getInnerSize: () => Promise<{ height: number; width: number }>;
  isFullscreen: () => Promise<boolean>;
  isMaximized: () => Promise<boolean>;
  onResized?: (callback: () => void) => Promise<() => void>;
  setInnerSize: (width: number, height: number) => Promise<void>;
}

interface UseAiSidebarControllerOptions {
  getWorkspaceWidth: () => number | undefined;
  onResizeFailure?: (error: unknown, operation: "expand" | "collapse") => void;
  sidebarWidth: number;
  windowAdapter?: AiSidebarWindowAdapter | null;
}

interface AiSidebarControllerState {
  frozenWorkspaceWidth: number | null;
  phase: AiSidebarPhase;
}

function createWindowAdapter(): AiSidebarWindowAdapter | null {
  if (!isTauri()) return null;
  const appWindow = getCurrentWindow();
  return {
    getInnerSize: async () => {
      const scaleFactor = await appWindow.scaleFactor();
      const size = (await appWindow.innerSize()).toLogical(scaleFactor);
      return { height: size.height, width: size.width };
    },
    isFullscreen: () => appWindow.isFullscreen(),
    isMaximized: () => appWindow.isMaximized(),
    onResized: (callback) => appWindow.onResized(callback),
    setInnerSize: (width, height) =>
      appWindow.setSize(new LogicalSize(width, height)),
  };
}

export function useAiSidebarController({
  getWorkspaceWidth,
  onResizeFailure,
  sidebarWidth,
  windowAdapter,
}: UseAiSidebarControllerOptions) {
  const [state, setState] = useState<AiSidebarControllerState>({
    frozenWorkspaceWidth: null,
    phase: "closed",
  });
  const stateRef = useRef(state);
  const sidebarWidthRef = useRef(sidebarWidth);
  const getWorkspaceWidthRef = useRef(getWorkspaceWidth);
  const onResizeFailureRef = useRef(onResizeFailure);
  const adapterRef = useRef<AiSidebarWindowAdapter | null>();
  const appliedExpansionRef = useRef(0);
  const resizeFailureReportedRef = useRef(false);
  const transitionQueueRef = useRef<Promise<void>>(Promise.resolve());

  if (adapterRef.current === undefined) {
    adapterRef.current =
      windowAdapter === undefined ? createWindowAdapter() : windowAdapter;
  }
  sidebarWidthRef.current = sidebarWidth;
  getWorkspaceWidthRef.current = getWorkspaceWidth;
  onResizeFailureRef.current = onResizeFailure;

  const updateState = useCallback(
    (update: Partial<AiSidebarControllerState>) => {
      const next = { ...stateRef.current, ...update };
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  const reportResizeFailure = useCallback(
    (error: unknown, operation: "expand" | "collapse") => {
      if (resizeFailureReportedRef.current) return;
      resizeFailureReportedRef.current = true;
      onResizeFailureRef.current?.(error, operation);
    },
    [],
  );

  const enqueue = useCallback((operation: () => Promise<void>) => {
    transitionQueueRef.current = transitionQueueRef.current
      .catch(() => undefined)
      .then(operation);
    return transitionQueueRef.current;
  }, []);

  const windowCanResize = useCallback(
    async (adapter: AiSidebarWindowAdapter) => {
      const [maximized, fullscreen] = await Promise.all([
        adapter.isMaximized(),
        adapter.isFullscreen(),
      ]);
      return !maximized && !fullscreen;
    },
    [],
  );

  const open = useCallback(() => {
    const currentPhase = stateRef.current.phase;
    if (currentPhase === "open" || currentPhase === "opening") {
      return transitionQueueRef.current;
    }

    const adapter = adapterRef.current;
    if (!adapter) {
      updateState({ frozenWorkspaceWidth: null, phase: "open" });
      return Promise.resolve();
    }

    updateState({
      frozenWorkspaceWidth: getWorkspaceWidthRef.current() ?? null,
      phase: "opening",
    });

    return enqueue(async () => {
      if (stateRef.current.phase !== "opening") return;
      try {
        if (
          appliedExpansionRef.current === 0 &&
          (await windowCanResize(adapter))
        ) {
          if (stateRef.current.phase !== "opening") return;
          const before = await adapter.getInnerSize();
          const targetWidth = aiWindowTargetWidth(
            before.width,
            true,
            sidebarWidthRef.current,
          );
          await adapter.setInnerSize(targetWidth, before.height);
          appliedExpansionRef.current = Math.max(0, targetWidth - before.width);
          const after = await adapter.getInnerSize();
          appliedExpansionRef.current = Math.max(0, after.width - before.width);
          resizeFailureReportedRef.current = false;
        }
      } catch (error) {
        reportResizeFailure(error, "expand");
      }

      if (stateRef.current.phase === "opening") {
        updateState({ frozenWorkspaceWidth: null, phase: "open" });
      }
    });
  }, [enqueue, reportResizeFailure, updateState, windowCanResize]);

  const collapseWindow = useCallback(
    async (adapter: AiSidebarWindowAdapter) => {
      const expansion = appliedExpansionRef.current;
      if (expansion <= 0 || !(await windowCanResize(adapter))) return false;
      const before = await adapter.getInnerSize();
      await adapter.setInnerSize(
        aiWindowTargetWidth(before.width, false, expansion),
        before.height,
      );
      appliedExpansionRef.current = 0;
      resizeFailureReportedRef.current = false;
      return true;
    },
    [windowCanResize],
  );

  const close = useCallback(() => {
    const currentPhase = stateRef.current.phase;
    if (currentPhase === "closed" || currentPhase === "closing") {
      return transitionQueueRef.current;
    }

    const adapter = adapterRef.current;
    if (!adapter) {
      updateState({ frozenWorkspaceWidth: null, phase: "closed" });
      return Promise.resolve();
    }

    updateState({
      frozenWorkspaceWidth: getWorkspaceWidthRef.current() ?? null,
      phase: "closing",
    });

    return enqueue(async () => {
      if (stateRef.current.phase !== "closing") return;
      try {
        await collapseWindow(adapter);
      } catch (error) {
        reportResizeFailure(error, "collapse");
      }
      if (stateRef.current.phase === "closing") {
        updateState({ frozenWorkspaceWidth: null, phase: "closed" });
      }
    });
  }, [collapseWindow, enqueue, reportResizeFailure, updateState]);

  const toggle = useCallback(() => {
    if (["open", "opening"].includes(stateRef.current.phase)) return close();
    return open();
  }, [close, open]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter?.onResized) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    void adapter
      .onResized(() => {
        if (
          disposed ||
          stateRef.current.phase !== "closed" ||
          appliedExpansionRef.current <= 0
        ) {
          return;
        }
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void enqueue(async () => {
            if (
              disposed ||
              stateRef.current.phase !== "closed" ||
              appliedExpansionRef.current <= 0
            ) {
              return;
            }
            try {
              await collapseWindow(adapter);
            } catch (error) {
              reportResizeFailure(error, "collapse");
            }
          });
        }, 120);
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [collapseWindow, enqueue, reportResizeFailure]);

  return {
    active: state.phase === "open" || state.phase === "opening",
    close,
    frozenWorkspaceWidth: state.frozenWorkspaceWidth,
    open,
    phase: state.phase,
    toggle,
    transitioning: state.phase === "opening" || state.phase === "closing",
    visible: state.phase === "open",
  };
}
