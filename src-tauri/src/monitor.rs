use std::io::Read;

use serde::Serialize;
use ssh2::Session;

const MONITOR_COMMAND: &str = r#"
LC_ALL=C
printf 'hostname='
(hostname 2>/dev/null || uname -n 2>/dev/null || printf 'unknown') | tr '\n' ' '
printf '\noperating_system='
if [ -r /etc/os-release ]; then
  . /etc/os-release
  printf '%s' "${PRETTY_NAME:-${NAME:-Linux}}"
else
  uname -s 2>/dev/null || printf 'Unix'
fi
printf '\nkernel='
uname -r 2>/dev/null || printf 'unknown'
printf '\nuptime_seconds='
awk '{printf "%.0f", $1}' /proc/uptime 2>/dev/null || printf '0'
printf '\ncpu_percent='
if [ -r /proc/stat ]; then
  read_cpu() {
    awk '/^cpu / { idle=$5+$6; total=0; for (i=2; i<=NF; i++) total+=$i; printf "%.0f %.0f", idle, total; exit }' /proc/stat
  }
  set -- $(read_cpu); idle_one=$1; total_one=$2
  sleep 0.2
  set -- $(read_cpu); idle_two=$1; total_two=$2
  awk -v i1="$idle_one" -v t1="$total_one" -v i2="$idle_two" -v t2="$total_two" 'BEGIN { delta=t2-t1; if (delta>0) printf "%.2f", 100*(delta-(i2-i1))/delta; else printf "0" }'
else
  printf '0'
fi
printf '\nmemory_kib='
awk '/^MemTotal:/ { total=$2 } /^MemAvailable:/ { available=$2 } END { printf "%.0f,%.0f", total, available }' /proc/meminfo 2>/dev/null || printf '0,0'
printf '\ndisk_kib='
df -Pk / 2>/dev/null | awk 'NR==2 { printf "%s,%s,%s", $2, $3, $4 }'
printf '\nload_average='
awk '{ printf "%s,%s,%s", $1, $2, $3 }' /proc/loadavg 2>/dev/null || printf '0,0,0'
printf '\nnetwork_bytes='
awk -F '[: ]+' 'NR > 2 { interface=$2; if (interface != "lo") { received += $3; transmitted += $11 } } END { printf "%.0f,%.0f", received, transmitted }' /proc/net/dev 2>/dev/null || printf '0,0'
printf '\n'
"#;

const NETWORK_CONNECTIONS_COMMAND: &str = r#"
LC_ALL=C
if ! command -v ss >/dev/null 2>&1; then
  printf '__FINESHELL_SS_MISSING__\n'
  exit 127
fi
ss -H -tunap 2>/dev/null | awk 'BEGIN { OFS="\t" } NR <= 500 { process=""; for (i=7; i<=NF; i++) process=process (i == 7 ? "" : " ") $i; print $1, $2, $5, $6, process } END { if (NR > 500) print "__FINESHELL_TRUNCATED__" }'
"#;

const PROCESS_LIST_COMMAND: &str = r#"
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"
LC_ALL=C
export PATH LC_ALL
ps_command=''
for candidate in /usr/bin/ps /bin/ps /usr/local/bin/ps; do
  if "$candidate" -eo pid=,ppid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=,args= --sort=-pcpu >/dev/null 2>&1; then
    ps_command=$candidate
    break
  fi
done
if [ -z "$ps_command" ]; then
  candidate=$(command -v ps 2>/dev/null)
  if [ -n "$candidate" ] && "$candidate" -eo pid=,ppid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=,args= --sort=-pcpu >/dev/null 2>&1; then
    ps_command=$candidate
  fi
fi
if [ -z "$ps_command" ]; then
  if command -v ps >/dev/null 2>&1; then
    printf '__FINESHELL_PS_UNSUPPORTED__\n'
    exit 2
  else
    printf '__FINESHELL_PS_MISSING__\n'
    exit 127
  fi
