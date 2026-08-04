import { Button, Spin } from "@arco-design/web-react";
import { IconExclamationCircleFill } from "@arco-design/web-react/icon";

interface ConnectionStatusOverlayProps {
  description: string;
  onReconnect: () => void;
  reconnecting?: boolean;
}

function ConnectionStatusOverlay({
  description,
  onReconnect,
  reconnecting = false,
}: ConnectionStatusOverlayProps) {
  return (
    <div
      className={`connection-status-overlay${
        reconnecting ? " is-reconnecting" : ""
      }`}
      role="alert"
    >
      <Spin
        block
        element={reconnecting ? undefined : <IconExclamationCircleFill />}
        loading
        tip={
          <div className="connection-status-overlay-content">
            <span>{description}</span>
            <Button
              disabled={reconnecting}
              onClick={onReconnect}
              size="small"
              type="primary"
            >
              {reconnecting ? "正在重连" : "重新连接"}
            </Button>
          </div>
        }
      >
        <div className="connection-status-overlay-anchor" />
      </Spin>
    </div>
  );
}

export default ConnectionStatusOverlay;
