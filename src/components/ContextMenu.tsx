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
  onClick: () => void | Promise<void>;
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
            const item = activeItems.find((candidate) => candidate.key === key);
            if (!item || item.disabled) return false;
            return item.onClick();
          }}
          selectable={false}
        >
          {activeItems.map((item) => (
            <Menu.Item
              className={item.danger ? "app-context-menu-danger" : undefined}
              disabled={item.disabled}
              key={item.key}
            >
              {item.icon}
              {item.label}
            </Menu.Item>
          ))}
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