fi
awk_command=''
for candidate in /usr/bin/awk /bin/awk /usr/local/bin/awk; do
  if "$candidate" 'BEGIN { exit 0 }' </dev/null >/dev/null 2>&1; then
    awk_command=$candidate
    break
  fi
done
if [ -z "$awk_command" ]; then
  awk_command=$(command -v awk 2>/dev/null)
fi
if [ -z "$awk_command" ]; then
  printf '__FINESHELL_AWK_MISSING__\n'
  exit 127
fi
"$ps_command" -eo pid=,ppid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=,args= --sort=-pcpu 2>/dev/null | "$awk_command" 'NR <= 500 { print } END { if (NR > 500) print "__FINESHELL_TRUNCATED__" }'
"#;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerMonitorSnapshot {
    hostname: String,
    operating_system: String,
    kernel: String,
    uptime_seconds: u64,
    cpu_usage_percent: f64,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    memory_usage_percent: f64,
    disk_total_bytes: u64,
    disk_used_bytes: u64,
    disk_usage_percent: f64,
    load_average: [f64; 3],
    network_receive_bytes: u64,
    network_transmit_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkPingResult {
    target: String,
    reachable: bool,
    transmitted: u32,
    received: u32,
    packet_loss_percent: f64,
    minimum_latency_ms: Option<f64>,
    average_latency_ms: Option<f64>,
    maximum_latency_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkConnection {
    id: String,
    protocol: String,
    state: String,
    local_address: String,
    local_port: String,
    remote_address: String,
    remote_port: String,
    process: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkConnectionsResult {
    connections: Vec<NetworkConnection>,
    truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkRouteHop {
    hop: u16,
    address: Option<String>,
    latency_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkTraceResult {
    target: String,
    resolved_address: Option<String>,
    reached: bool,
    hops: Vec<NetworkRouteHop>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerProcess {
    id: String,
    pid: u32,
    parent_pid: u32,
    user: String,
    state: String,
    cpu_usage_percent: f64,
    memory_usage_percent: f64,
    resident_memory_bytes: u64,
    elapsed_seconds: u64,
    name: String,
    command: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerProcessListResult {
    processes: Vec<ServerProcess>,
    truncated: bool,
}

fn parse_number<T: std::str::FromStr>(value: Option<&str>, field: &str) -> Result<T, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("监控数据缺少 {field}"))?
        .parse::<T>()
        .map_err(|_| format!("监控数据 {field} 格式无效"))
}

fn parse_pair(value: Option<&str>, field: &str) -> Result<(u64, u64), String> {
    let mut parts = value.unwrap_or_default().split(',');
    let first = parse_number(parts.next(), field)?;
    let second = parse_number(parts.next(), field)?;
    Ok((first, second))
}

fn parse_load_average(value: Option<&str>) -> Result<[f64; 3], String> {
    let mut parts = value.unwrap_or_default().split(',');
    Ok([
        parse_number(parts.next(), "load_average")?,
        parse_number(parts.next(), "load_average")?,
        parse_number(parts.next(), "load_average")?,
    ])
}

fn percent(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (used as f64 * 100.0 / total as f64).clamp(0.0, 100.0)
    }
}

fn validate_ping_target(target: &str) -> Result<&str, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("请输入 Ping 目标".to_string());
    }
    if target.len() > 253
        || target.starts_with('-')
        || !target.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':')
        })
    {
        return Err("Ping 目标格式无效".to_string());
    }
    Ok(target)
}

fn parse_packet_count(value: &str) -> Option<u32> {
    value
        .split_whitespace()
        .find_map(|part| part.parse::<u32>().ok())
}

