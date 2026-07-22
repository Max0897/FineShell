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

pub(crate) fn collect_server_snapshot(session: &Session) -> Result<ServerMonitorSnapshot, String> {
    session.set_blocking(true);
    let result = (|| {
        let mut channel = session
            .channel_session()
            .map_err(|error| format!("无法创建监控通道：{error}"))?;
        channel
            .exec(MONITOR_COMMAND)
            .map_err(|error| format!("无法执行监控命令：{error}"))?;
        let mut output = String::new();
        channel
            .read_to_string(&mut output)
            .map_err(|error| format!("无法读取监控数据：{error}"))?;
        channel
            .wait_close()
            .map_err(|error| format!("监控通道关闭失败：{error}"))?;
        let exit_status = channel
            .exit_status()
            .map_err(|error| format!("无法读取监控命令状态：{error}"))?;
        if exit_status != 0 {
            return Err(format!("监控命令异常退出：{exit_status}"));
        }
        parse_monitor_output(&output)
    })();
    session.set_blocking(false);
    result
}

#[cfg(test)]
mod tests {
    use super::{parse_monitor_output, ServerMonitorSnapshot};

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
}
