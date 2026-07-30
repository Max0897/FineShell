import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { CollapsibleSplitTrigger } from "./App";

describe("CollapsibleSplitTrigger", () => {
  test("toggles on the second press without starting another resize", () => {
    const onMouseDown = mock(() => undefined);
    const onToggle = mock(() => undefined);
    render(
      <div onMouseDown={onMouseDown}>
        <CollapsibleSplitTrigger
          collapsed={false}
          direction="horizontal"
          label="服务器监控栏"
          nextNode={null}
          onToggle={onToggle}
          prevNode={null}
        />
      </div>,
    );

    const trigger = screen.getByRole("separator", {
      name: "双击隐藏服务器监控栏",
    });
    fireEvent.mouseDown(trigger, { button: 0 });
    expect(onToggle).not.toHaveBeenCalled();
    expect(onMouseDown).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(trigger, { button: 0 });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });
});