pub(crate) fn parse_ping_output(target: &str, output: &str) -> Result<NetworkPingResult, String> {
    let packet_line = output
        .lines()
        .find(|line| line.contains("packets transmitted") && line.contains("packet loss"))
        .ok_or_else(|| {
            let detail = output.lines().last().unwrap_or_default().trim();
            if detail.is_empty() {
                "Ping 未返回统计结果".to_string()
            } else {
                format!("Ping 执行失败：{detail}")
            }
        })?;
    let packet_parts = packet_line.split(',').collect::<Vec<_>>();
    let transmitted = packet_parts
        .first()
        .and_then(|value| parse_packet_count(value))
        .ok_or_else(|| "无法解析 Ping 发送数量".to_string())?;
    let received = packet_parts
        .get(1)
        .and_then(|value| parse_packet_count(value))
        .ok_or_else(|| "无法解析 Ping 接收数量".to_string())?;
    let packet_loss_percent = packet_parts
        .iter()
        .find(|value| value.contains("packet loss"))
        .and_then(|value| value.split('%').next())
        .and_then(|value| value.split_whitespace().last())
        .and_then(|value| value.parse::<f64>().ok())
        .ok_or_else(|| "无法解析 Ping 丢包率".to_string())?
        .clamp(0.0, 100.0);

    let latency_values = output
        .lines()
        .find(|line| line.contains("min/avg/max") && line.contains('='))
        .and_then(|line| line.split_once('='))
        .map(|(_, values)| {
            values
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .split('/')
                .filter_map(|value| value.parse::<f64>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(NetworkPingResult {
        target: target.to_string(),
        reachable: received > 0,
        transmitted,
        received,
        packet_loss_percent,
        minimum_latency_ms: latency_values.first().copied(),
        average_latency_ms: latency_values.get(1).copied(),
        maximum_latency_ms: latency_values.get(2).copied(),
    })
}

fn parse_network_endpoint(endpoint: &str) -> (String, String) {
    let Some((address, port)) = endpoint.rsplit_once(':') else {
        return (endpoint.to_string(), String::new());
    };
    (
        address
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(address)
            .to_string(),
        port.to_string(),
    )
}

fn parse_process_label(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let name = value.split('"').nth(1);
    let process_id = value
        .split("pid=")
        .nth(1)
        .and_then(|value| value.split([',', ')']).next());
    match (name, process_id) {
        (Some(name), Some(process_id)) => Some(format!("{name} (PID {process_id})")),
        (Some(name), None) => Some(name.to_string()),
        _ => Some(value.to_string()),
    }
}

pub(crate) fn parse_network_connections(output: &str) -> NetworkConnectionsResult {
    let mut truncated = false;
    let connections = output
        .lines()
        .filter_map(|line| {
            if line == "__FINESHELL_TRUNCATED__" {
                truncated = true;
                return None;
            }
            let mut fields = line.splitn(5, '\t');
            let protocol = fields.next()?.trim();
            let state = fields.next()?.trim();
            let local_endpoint = fields.next()?.trim();
            let remote_endpoint = fields.next()?.trim();
            let process = fields.next().unwrap_or_default().trim();
            if protocol.is_empty() || local_endpoint.is_empty() {
                return None;
            }
            let (local_address, local_port) = parse_network_endpoint(local_endpoint);
            let (remote_address, remote_port) = parse_network_endpoint(remote_endpoint);
            Some(NetworkConnection {
                id: String::new(),
                protocol: protocol.to_uppercase(),
                state: state.to_uppercase(),
                local_address,
                local_port,
                remote_address,
                remote_port,
                process: parse_process_label(process),
            })
        })
        .enumerate()
        .map(|(index, mut connection)| {
            connection.id = format!("network-connection-{index}");
            connection
        })
        .collect();

    NetworkConnectionsResult {
        connections,
        truncated,
    }
}

pub(crate) fn parse_trace_output(target: &str, output: &str) -> NetworkTraceResult {
    let resolved_address = output.lines().find_map(|line| {
        if !line.starts_with("traceroute to ") {
            return None;
        }
        let (_, after_opening) = line.split_once('(')?;
        let (address, _) = after_opening.split_once(')')?;
        (!address.is_empty()).then(|| address.to_string())
    });
    let mut hops = Vec::<NetworkRouteHop>::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let Some(hop) = fields
            .next()
            .map(|value| value.trim_end_matches(['?', ':']))
            .and_then(|value| value.parse::<u16>().ok())
        else {
            continue;
        };
        let Some(address) = fields.next() else {
            continue;
        };
        if address.starts_with('[') {
            continue;
        }
        let address = if address == "*" || address == "no" {
            None
        } else {
            Some(address.to_string())
        };
        let latency_ms = fields.find_map(|field| {
            field
                .strip_suffix("ms")
                .unwrap_or(field)
                .parse::<f64>()
                .ok()
        });
        let next_hop = NetworkRouteHop {
            hop,
            address,
            latency_ms,
        };
        if let Some(existing) = hops.iter_mut().find(|existing| existing.hop == hop) {
            if existing.address.is_none() && next_hop.address.is_some() {
                *existing = next_hop;
            }
        } else {
            hops.push(next_hop);
        }
    }
    let expected_address = resolved_address.as_deref().unwrap_or(target);
    let reached = hops
        .iter()
        .any(|hop| hop.address.as_deref() == Some(expected_address))
        || output.lines().any(|line| line.contains("reached"));

    NetworkTraceResult {
        target: target.to_string(),
        resolved_address,
        reached,
        hops,
    }
}

pub(crate) fn parse_process_list(output: &str) -> ServerProcessListResult {
    let mut truncated = false;
    let processes = output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line == "__FINESHELL_TRUNCATED__" {
                truncated = true;
                return None;
            }
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 9 {
                return None;
            }
            let pid = fields[0].parse::<u32>().ok()?;
            let parent_pid = fields[1].parse::<u32>().ok()?;
            let cpu_usage_percent = fields[4].parse::<f64>().ok()?.max(0.0);
            let memory_usage_percent = fields[5].parse::<f64>().ok()?.clamp(0.0, 100.0);
            let resident_memory_bytes = fields[6].parse::<u64>().ok()?.saturating_mul(1024);
            let elapsed_seconds = fields[7].parse::<u64>().ok()?;
            let name = fields[8].to_string();
            let command = if fields.len() > 9 {
                fields[9..].join(" ")
            } else {
                name.clone()
            };
            Some(ServerProcess {
                id: format!("process-{pid}"),
                pid,
                parent_pid,
                user: fields[2].to_string(),
                state: fields[3].to_string(),
                cpu_usage_percent,
                memory_usage_percent,
                resident_memory_bytes,
                elapsed_seconds,
                name,
                command,
            })
        })
        .collect();

    ServerProcessListResult {
        processes,
        truncated,
    }
}

