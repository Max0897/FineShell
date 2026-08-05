import { useEffect, useState } from "react";
import {
  APPEARANCE_RESOLVED_EVENT,
  type ResolvedAppearance,
} from "../appearance";

function currentResolvedAppearance(): ResolvedAppearance {
  return document.body.dataset.appearance === "dark" ? "dark" : "light";
}

export function useResolvedAppearance() {
  const [appearance, setAppearance] = useState(currentResolvedAppearance);

  useEffect(() => {
    const handleAppearance = (event: Event) => {
      const next = (event as CustomEvent<ResolvedAppearance>).detail;
      setAppearance(next);
    };
    window.addEventListener(APPEARANCE_RESOLVED_EVENT, handleAppearance);
    return () =>
      window.removeEventListener(APPEARANCE_RESOLVED_EVENT, handleAppearance);
  }, []);

  return appearance;
}
