use super::*;

pub(super) fn emit_output(app: &AppHandle, session_id: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let _ = app.emit_to(
        "main",
        SSH_OUTPUT_EVENT,
        SshOutputPayload {
            session_id: session_id.to_string(),
            data: STANDARD_NO_PAD.encode(bytes),
        },
    );
}

pub(super) fn emit_status(
    app: &AppHandle,
    session_id: &str,
    status: &'static str,
    error: Option<String>,
    recoverable: bool,
) {
    let _ = app.emit_to(
        "main",
        SSH_STATUS_EVENT,
        SshStatusPayload {
            session_id: session_id.to_string(),
            status,
            error,
            recoverable,
        },
    );
}

pub(super) fn local_port_forward_status(
    rule: &LocalPortForwardRule,
    status: &'static str,
    error: Option<String>,
) -> PortForwardStatus {
    PortForwardStatus {
        rule_id: rule.id.clone(),
        kind: PortForwardKind::Local,
        status,
        bind_address: rule.bind_address.clone(),
        bind_port: rule.bind_port,
        error,
    }
}

pub(super) fn remote_port_forward_status(
    rule: &RemotePortForwardRule,
    bound_port: u16,
    status: &'static str,
    error: Option<String>,
) -> PortForwardStatus {
    PortForwardStatus {
        rule_id: rule.id.clone(),
        kind: PortForwardKind::Remote,
        status,
        bind_address: rule.bind_address.clone(),
        bind_port: bound_port,
        error,
    }
}

pub(super) fn dynamic_port_forward_status(
    rule: &DynamicPortForwardRule,
    status: &'static str,
    error: Option<String>,
) -> PortForwardStatus {
    PortForwardStatus {
        rule_id: rule.id.clone(),
        kind: PortForwardKind::Dynamic,
        status,
        bind_address: rule.bind_address.clone(),
        bind_port: rule.bind_port,
        error,
    }
}

pub(super) fn emit_port_forward_status(
    app: &AppHandle,
    session_id: &str,
    status: &PortForwardStatus,
) {
    let _ = app.emit_to(
        "main",
        PORT_FORWARD_STATUS_EVENT,
        PortForwardStatusPayload {
            session_id: session_id.to_string(),
            rule_id: status.rule_id.clone(),
            kind: status.kind,
            status: status.status,
            bind_address: status.bind_address.clone(),
            bind_port: status.bind_port,
            error: status.error.clone(),
        },
    );
}
