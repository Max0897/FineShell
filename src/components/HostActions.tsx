import { Button, Dropdown, Menu, Modal, Space, Tooltip } from "@arco-design/web-react";
import {
  IconCopy,
  IconDelete,
  IconEdit,
  IconLink,
  IconMore,
} from "@arco-design/web-react/icon";
import type { HostRecord } from "../models";

interface HostActionsProps {
  disabled: boolean;
  host: HostRecord;
  onConnect: (host: HostRecord) => void;
  onCopy: (host: HostRecord) => void;
  onDelete: (host: HostRecord) => void | Promise<void>;
  onEdit: (host: HostRecord) => void;
}

function HostActions({
  disabled,
  host,
  onConnect,
  onCopy,
  onDelete,
  onEdit,
}: HostActionsProps) {
  return (
    <Space size="mini">
      <Button
        disabled={disabled}
        icon={<IconLink />}
        onClick={() => onConnect(host)}
        size="mini"
        type="primary"
      >
        连接
      </Button>
      <Dropdown
        disabled={disabled}
        droplist={
          <Menu
            className="host-more-menu"
            onClickMenuItem={(key) => {
              if (key === "edit") {
                onEdit(host);
              } else if (key === "copy") {
                onCopy(host);
              } else if (key === "delete") {
                Modal.confirm({
                  cancelText: "取消",
                  content: `删除后可在设置的回收站中恢复“${host.name}”。`,
                  okButtonProps: { status: "danger" },
                  okText: "删除",
                  onOk: () => onDelete(host),
                  title: "删除主机？",
                });
              }
            }}
          >
            <Menu.Item key="edit">
              <span className="host-more-menu-label">
                <IconEdit />
                编辑
              </span>
            </Menu.Item>
            <Menu.Item key="copy">
              <span className="host-more-menu-label">
                <IconCopy />
                复制
              </span>
            </Menu.Item>
            <Menu.Item className="host-more-delete" key="delete">
              <span className="host-more-menu-label">
                <IconDelete />
                删除
              </span>
            </Menu.Item>
          </Menu>
        }
        position="br"
        trigger="click"
      >
        <Tooltip content="更多操作">
          <Button
            aria-label={`更多 ${host.name} 操作`}
            disabled={disabled}
            icon={<IconMore />}
            size="mini"
          />
        </Tooltip>
      </Dropdown>
    </Space>
  );
}

export default HostActions;
