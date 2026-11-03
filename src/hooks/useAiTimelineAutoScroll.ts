import { useEffect, useRef, type RefObject } from "react";

/** Distance from the bottom, in pixels, that still counts as following. */
export const AI_TIMELINE_STICK_THRESHOLD = 48;

export function isScrolledNearBottom(
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
  threshold = AI_TIMELINE_STICK_THRESHOLD,
) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
  );
}

/**
 * Keeps the timeline pinned to the newest content only while the user is
 * already at the bottom, so scrolling up to reread something isn't undone by
 * every streamed frame. A new message, a different conversation, or reopening
 * the panel always jumps back to the bottom.
 */
export function useAiTimelineAutoScroll(
  scrollRef: RefObject<HTMLElement>,
  {
    conversationId,
    messageCount,
    content,
    visible,
  }: {
    conversationId: string | undefined;
    messageCount: number;
    /** Changes whenever the rendered timeline content changes. */
    content: unknown;
    visible: boolean;
  },
) {
  const followingRef = useRef(true);
  const previousRef = useRef({ conversationId, messageCount, visible });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const handleScroll = () => {
      followingRef.current = isScrolledNearBottom(element);
    };
    element.addEventListener("scroll", handleScroll, { passive: true });
    return () => element.removeEventListener("scroll", handleScroll);
  }, [scrollRef, visible]);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { conversationId, messageCount, visible };
    if (!visible) return;
    if (
      !previous.visible ||
      previous.conversationId !== conversationId ||
      messageCount > previous.messageCount
    ) {
      followingRef.current = true;
    }
    if (!followingRef.current) return;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [content, conversationId, messageCount, scrollRef, visible]);
}
