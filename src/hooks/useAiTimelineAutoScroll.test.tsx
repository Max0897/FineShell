import { describe, expect, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import {
  isScrolledNearBottom,
  useAiTimelineAutoScroll,
} from "./useAiTimelineAutoScroll";

function scrollContainer(scrollHeight: number, clientHeight = 300) {
  const element = document.createElement("div");
  let height = scrollHeight;
  Object.defineProperty(element, "scrollHeight", { get: () => height });
  Object.defineProperty(element, "clientHeight", { value: clientHeight });
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, height - clientHeight));
    },
  });
  return {
    element,
    grow: (amount: number) => {
      height += amount;
    },
    userScrollTo: (value: number) => {
      element.scrollTop = value;
      element.dispatchEvent(new Event("scroll"));
    },
  };
}

function render(element: HTMLElement) {
  return renderHook(
    (props: { content: unknown; messageCount: number }) =>
      useAiTimelineAutoScroll(
        { current: element },
        { ...props, conversationId: "conversation-1", visible: true },
      ),
    { initialProps: { content: "a", messageCount: 2 } },
  );
}

describe("useAiTimelineAutoScroll", () => {
  test("detects whether the view is near the bottom", () => {
    expect(
      isScrolledNearBottom({ clientHeight: 300, scrollHeight: 1000, scrollTop: 700 }),
    ).toBe(true);
    expect(
      isScrolledNearBottom({ clientHeight: 300, scrollHeight: 1000, scrollTop: 600 }),
    ).toBe(false);
  });

  test("follows streamed content while the user stays at the bottom", async () => {
    const container = scrollContainer(1000);
    const view = render(container.element);
    await waitFor(() => expect(container.element.scrollTop).toBe(700));

    container.grow(200);
    view.rerender({ content: "ab", messageCount: 2 });

    await waitFor(() => expect(container.element.scrollTop).toBe(900));
  });

  test("leaves the position alone after the user scrolls up", async () => {
    const container = scrollContainer(1000);
    const view = render(container.element);
    await waitFor(() => expect(container.element.scrollTop).toBe(700));

    container.userScrollTo(100);
    container.grow(200);
    view.rerender({ content: "ab", messageCount: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(container.element.scrollTop).toBe(100);
  });

  test("jumps back to the bottom when a new message is added", async () => {
    const container = scrollContainer(1000);
    const view = render(container.element);
    await waitFor(() => expect(container.element.scrollTop).toBe(700));

    container.userScrollTo(100);
    container.grow(200);
    view.rerender({ content: "abc", messageCount: 4 });

    await waitFor(() => expect(container.element.scrollTop).toBe(900));
  });
});
