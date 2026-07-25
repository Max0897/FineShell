import { useEffect, useMemo } from "react";
import { Table } from "@arco-design/web-react";
import type { TableColumnProps } from "@arco-design/web-react";
import { isApplePlatform } from "../platform-utils";

export interface ShortcutGuideItem {
  key: string;
  category: string;
  action: string;
  mac: string;
  other: string;
  description: string;
}

export const SHORTCUT_GUIDE_ITEMS: ShortcutGuideItem[] = [
  {
    key: "quick-commands",
    category: "通用",
    action: "打开快捷命令",
    mac: "Command + Shift + P",
    other: "Ctrl + Shift + P",
    description: "存在活动终端会话时可用",
  },
  {
    key: "settings",
    category: "通用",
    action: "打开设置",
    mac: "Command + ,",
    other: "Ctrl + ,",
    description: "也可以使用标签栏右侧的设置按钮",
  },
  {
    key: "terminal-search",
    category: "终端",
    action: "查找终端内容",
    mac: "Command + F",
    other: "Ctrl + F",
    description: "在当前活动终端中打开查找栏",
  },
  {
    key: "terminal-search-next",
    category: "终端",
    action: "下一个匹配项",
    mac: "Enter",
    other: "Enter",
    description: "终端查找栏获得焦点时可用",
  },
  {
    key: "terminal-search-previous",
    category: "终端",
    action: "上一个匹配项",
    mac: "Shift + Enter",
    other: "Shift + Enter",
    description: "终端查找栏获得焦点时可用",
  },
  {
    key: "terminal-search-close",
    category: "终端",
    action: "关闭查找栏",
    mac: "Esc",
    other: "Esc",
    description: "返回当前终端",
  },
  {
    key: "files-select-all",
    category: "文件管理",
    action: "选中全部文件",
    mac: "Command + A",
    other: "Ctrl + A",
    description: "文件管理区域获得焦点时可用",
  },
  {
    key: "files-invert-selection",
    category: "文件管理",
    action: "反选文件",
    mac: "Command + Shift + A",
    other: "Ctrl + Shift + A",
    description: "只反选当前目录中可见的文件",
  },
  {
    key: "files-save-text",
    category: "文件管理",
    action: "保存远程文本",
    mac: "Command + S",
    other: "Ctrl + S",
    description: "使用内置文本编辑器时可用",
  },
];

export interface ShortcutGuideRow extends Omit<ShortcutGuideItem, "mac" | "other"> {
  shortcut: string;
}

export function shortcutGuideRows(platform = navigator.platform) {
  const shortcutKey = isApplePlatform(platform) ? "mac" : "other";
  return SHORTCUT_GUIDE_ITEMS.map(({ mac, other, ...item }) => ({
    ...item,
    shortcut: shortcutKey === "mac" ? mac : other,
  }));
}

function ShortcutKeys({ value }: { value: string }) {
  return <kbd className="shortcut-guide-keys">{value}</kbd>;
}

function ShortcutGuideWindow() {
  useEffect(() => {
    document.title = "快捷键与操作";
  }, []);

  const rows = useMemo(() => shortcutGuideRows(), []);
  const columns = useMemo<TableColumnProps<ShortcutGuideRow>[]>(
    () => [
      { dataIndex: "category", title: "分类", width: 100 },
      { dataIndex: "action", title: "功能", width: 150 },
      {
        dataIndex: "shortcut",
        title: "快捷键",
        width: 180,
        render: (value: string) => <ShortcutKeys value={value} />,
      },
      { dataIndex: "description", title: "说明" },
    ],
    [],
  );

  return (
    <main className="shortcut-guide-window">
      <section className="shortcut-guide-content">
        <Table
          border={{ wrapper: true, cell: false }}
          columns={columns}
          data={rows}
          pagination={false}
          rowKey="key"
        />
      </section>
    </main>
  );
}

export default ShortcutGuideWindow;
