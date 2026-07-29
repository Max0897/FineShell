use std::collections::HashMap;

use serde_json::Value;

const MAX_APPROVAL_CREDENTIALS: usize = 600;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ApprovalCredential {
    token: String,
    call_id: String,
}

impl ApprovalCredential {
    pub(crate) fn call_id(&self) -> &str {
        &self.call_id
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ApprovalScope {
    pub(crate) task_id: String,
    pub(crate) plan_id: String,
    pub(crate) call_id: String,
    pub(crate) host_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) current_directory: Option<String>,
    pub(crate) action_fingerprint: String,
}

pub(crate) fn action_fingerprint(tool: &str, arguments: &Value) -> Result<String, String> {
    serde_json::to_string(arguments)
        .map(|arguments| format!("{tool}\0{arguments}"))
        .map_err(|_| "无法生成 AI 动作参数指纹".to_string())
}

#[derive(Clone, Debug)]
struct ApprovalRecord {
    scope: ApprovalScope,
    expires_at: u64,
}

#[derive(Default)]
pub(crate) struct ApprovalCredentialStore {
    next_sequence: u64,
    records: HashMap<String, ApprovalRecord>,
}

impl ApprovalCredentialStore {
    pub(crate) fn issue(
        &mut self,
        scope: ApprovalScope,
        now: u64,
        ttl_ms: u64,
    ) -> Result<ApprovalCredential, String> {
        self.records.retain(|_, record| record.expires_at > now);
        if self.records.len() >= MAX_APPROVAL_CREDENTIALS {
            return Err("待消费的 AI 审批凭证过多".to_string());
        }
        self.next_sequence = self.next_sequence.wrapping_add(1);
        let token = format!("approval-{now:x}-{:x}", self.next_sequence);
        let call_id = scope.call_id.clone();
        self.records.insert(
            token.clone(),
            ApprovalRecord {
                scope,
                expires_at: now.saturating_add(ttl_ms),
            },
        );
        Ok(ApprovalCredential { token, call_id })
    }

    pub(crate) fn consume(
        &mut self,
        credential: &ApprovalCredential,
        expected_scope: &ApprovalScope,
        now: u64,
    ) -> Result<(), String> {
        let Some(record) = self.records.remove(&credential.token) else {
            return Err("AI 审批凭证不存在或已被消费".to_string());
        };
        if record.expires_at <= now {
            return Err("AI 审批凭证已过期".to_string());
        }
        if credential.call_id != expected_scope.call_id || record.scope != *expected_scope {
            return Err("AI 审批凭证作用域不匹配".to_string());
        }
        Ok(())
    }

    pub(crate) fn revoke_plan(&mut self, task_id: &str, plan_id: &str) {
        self.records
            .retain(|_, record| record.scope.task_id != task_id || record.scope.plan_id != plan_id);
    }

    pub(crate) fn revoke_task(&mut self, task_id: &str) {
        self.records
            .retain(|_, record| record.scope.task_id != task_id);
    }
}

#[cfg(test)]
mod tests {
    use super::{ApprovalCredentialStore, ApprovalScope};

    fn scope() -> ApprovalScope {
        ApprovalScope {
            task_id: "task-1".to_string(),
            plan_id: "plan-1".to_string(),
            call_id: "call-1".to_string(),
            host_id: "host-1".to_string(),
            session_id: Some("session-1".to_string()),
            current_directory: Some("/srv/app".to_string()),
            action_fingerprint: "ping_target\0{\"target\":\"example.com\"}".to_string(),
        }
    }

    #[test]
    fn consumes_a_scoped_credential_exactly_once() {
        let mut store = ApprovalCredentialStore::default();
        let credential = store.issue(scope(), 1_000, 10_000).unwrap();
        store.consume(&credential, &scope(), 2_000).unwrap();
        assert_eq!(
            store.consume(&credential, &scope(), 2_001).unwrap_err(),
            "AI 审批凭证不存在或已被消费"
        );
    }

    #[test]
    fn burns_a_credential_after_a_scope_mismatch_or_expiry() {
        let mut store = ApprovalCredentialStore::default();
        let credential = store.issue(scope(), 1_000, 10_000).unwrap();
        let mut changed = scope();
        changed.action_fingerprint = "ping_target\0{\"target\":\"other.example\"}".to_string();
        assert_eq!(
            store.consume(&credential, &changed, 2_000).unwrap_err(),
            "AI 审批凭证作用域不匹配"
        );
        assert!(store.consume(&credential, &scope(), 2_001).is_err());

        let expired = store.issue(scope(), 5_000, 100).unwrap();
        assert_eq!(
            store.consume(&expired, &scope(), 5_100).unwrap_err(),
            "AI 审批凭证已过期"
        );
    }

    #[test]
    fn revokes_credentials_by_plan_and_task() {
        let mut store = ApprovalCredentialStore::default();
        let first = store.issue(scope(), 1_000, 10_000).unwrap();
        let mut second_scope = scope();
        second_scope.plan_id = "plan-2".to_string();
        let second = store.issue(second_scope.clone(), 1_000, 10_000).unwrap();

        store.revoke_plan("task-1", "plan-1");
        assert!(store.consume(&first, &scope(), 2_000).is_err());
        store
            .consume(&second, &second_scope, 2_000)
            .expect("another plan must keep its credential");

        let third = store.issue(scope(), 3_000, 10_000).unwrap();
        store.revoke_task("task-1");
        assert!(store.consume(&third, &scope(), 3_001).is_err());
    }
}