pub(crate) fn parse_monitor_output(output: &str) -> Result<ServerMonitorSnapshot, String> {
    let values = output
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect::<std::collections::HashMap<_, _>>();
    let hostname = values
        .get("hostname")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "监控数据缺少 hostname".to_string())?;
    let operating_system = values
        .get("operating_system")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "监控数据缺少 operating_system".to_string())?;
    let kernel = values
        .get("kernel")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "监控数据缺少 kernel".to_string())?;
    let uptime_seconds = parse_number(values.get("uptime_seconds").copied(), "uptime_seconds")?;
    let cpu_usage_percent =
        parse_number::<f64>(values.get("cpu_percent").copied(), "cpu_percent")?.clamp(0.0, 100.0);
    let (memory_total_kib, memory_available_kib) =
        parse_pair(values.get("memory_kib").copied(), "memory_kib")?;
    let (disk_total_kib, disk_used_kib) = parse_pair(values.get("disk_kib").copied(), "disk_kib")?;
    let (network_receive_bytes, network_transmit_bytes) =
        parse_pair(values.get("network_bytes").copied(), "network_bytes")?;
    let memory_total_bytes = memory_total_kib.saturating_mul(1024);
    let memory_used_bytes = memory_total_kib
        .saturating_sub(memory_available_kib)
        .saturating_mul(1024);
    let disk_total_bytes = disk_total_kib.saturating_mul(1024);
    let disk_used_bytes = disk_used_kib.saturating_mul(1024);

    Ok(ServerMonitorSnapshot {
        hostname,
        operating_system,
        kernel,
        uptime_seconds,
        cpu_usage_percent,
        memory_total_bytes,
        memory_used_bytes,
        memory_usage_percent: percent(memory_used_bytes, memory_total_bytes),
        disk_total_bytes,
        disk_used_bytes,
        disk_usage_percent: percent(disk_used_bytes, disk_total_bytes),
        load_average: parse_load_average(values.get("load_average").copied())?,
        network_receive_bytes,
        network_transmit_bytes,
    })
}

