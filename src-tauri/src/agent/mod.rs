use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;

use crate::agent_actions::{normalize_remote_action_path, valid_command};
use crate::agent_approvals::{
    action_fingerprint, ApprovalCredential, ApprovalCredentialStore, ApprovalScope,
};
use crate::agent_policy::{registered_action_policy, PolicyDecision};
use crate::agent_verification::{
    AgentBusinessVerification, AgentBusinessVerificationKind, AgentBusinessVerificationResult,
};
use crate::protocol::{CommandError, CommandResult, AGENT_TASK_EVENT, PROTOCOL_VERSION};

const MAX_AGENT_TASKS: usize = 100;
const MAX_AGENT_ID_CHARS: usize = 160;
const MAX_AGENT_OBJECTIVE_CHARS: usize = 24_000;
const MAX_AGENT_ACTIONS: usize = 24;
const MAX_AGENT_ACTION_MESSAGE_CHARS: usize = 500;
const MAX_AGENT_WRITABLE_FILES: usize = 8;
const MAX_AGENT_WRITABLE_FILE_BYTES: usize = 256 * 1024;
const MAX_AGENT_WRITABLE_FILES_BYTES: usize = 512 * 1024;
const MAX_OBSERVED_COMMAND_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
const APPROVAL_CREDENTIAL_TTL_MS: u64 = 10 * 60 * 1_000;
const MAX_AGENT_REPAIR_ATTEMPTS: u8 = 2;
const MAX_AGENT_EVENTS_PER_TASK: usize = 128;
const AGENT_RUNTIME_STATE_VERSION: u8 = 1;
const AGENT_RUNTIME_STATE_FILE: &str = "ai-agent-runtime.json";

mod model;
mod requests;

pub(crate) use model::*;
pub(crate) use requests::*;

mod context;
mod execution;
mod lifecycle;
mod persistence;
mod plans;
mod store;
mod task_state;
mod transitions;

pub(crate) use persistence::initialize;

mod commands;

pub(crate) use commands::*;

#[cfg(test)]
mod tests;
