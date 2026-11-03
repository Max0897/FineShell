//! AI 终端命令的风险分级。规则与前端共用 `protocol/command-risk.json`，
//! 两侧必须给出相同结论：前端据此决定是否自动审批，后端据此决定是否放行。
//!
//! 只读判定采用白名单：命令不含任何 shell 元字符（管道除外），且每段管道
//! 的命令都在白名单内、没有使用写入类参数。其余命令一律视为会修改系统；
//! 命中破坏性规则的命令即使在完全访问模式下也必须由用户确认。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CommandRiskClass {
    ReadOnly,
    Mutating,
    Destructive,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlyCommandRule {
    #[serde(default)]
    subcommands: Vec<String>,
    #[serde(default)]
    forbidden_arguments: Vec<String>,
    #[serde(default)]
    required_arguments: Vec<String>,
    max_arguments: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandRiskSpec {
    destructive_patterns: Vec<String>,
    unsafe_characters: String,
    read_only_commands: HashMap<String, ReadOnlyCommandRule>,
}

struct CommandRiskRules {
    destructive: Vec<Regex>,
    unsafe_characters: Vec<char>,
    read_only_commands: HashMap<String, ReadOnlyCommandRule>,
}

fn rules() -> &'static CommandRiskRules {
    static RULES: OnceLock<CommandRiskRules> = OnceLock::new();
    RULES.get_or_init(|| {
        let spec: CommandRiskSpec =
            serde_json::from_str(include_str!("../../protocol/command-risk.json"))
                .expect("command risk rules must be valid JSON");
        CommandRiskRules {
            destructive: spec
                .destructive_patterns
                .iter()
                .map(|pattern| {
                    Regex::new(&format!("(?i){pattern}"))
                        .expect("command risk pattern must compile")
                })
                .collect(),
            unsafe_characters: spec.unsafe_characters.chars().collect(),
            read_only_commands: spec.read_only_commands,
        }
    })
}

fn argument_matches(argument: &str, flag: &str) -> bool {
    argument == flag
        || argument
            .strip_prefix(flag)
            .is_some_and(|rest| rest.starts_with('='))
}

fn segment_is_read_only(segment: &str, rules: &CommandRiskRules) -> bool {
    let mut words = segment.split_whitespace();
    let Some(program) = words.next() else {
        return false;
    };
    let Some(rule) = rules.read_only_commands.get(program) else {
        return false;
    };
    let arguments = words.collect::<Vec<_>>();
    if rule
        .max_arguments
        .is_some_and(|maximum| arguments.len() > maximum)
    {
        return false;
    }
    if arguments.iter().any(|argument| {
        rule.forbidden_arguments
            .iter()
            .any(|flag| argument_matches(argument, flag))
    }) {
        return false;
    }
    if !rule.required_arguments.is_empty()
        && !arguments
            .iter()
            .any(|argument| rule.required_arguments.iter().any(|flag| flag == argument))
    {
        return false;
    }
    if !rule.subcommands.is_empty() {
        let subcommand = arguments.iter().find(|argument| !argument.starts_with('-'));
        if !subcommand
            .is_some_and(|subcommand| rule.subcommands.iter().any(|name| name == subcommand))
        {
            return false;
        }
    }
    true
}

pub(crate) fn classify_terminal_command(command: &str) -> CommandRiskClass {
    let rules = rules();
    if rules
        .destructive
        .iter()
        .any(|pattern| pattern.is_match(command))
    {
        return CommandRiskClass::Destructive;
    }
    if command.trim().is_empty()
        || command
            .chars()
            .any(|character| rules.unsafe_characters.contains(&character))
    {
        return CommandRiskClass::Mutating;
    }
    if command
        .split('|')
        .all(|segment| segment_is_read_only(segment, rules))
    {
        CommandRiskClass::ReadOnly
    } else {
        CommandRiskClass::Mutating
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_terminal_command, CommandRiskClass};
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Cases {
        read_only: Vec<String>,
        mutating: Vec<String>,
        destructive: Vec<String>,
    }

    #[test]
    fn classifies_shared_command_cases() {
        let cases: Cases =
            serde_json::from_str(include_str!("../../protocol/command-risk-cases.json")).unwrap();
        for (commands, expected) in [
            (&cases.read_only, CommandRiskClass::ReadOnly),
            (&cases.mutating, CommandRiskClass::Mutating),
            (&cases.destructive, CommandRiskClass::Destructive),
        ] {
            for command in commands {
                assert_eq!(
                    classify_terminal_command(command),
                    expected,
                    "command: {command:?}"
                );
            }
        }
    }
}
