import { describe, expect, test } from "bun:test";
import {
  handleDocumentSelectStart,
  handleSelectAllShortcut,
  isEditableSelectAllTarget,
  isSelectableTextTarget,
  requestContextSelectAll,
  SELECT_ALL_REQUEST_EVENT,
  selectEditableTarget,
} from "./select-all-shortcut";

describe("select all shortcuts", () => {
  test("keeps text selection inside editable controls", () => {
    const input = document.createElement("input");
    input.value = "FineShell";
    document.body.appendChild(input);

    expect(isEditableSelectAllTarget(input)).toBe(true);
    expect(selectEditableTarget(input)).toBe(true);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    input.remove();
  });

  test("does not treat file selection checkboxes as text editors", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    expect(isEditableSelectAllTarget(checkbox)).toBe(false);
    expect(selectEditableTarget(checkbox)).toBe(false);
  });

  test("dispatches a cancelable contextual request", () => {
    let invert = false;
    const listener = (event: Event) => {
      const request = event as CustomEvent<{ invert: boolean }>;
      invert = request.detail.invert;
      request.preventDefault();
    };
    window.addEventListener(SELECT_ALL_REQUEST_EVENT, listener);

    expect(requestContextSelectAll(true)).toBe(true);
    expect(invert).toBe(true);

    window.removeEventListener(SELECT_ALL_REQUEST_EVENT, listener);
  });

  test("blocks document-wide select all outside editable controls", () => {
    const content = document.createElement("div");
    content.textContent = "FineShell workspace";
    document.body.appendChild(content);

    const range = document.createRange();
    range.selectNodeContents(content);
    window.getSelection()?.addRange(range);

    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: content });

    handleSelectAllShortcut(event);

    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.rangeCount).toBe(0);
    content.remove();
  });

  test("keeps native select all behavior inside text inputs", () => {
    const input = document.createElement("input");
    const event = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: input });

    handleSelectAllShortcut(event);

    expect(event.defaultPrevented).toBe(false);
  });

  test("blocks pointer text selection across regular interface content", () => {
    const content = document.createElement("div");
    const event = new Event("selectstart", { cancelable: true });
    Object.defineProperty(event, "target", { value: content });

    handleDocumentSelectStart(event);

    expect(isSelectableTextTarget(content)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  test("allows pointer text selection in explicitly selectable content", () => {
    const terminalText = document.createElement("span");
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    terminal.appendChild(terminalText);
    const event = new Event("selectstart", { cancelable: true });
    Object.defineProperty(event, "target", { value: terminalText });

    handleDocumentSelectStart(event);

    expect(isSelectableTextTarget(terminalText)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });
});
