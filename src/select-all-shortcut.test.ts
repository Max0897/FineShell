import { describe, expect, test } from "bun:test";
import {
  isEditableSelectAllTarget,
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
});