fn execute_remote_command(
    session: &Session,
    command: &str,
    operation: &str,
) -> Result<(String, i32), String> {
    session.set_blocking(true);
    let result = (|| {
        let mut channel = session
            .channel_session()
            .map_err(|error| format!("无法创建{operation}通道：{error}"))?;
        channel
            .exec(command)
            .map_err(|error| format!("无法执行{operation}命令：{error}"))?;
        let mut output = String::new();
        channel
            .read_to_string(&mut output)
            .map_err(|error| format!("无法读取{operation}数据：{error}"))?;
        channel
            .wait_close()
            .map_err(|error| format!("{operation}通道关闭失败：{error}"))?;
        let exit_status = channel
            .exit_status()
            .map_err(|error| format!("无法读取{operation}命令状态：{error}"))?;
        Ok((output, exit_status))
    })();
    session.set_blocking(false);
    result
}

pub(crate) fn collect_server_snapshot(session: &Session) -> Result<ServerMonitorSnapshot, String> {
    let (output, exit_status) = execute_remote_command(session, MONITOR_COMMAND, "监控")?;
    if exit_status != 0 {
        return Err(format!("监控命令异常退出：{exit_status}"));
    }
    parse_monitor_output(&output)
}

pub(crate) fn collect_ping(session: &Session, target: &str) -> Result<NetworkPingResult, String> {
    let target = validate_ping_target(target)?;
    let command = format!(
        "LC_ALL=C\nif ! command -v ping >/dev/null 2>&1; then printf '__FINESHELL_PING_MISSING__\\n'; exit 127; fi\nping -n -c 3 -i 0.2 -W 1 {target} 2>&1"
    );
    let (output, exit_status) = execute_remote_command(session, &command, "Ping")?;
    if exit_status == 127 || output.contains("__FINESHELL_PING_MISSING__") {
        return Err("远程服务器未安装 ping 命令".to_string());
    }
    parse_ping_output(target, &output)
}

pub(crate) fn collect_network_connections(
    session: &Session,
) -> Result<NetworkConnectionsResult, String> {
    let (output, exit_status) =
        execute_remote_command(session, NETWORK_CONNECTIONS_COMMAND, "网络连接采集")?;
    if exit_status == 127 || output.contains("__FINESHELL_SS_MISSING__") {
        return Err("远程服务器未安装 ss 命令".to_string());
    }
    if exit_status != 0 {
        return Err(format!("网络连接采集命令异常退出：{exit_status}"));
    }
    Ok(parse_network_connections(&output))
}

pub(crate) fn collect_trace_route(
    session: &Session,
    target: &str,
) -> Result<NetworkTraceResult, String> {
    let target = validate_ping_target(target)?;
    let command = format!(
        "LC_ALL=C\nif command -v traceroute >/dev/null 2>&1; then traceroute -n -m 12 -q 1 -w 1 {target} 2>&1; elif command -v busybox >/dev/null 2>&1 && busybox traceroute --help >/dev/null 2>&1; then busybox traceroute -n -m 12 -q 1 -w 1 {target} 2>&1; elif command -v tracepath >/dev/null 2>&1; then tracepath -n -m 12 {target} 2>&1; else printf '__FINESHELL_TRACEROUTE_MISSING__\\n'; exit 127; fi"
    );
    let (output, exit_status) = execute_remote_command(session, &command, "路由追踪")?;
    if exit_status == 127 || output.contains("__FINESHELL_TRACEROUTE_MISSING__") {
        return Err("远程服务器未安装 traceroute 或 tracepath 命令".to_string());
    }
    let result = parse_trace_output(target, &output);
    if result.hops.is_empty() {
        let detail = output.lines().last().unwrap_or_default().trim();
        return Err(if detail.is_empty() {
            format!("路由追踪命令异常退出：{exit_status}")
        } else {
            format!("路由追踪失败：{detail}")
        });
    }
    Ok(result)
}

