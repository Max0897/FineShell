import { describe, expect, test } from "bun:test";
import {
  filterQuickCommands,
  quickCommandParameters,
  renderQuickCommand,
} from "./quick-command-utils";

const commands = [
  {
    id: "logs",
    name: "查看日志",
    command: "tail -n {{行数:100}} {{文件}}",
    group: "运维",
  },
  {
    id: "disk",
    name: "磁盘占用",
    command: "df -h",
    description: "查看磁盘空间",
  },
];

describe("quick command templates", () => {
  test("extracts unique parameters and their defaults in template order", () => {
    expect(
      quickCommandParameters(
        "tail -n {{ 行数: 100 }} {{文件}} {{行数:200}}",
      ),
    ).toEqual([
      { name: "行数", defaultValue: "100" },
      { name: "文件", defaultValue: undefined },
    ]);
  });

  test("renders values and falls back to template defaults", () => {
    expect(
      renderQuickCommand("tail -n {{行数:100}} {{文件}}", {
        行数: "   ",
        文件: "/var/log/syslog",
      }),
    ).toBe("tail -n 100 /var/log/syslog");
  });

  test("filters commands by name, group, description or template", () => {
    expect(filterQuickCommands(commands, "运维")).toEqual([commands[0]]);
    expect(filterQuickCommands(commands, "df -h")).toEqual([commands[1]]);
    expect(filterQuickCommands(commands, "空间")).toEqual([commands[1]]);
    expect(filterQuickCommands(commands, "")).toEqual(commands);
  });
});
