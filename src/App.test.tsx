import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CollapsibleSplitTrigger } from "./App";

describe("CollapsibleSplitTrigger", () => {
  test("leaves repeated presses to the resize handler", () => {
    const onMouseDown = mock(() => undefined);
    render(
      <div onMouseDown={onMouseDown}>
        <CollapsibleSplitTrigger
          direction="horizontal"
          label="服务器监控栏"
          nextNode={null}
          prevNode={null}
        />
      </div>,
    );

    const trigger = screen.getByRole("separator", {
      name: "调整服务器监控栏大小",
    });
    fireEvent.mouseDown(trigger, { button: 0 });
    expect(onMouseDown).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(trigger, { button: 0 });
    expect(onMouseDown).toHaveBeenCalledTimes(2);
  });
});