pub(crate) fn collect_processes(session: &Session) -> Result<ServerProcessListResult, String> {
    let (output, exit_status) = execute_remote_command(session, PROCESS_LIST_COMMAND, "进程采集")?;
    if let Some(error) = process_list_error(&output, exit_status) {
        return Err(error);
    }
    Ok(parse_process_list(&output))
}

fn process_list_error(output: &str, exit_status: i32) -> Option<String> {
    let has_marker = |marker: &str| output.lines().any(|line| line.trim() == marker);
    if has_marker("__FINESHELL_PS_MISSING__") {
        return Some("远程服务器未安装 ps 命令".to_string());
    }
    if has_marker("__FINESHELL_AWK_MISSING__") {
        return Some("远程服务器未安装 awk 命令，无法解析进程数据".to_string());
    }
    if has_marker("__FINESHELL_PS_UNSUPPORTED__") {
        return Some("远程服务器的 ps 命令不支持进程监控所需字段".to_string());
    }
    (exit_status != 0).then(|| format!("进程采集命令异常退出：{exit_status}"))
}

fn process_signal_command(pid: u32, force: bool) -> Result<String, String> {
    if pid <= 1 {
        return Err("不允许结束系统初始化进程".to_string());
    }
    let signal = if force { "KILL" } else { "TERM" };
    Ok(format!("LC_ALL=C\nkill -{signal} {pid} 2>&1"))
}

pub(crate) fn signal_process(session: &Session, pid: u32, force: bool) -> Result<(), String> {
    let command = process_signal_command(pid, force)?;
    let signal = if force { "KILL" } else { "TERM" };
    let (output, exit_status) = execute_remote_command(session, &command, "进程操作")?;
    if exit_status == 0 {
        return Ok(());
    }
    let detail = output.lines().last().unwrap_or_default().trim();
    Err(if detail.is_empty() {
        format!("向进程 {pid} 发送 {signal} 失败")
    } else {
        format!("向进程 {pid} 发送 {signal} 失败：{detail}")
    })
}

#[cfg(test)]
mod tests {
    use super::{
        parse_monitor_output, parse_network_connections, parse_ping_output, parse_process_list,
        parse_trace_output, process_list_error, process_signal_command, validate_ping_target,
        NetworkConnection, NetworkConnectionsResult, NetworkPingResult, NetworkRouteHop,
        NetworkTraceResult, ServerMonitorSnapshot, ServerProcess, ServerProcessListResult,
    };

    #[test]
    fn parses_linux_monitor_output() {
        let output = r#"hostname=fineshell-test
operating_system=Ubuntu 24.04.2 LTS
kernel=6.8.0-60-generic
uptime_seconds=86461
cpu_percent=37.50
memory_kib=8192000,3072000
disk_kib=104857600,52428800,52428800
load_average=0.42,0.35,0.30
network_bytes=15728640,6291456
"#;

        assert_eq!(
            parse_monitor_output(output).unwrap(),
            ServerMonitorSnapshot {
                hostname: "fineshell-test".to_string(),
                operating_system: "Ubuntu 24.04.2 LTS".to_string(),
                kernel: "6.8.0-60-generic".to_string(),
                uptime_seconds: 86_461,
                cpu_usage_percent: 37.5,
                memory_total_bytes: 8_388_608_000,
                memory_used_bytes: 5_242_880_000,
                memory_usage_percent: 62.5,
                disk_total_bytes: 107_374_182_400,
                disk_used_bytes: 53_687_091_200,
                disk_usage_percent: 50.0,
                load_average: [0.42, 0.35, 0.30],
                network_receive_bytes: 15_728_640,
                network_transmit_bytes: 6_291_456,
            }
        );
    }

    #[test]
    fn rejects_incomplete_monitor_output() {
        assert!(parse_monitor_output("hostname=test\n").is_err());
    }

