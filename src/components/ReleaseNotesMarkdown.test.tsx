import { describe, expect, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import ReleaseNotesMarkdown from "./ReleaseNotesMarkdown";

describe("ReleaseNotesMarkdown", () => {
  test("renders GitHub-flavored release notes as semantic content", async () => {
    render(
      <ReleaseNotesMarkdown>{`### 新增

- 支持更新日志
- 支持 ~~旧功能~~ **新功能**

[查看版本](https://example.com/release)`}</ReleaseNotesMarkdown>,
    );

    expect(await screen.findByRole("heading", { name: "新增" })).not.toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("旧功能").tagName).toBe("DEL");
    expect(screen.getByText("新功能").tagName).toBe("STRONG");
    expect(
      screen.getByRole("link", { name: "查看版本" }).getAttribute("href"),
    ).toBe("https://example.com/release");
  });

  test("does not create raw HTML elements from release metadata", async () => {
    const { container } = render(
      <ReleaseNotesMarkdown>{`更新内容<script>alert("xss")</script>`}</ReleaseNotesMarkdown>,
    );

    await waitFor(() => {
      expect(
        container.querySelector(".release-notes-markdown-fallback"),
      ).toBeNull();
    });
    expect(container.textContent).toContain("更新内容");
    expect(document.querySelector("script")).toBeNull();
  });
});
