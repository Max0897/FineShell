import { isTauri } from "@tauri-apps/api/core";
import { listenProtocolEvent } from "./tauri-protocol";

export const SELECT_ALL_REQUEST_EVENT = "fineshell:select-all";

export interface SelectAllRequestDetail {
  invert: boolean;
}

function targetElement(target: EventTarget | null) {
  if (target instanceof Element) return target;
  return null;
}

const nonTextInputTypes = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isEditableSelectAllTarget(target: EventTarget | null) {
  const element = targetElement(target);
  const input = element?.closest<HTMLInputElement>("input");
  if (input) return !nonTextInputTypes.has(input.type);
  return Boolean(
    element?.closest('textarea, [contenteditable="true"], [role="textbox"]'),
  );
}

export function selectEditableTarget(target: EventTarget | null) {
  const element = targetElement(target);
  const input = element?.closest<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  );
  if (input && isEditableSelectAllTarget(input)) {
    input.select();
    return true;
  }

  const editable = element?.closest<HTMLElement>('[contenteditable="true"]');
  if (!editable) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(editable);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function requestContextSelectAll(invert: boolean) {
  const event = new CustomEvent<SelectAllRequestDetail>(
    SELECT_ALL_REQUEST_EVENT,
    {
      cancelable: true,
      detail: { invert },
    },
  );
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function isSelectAllShortcut(event: KeyboardEvent) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "a"
  );
}

export function installSelectAllShortcuts() {
  if (isTauri()) {
    void listenProtocolEvent("menu-select-all", ({ payload }) => {
      if (requestContextSelectAll(payload.invert)) return;
      if (!payload.invert) selectEditableTarget(document.activeElement);
    });
    return;
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (!isSelectAllShortcut(event)) return;
      if (!event.shiftKey && isEditableSelectAllTarget(event.target)) return;

      requestContextSelectAll(event.shiftKey);
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}