    #[test]
    fn parses_ping_statistics() {
        let output = r#"PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=56 time=5.12 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 2 received, 33.3333% packet loss, time 402ms
rtt min/avg/max/mdev = 4.800/5.100/5.400/0.245 ms
"#;

        assert_eq!(
            parse_ping_output("1.1.1.1", output).unwrap(),
            NetworkPingResult {
                target: "1.1.1.1".to_string(),
                reachable: true,
                transmitted: 3,
                received: 2,
                packet_loss_percent: 33.3333,
                minimum_latency_ms: Some(4.8),
                average_latency_ms: Some(5.1),
                maximum_latency_ms: Some(5.4),
            }
        );
    }

    #[test]
    fn parses_unreachable_ping_result() {
        let output = r#"PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.

--- 192.0.2.1 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 410ms
"#;
        let result = parse_ping_output("192.0.2.1", output).unwrap();

        assert!(!result.reachable);
        assert_eq!(result.packet_loss_percent, 100.0);
        assert_eq!(result.average_latency_ms, None);
    }

    #[test]
    fn rejects_unsafe_ping_targets() {
        assert!(validate_ping_target("example.com").is_ok());
        assert!(validate_ping_target("2001:db8::1").is_ok());
        assert!(validate_ping_target("-c 100").is_err());
        assert!(validate_ping_target("example.com; reboot").is_err());
    }

    #[test]
    fn parses_network_connections_and_ipv6_endpoints() {
        let output = concat!(
            "tcp\tLISTEN\t0.0.0.0:22\t0.0.0.0:*\tusers:((\"sshd\",pid=801,fd=3))\n",
            "tcp\tESTAB\t[2001:db8::1]:22\t[2001:db8::2]:51820\tusers:((\"sshd\",pid=901,fd=4))\n",
            "udp\tUNCONN\t*:5353\t*:*\t\n",
            "__FINESHELL_TRUNCATED__\n",
        );

        assert_eq!(
            parse_network_connections(output),
            NetworkConnectionsResult {
                connections: vec![
                    NetworkConnection {
                        id: "network-connection-0".to_string(),
                        protocol: "TCP".to_string(),
                        state: "LISTEN".to_string(),
                        local_address: "0.0.0.0".to_string(),
                        local_port: "22".to_string(),
                        remote_address: "0.0.0.0".to_string(),
                        remote_port: "*".to_string(),
                        process: Some("sshd (PID 801)".to_string()),
                    },
                    NetworkConnection {
                        id: "network-connection-1".to_string(),
                        protocol: "TCP".to_string(),
                        state: "ESTAB".to_string(),
                        local_address: "2001:db8::1".to_string(),
                        local_port: "22".to_string(),
                        remote_address: "2001:db8::2".to_string(),
                        remote_port: "51820".to_string(),
                        process: Some("sshd (PID 901)".to_string()),
                    },
                    NetworkConnection {
                        id: "network-connection-2".to_string(),
                        protocol: "UDP".to_string(),
                        state: "UNCONN".to_string(),
                        local_address: "*".to_string(),
                        local_port: "5353".to_string(),
                        remote_address: "*".to_string(),
                        remote_port: "*".to_string(),
                        process: None,
                    },
                ],
                truncated: true,
            }
        );
    }

    #[test]
    fn parses_trace_route_hops_and_timeouts() {
        let output = r#"traceroute to example.com (93.184.216.34), 12 hops max, 60 byte packets
 1  192.168.1.1  0.421 ms
 2  *
 3  203.0.113.10  5.382 ms
 4  93.184.216.34  12.641 ms
"#;

        assert_eq!(
            parse_trace_output("example.com", output),
            NetworkTraceResult {
                target: "example.com".to_string(),
                resolved_address: Some("93.184.216.34".to_string()),
                reached: true,
                hops: vec![
                    NetworkRouteHop {
                        hop: 1,
                        address: Some("192.168.1.1".to_string()),
                        latency_ms: Some(0.421),
                    },
                    NetworkRouteHop {
                        hop: 2,
                        address: None,
                        latency_ms: None,
                    },
                    NetworkRouteHop {
                        hop: 3,
                        address: Some("203.0.113.10".to_string()),
                        latency_ms: Some(5.382),
                    },
                    NetworkRouteHop {
                        hop: 4,
                        address: Some("93.184.216.34".to_string()),
                        latency_ms: Some(12.641),
                    },
                ],
            }
        );
    }

