import { cloneElement, useRef, useState } from "react";
import type {
  MouseEvent,
  MouseEventHandler,
  ReactElement,
  ReactNode,
} from "react";
import { Dropdown, Menu } from "@arco-design/web-react";

export interface ContextMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
  children?: ContextMenuItem[];
  onClick?: () => void | Promise<void>;
}

interface ContextMenuChildProps {
  onContextMenu?: MouseEventHandler<HTMLElement>;
}

interface ContextMenuProps {
  children: ReactElement<ContextMenuChildProps>;
  disabled?: boolean;
  items?: ContextMenuItem[];
  resolveItems?: (event: MouseEvent<HTMLElement>) => ContextMenuItem[];
}

function findMenuItem(
  items: ContextMenuItem[],
  key: string,
): ContextMenuItem | undefined {
  for (const item of items) {
    if (item.key === key) return item;
    const child = item.children && findMenuItem(item.children, key);
    if (child) return child;
  }
  return undefined;
}

function menuItemClassName(item: ContextMenuItem) {
  return [
    item.danger ? "app-context-menu-danger" : "",
    item.dividerBefore ? "app-context-menu-divider" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderMenuItem(item: ContextMenuItem): ReactNode {
  if (item.children?.length) {
    return (
      <Menu.SubMenu
        className={menuItemClassName(item) || undefined}
        key={item.key}
        title={
          <span className="app-context-menu-label">
            {item.icon}
            {item.label}
          </span>
        }
      >
        {item.children.map(renderMenuItem)}
      </Menu.SubMenu>
    );
  }

  return (
    <Menu.Item
      className={menuItemClassName(item) || undefined}
      disabled={item.disabled}
      key={item.key}
    >
      <span className="app-context-menu-label">
        {item.icon}
        {item.label}
      </span>
    </Menu.Item>
  );
}

function ContextMenu({
  children,
  disabled = false,
  items = [],
  resolveItems,
}: ContextMenuProps) {
  const [activeItems, setActiveItems] = useState(items);
  const [popupVisible, setPopupVisible] = useState(false);
  const canOpenRef = useRef(false);

  const handleContextMenu: MouseEventHandler<HTMLElement> = (event) => {
    children.props.onContextMenu?.(event);
    const nextItems = resolveItems?.(event) ?? items;
    canOpenRef.current = !disabled && nextItems.length > 0;
    setActiveItems(nextItems);

    if (!canOpenRef.current) {
      setPopupVisible(false);
    }
  };

  const trigger = cloneElement(children, {
    onContextMenu: handleContextMenu,
  });

  return (
    <Dropdown
      disabled={disabled}
      droplist={
        <Menu
          className="app-context-menu"
          onClickMenuItem={(key) => {
            const item = findMenuItem(activeItems, key);
            if (!item?.onClick || item.disabled) return false;
            return item.onClick();
          }}
          selectable={false}
        >
          {activeItems.map(renderMenuItem)}
        </Menu>
      }
      onVisibleChange={(visible) => {
        if (!visible || canOpenRef.current) {
          setPopupVisible(visible);
        }
      }}
      popupVisible={popupVisible}
      position="bl"
      trigger="contextMenu"
      triggerProps={{ containerScrollToClose: true }}
    >
      {trigger}
    </Dropdown>
  );
}

export default ContextMenu;
