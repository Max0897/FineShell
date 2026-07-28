import { useState } from "react";
import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import AiFileDiffView, {
  aiFileLanguage,
  type AiFileDiffMode,
} from "./AiFileDiffView";

function DiffHarness() {
  const [mode, setMode] = useState<AiFileDiffMode>("unified");
  return (
    <AiFileDiffView
      mode={mode}
      onChangeMode={setMode}
      originalContent={"const port = 80;\nkeep();\n"}
      path="/srv/app.ts"
      proposedContent={"const port = 8080;\nkeep();\nstart();\n"}
    />
  );
}

describe("AiFileDiffView", () => {
  test("renders old and new line numbers with syntax-highlighted tokens", () => {
    render(<DiffHarness />);

    const diff = screen.getByRole("region", { name: "文件修改差异" });
    expect(diff.querySelector('[data-old-line="1"]:not([data-new-line])')).not.toBeNull();
    expect(diff.querySelector('[data-new-line="1"]:not([data-old-line])')).not.toBeNull();
    expect(diff.querySelector('[data-old-line="2"][data-new-line="2"]')).not.toBeNull();
    expect(diff.querySelector(".token.keyword")?.textContent).toBe("const");
  });

  test("switches to an aligned side-by-side view", () => {
    render(<DiffHarness />);

    fireEvent.click(screen.getByText("左右"));

    expect(screen.getByText("原文件")).not.toBeNull();
    expect(screen.getByText("建议文件")).not.toBeNull();
    expect(document.querySelectorAll(".ai-file-diff-split-row").length).toBe(3);
  });

  test("maps known extensions and falls back to plain text", () => {
    expect(aiFileLanguage("/srv/app.tsx")).toBe("tsx");
    expect(aiFileLanguage("/etc/config.yaml")).toBe("yaml");
    expect(aiFileLanguage("/srv/README.unknown")).toBe("plain");
  });

  test("bounds large unchanged regions around the actual change", () => {
    const original = Array.from(
      { length: 2_100 },
      (_, index) => `line ${index + 1}`,
    );
    const proposed = [...original];
    proposed[2_099] = "changed";

    render(
      <AiFileDiffView
        mode="unified"
        onChangeMode={() => undefined}
        originalContent={`${original.join("\n")}\n`}
        path="/srv/large.txt"
        proposedContent={`${proposed.join("\n")}\n`}
      />,
    );

    expect(screen.getByRole("note").textContent).toContain("省略");
    expect(screen.getByRole("region", { name: "文件修改差异" }).textContent)
      .toContain("changed");
  });
});