    #[test]
    fn parses_tracepath_output_and_deduplicates_hops() {
        let output = r#" 1?: [LOCALHOST]                      pmtu 1500
 1:  192.168.1.1                                          0.224ms
 1:  192.168.1.1                                          0.181ms asymm 2
 2:  no reply
 3:  1.1.1.1                                              8.412ms reached
     Resume: pmtu 1500 hops 3 back 3
"#;
        let result = parse_trace_output("1.1.1.1", output);

        assert!(result.reached);
        assert_eq!(result.hops.len(), 3);
        assert_eq!(result.hops[0].address.as_deref(), Some("192.168.1.1"));
        assert_eq!(result.hops[0].latency_ms, Some(0.224));
        assert_eq!(result.hops[1].address, None);
        assert_eq!(result.hops[2].latency_ms, Some(8.412));
    }

    #[test]
    fn parses_process_list_and_preserves_command_arguments() {
        let output = concat!(
            "  812     1 root     Ssl  125.4 12.5 262144 86400 node node /opt/app/server.js --port 8080\n",
            "  901   812 deploy   S      0.2  1.5  32768   125 worker worker --queue critical jobs\n",
            "not a valid process line\n",
            "__FINESHELL_TRUNCATED__\n",
        );

        assert_eq!(
            parse_process_list(output),
            ServerProcessListResult {
                processes: vec![
                    ServerProcess {
                        id: "process-812".to_string(),
                        pid: 812,
                        parent_pid: 1,
                        user: "root".to_string(),
                        state: "Ssl".to_string(),
                        cpu_usage_percent: 125.4,
                        memory_usage_percent: 12.5,
                        resident_memory_bytes: 268_435_456,
                        elapsed_seconds: 86_400,
                        name: "node".to_string(),
                        command: "node /opt/app/server.js --port 8080".to_string(),
                    },
                    ServerProcess {
                        id: "process-901".to_string(),
                        pid: 901,
                        parent_pid: 812,
                        user: "deploy".to_string(),
                        state: "S".to_string(),
                        cpu_usage_percent: 0.2,
                        memory_usage_percent: 1.5,
                        resident_memory_bytes: 33_554_432,
                        elapsed_seconds: 125,
                        name: "worker".to_string(),
                        command: "worker --queue critical jobs".to_string(),
                    },
                ],
                truncated: true,
            }
        );
    }

    #[test]
    fn identifies_process_command_failures_without_treating_every_127_as_missing_ps() {
        assert_eq!(
            process_list_error("__FINESHELL_PS_MISSING__\n", 127),
            Some("远程服务器未安装 ps 命令".to_string())
        );
        assert_eq!(
            process_list_error("__FINESHELL_AWK_MISSING__\n", 127),
            Some("远程服务器未安装 awk 命令，无法解析进程数据".to_string())
        );
        assert_eq!(
            process_list_error("", 127),
            Some("进程采集命令异常退出：127".to_string())
        );
        assert_eq!(
            process_list_error(
                "123 1 root S 0.0 0.0 1024 1 bash bash -c printf '__FINESHELL_PS_MISSING__'\n",
                0,
            ),
            None
        );
        assert_eq!(process_list_error("", 0), None);
    }

    #[test]
    fn builds_only_supported_process_signal_commands() {
        assert_eq!(
            process_signal_command(812, false).unwrap(),
            "LC_ALL=C\nkill -TERM 812 2>&1"
        );
        assert_eq!(
            process_signal_command(812, true).unwrap(),
            "LC_ALL=C\nkill -KILL 812 2>&1"
        );
        assert!(process_signal_command(1, false).is_err());
        assert!(process_signal_command(0, true).is_err());
    }
}
