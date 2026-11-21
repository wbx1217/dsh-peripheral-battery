//! 侧车命令行：把库层的读数与 HID 原语暴露成 JSON，供 DSH 插件调用。
//!
//! 子命令（全部输出 JSON，成功 `ok:true`、失败 `ok:false`）：
//!
//! ```text
//! peripheral-battery-cli probe list [--vid HEX] [--pid HEX] [--usage-page HEX]
//! peripheral-battery-cli probe listen --vid HEX --pid HEX [--usage-page HEX] [--secs N] [--writable]
//! peripheral-battery-cli probe exchange --vid HEX --pid HEX [--usage-page HEX] [--usage HEX]
//!        --hex "AA BB" [--mode write|setout|setfeat|getfeat] [--wait MS] [--reads N]
//! peripheral-battery-cli --version
//! ```
//!
//! 电量查询已经全部走 `peripheral-battery-daemon`；CLI 只保留 HID 枚举/监听/
//! 收发原语，供 `battery_probe` 与适配器开发调试使用。

use std::process::ExitCode;
use std::time::{Duration, Instant};

use peripheral_battery::hid::session::hex;
use peripheral_battery::hid::{self, HidDevice, HidSession};
use peripheral_battery::util::json_escape;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            println!("{}", error_json(&message));
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("probe") => probe(&args[1..]),
        Some("--version") => {
            println!(
                "{{\"ok\":true,\"sidecarVersion\":\"{}\"}}",
                env!("CARGO_PKG_VERSION")
            );
            Ok(())
        }
        Some(other) => Err(format!("未知子命令 `{other}`")),
        None => {
            Err("用法：peripheral-battery-cli probe list|listen|exchange | --version".to_owned())
        }
    }
}

fn probe(args: &[String]) -> Result<(), String> {
    match args.first().map(String::as_str) {
        Some("list") => probe_list(&args[1..]),
        Some("listen") => probe_listen(&args[1..]),
        Some("exchange") => probe_exchange(&args[1..]),
        Some(other) => Err(format!("未知 probe 子命令 `{other}`")),
        None => Err("probe 需要 list / listen / exchange".to_owned()),
    }
}

fn probe_list(args: &[String]) -> Result<(), String> {
    let vid = parse_opt_hex(args, "--vid")?;
    let pid = parse_opt_hex(args, "--pid")?;
    let usage_page = parse_opt_hex(args, "--usage-page")?;
    let devices = hid::enumerate().map_err(|error| error.to_string())?;
    let rows: Vec<String> = devices
        .iter()
        .filter(|device| {
            vid.is_none_or(|want| device.vendor_id == want)
                && pid.is_none_or(|want| device.product_id == want)
                && usage_page.is_none_or(|want| device.usage_page == want)
        })
        .map(|device| probe_device_json(device, false))
        .collect();
    println!(
        "{{\"ok\":true,\"schema\":\"dsh-peripheral-battery/probe@1\",\"devices\":[{}]}}",
        rows.join(",")
    );
    Ok(())
}

fn probe_device_json(device: &HidDevice, supported: bool) -> String {
    format!(
        "{{\"vid\":\"{:04X}\",\"pid\":\"{:04X}\",\"version\":\"{:04X}\",\
         \"usagePage\":\"{:04X}\",\"usage\":\"{:04X}\",\
         \"inputLen\":{},\"outputLen\":{},\"featureLen\":{},\
         \"product\":\"{}\",\"manufacturer\":\"{}\",\"path\":\"{}\",\
         \"vendorPage\":{},\"supported\":{}}}",
        device.vendor_id,
        device.product_id,
        device.version,
        device.usage_page,
        device.usage,
        device.input_len,
        device.output_len,
        device.feature_len,
        json_escape(&device.product),
        json_escape(&device.manufacturer),
        json_escape(&device.path),
        device.is_vendor_page(),
        supported
    )
}

/// 只读监听：在时限内把匹配集合的上报文全部抓回来，用于逆向协议。
fn probe_listen(args: &[String]) -> Result<(), String> {
    let vid = parse_required_hex(args, "--vid")?;
    let pid = parse_required_hex(args, "--pid")?;
    let usage_page = parse_opt_hex(args, "--usage-page")?;
    let secs = parse_u64(args, "--secs").unwrap_or(8).min(120);
    let writable = args.iter().any(|arg| arg == "--writable");

    let devices = hid::enumerate().map_err(|error| error.to_string())?;
    let matched: Vec<HidDevice> = devices
        .into_iter()
        .filter(|device| {
            device.vendor_id == vid
                && device.product_id == pid
                && usage_page.is_none_or(|want| device.usage_page == want)
        })
        .collect();
    if matched.is_empty() {
        return Err(format!("没有匹配 {vid:04X}:{pid:04X} 的 HID 集合"));
    }

    let mut opened: Vec<(HidDevice, HidSession)> = Vec::new();
    let mut opened_json: Vec<String> = Vec::new();
    for device in matched {
        match HidSession::open(&device.path, writable) {
            Ok(session) => {
                let session = session.with_report_lengths(
                    device.input_len,
                    device.output_len,
                    device.feature_len,
                );
                opened_json.push(format!(
                    "{{\"usagePage\":\"{:04X}\",\"usage\":\"{:04X}\",\"inLen\":{},\"outLen\":{},\"fea\":{},\"opened\":true}}",
                    device.usage_page, device.usage, device.input_len, device.output_len, device.feature_len
                ));
                opened.push((device, session));
            }
            Err(error) => opened_json.push(format!(
                "{{\"usagePage\":\"{:04X}\",\"usage\":\"{:04X}\",\"inLen\":{},\"outLen\":{},\"fea\":{},\"opened\":false,\"error\":\"{}\"}}",
                device.usage_page,
                device.usage,
                device.input_len,
                device.output_len,
                device.feature_len,
                json_escape(&error.to_string())
            )),
        }
    }
    if opened.is_empty() {
        return Err("所有匹配的集合都打不开".to_owned());
    }

    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut reports: Vec<String> = Vec::new();
    while Instant::now() < deadline && reports.len() < 2000 {
        let mut got_any = false;
        for (device, session) in &opened {
            match session.read(80) {
                Ok(Some(report)) => {
                    got_any = true;
                    reports.push(format!(
                        "{{\"inLen\":{},\"vid\":\"{:04X}\",\"pid\":\"{:04X}\",\
                         \"usagePage\":\"{:04X}\",\"len\":{},\"hex\":\"{}\"}}",
                        device.input_len,
                        device.vendor_id,
                        device.product_id,
                        device.usage_page,
                        report.len(),
                        json_escape(&hex(&report))
                    ));
                }
                Ok(None) => {}
                Err(_) => {}
            }
        }
        if !got_any {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    println!(
        "{{\"ok\":true,\"schema\":\"dsh-peripheral-battery/listen@1\",\
         \"windowMs\":{},\"collections\":[{}],\"reports\":[{}]}}",
        secs * 1000,
        opened_json.join(","),
        reports.join(",")
    );
    Ok(())
}

/// 打开一台设备、发一帧、把时限内收到的报文全部读回来。
fn probe_exchange(args: &[String]) -> Result<(), String> {
    let vid = parse_required_hex(args, "--vid")?;
    let pid = parse_required_hex(args, "--pid")?;
    let usage_page = parse_opt_hex(args, "--usage-page")?;
    let usage = parse_opt_hex(args, "--usage")?;
    let in_len = parse_u64(args, "--in-len");
    let out_len = parse_u64(args, "--out-len");
    let frame = parse_hex(&required_value(args, "--hex")?)?;
    let mode = arg_value(args, "--mode").unwrap_or_else(|| "setout".to_owned());
    let wait = parse_u64(args, "--wait").unwrap_or(600).min(10_000);
    let reads = parse_u64(args, "--reads").unwrap_or(0) as usize;

    let devices = hid::enumerate().map_err(|error| error.to_string())?;
    let Some(device) = devices.iter().find(|device| {
        device.vendor_id == vid
            && device.product_id == pid
            && usage_page.is_none_or(|want| device.usage_page == want)
            && usage.is_none_or(|want| device.usage == want)
            && in_len.is_none_or(|want| u64::from(device.input_len) == want)
            && out_len.is_none_or(|want| u64::from(device.output_len) == want)
    }) else {
        return Err(format!("没有匹配 {vid:04X}:{pid:04X} 的 HID 集合"));
    };

    let session = HidSession::open(&device.path, true)
        .map_err(|error| error.to_string())?
        .with_report_lengths(device.input_len, device.output_len, device.feature_len);
    session.flush(30);

    let padded = pad_to(&frame, session.output_len())?;
    let sent = hex(&padded);
    let mut reports: Vec<String> = Vec::new();

    let outcome: Result<(), String> = match mode.as_str() {
        "write" => session
            .write(&padded, wait as u32)
            .map_err(|error| error.to_string()),
        "setfeat" => {
            let buffer = pad_to(&frame, session.feature_len().max(frame.len()))?;
            session
                .set_feature(&buffer)
                .map_err(|error| error.to_string())
        }
        "getfeat" => {
            let mut buffer = pad_to(&frame, session.feature_len().max(frame.len()))?;
            match session.get_feature(&mut buffer) {
                Ok(()) => {
                    reports.push(hex(&buffer));
                    Ok(())
                }
                Err(error) => Err(error.to_string()),
            }
        }
        _ => session
            .set_output_report(&padded)
            .map_err(|error| error.to_string()),
    };
    outcome?;

    if mode != "getfeat" {
        let deadline = Instant::now() + Duration::from_millis(wait);
        loop {
            if reads > 0 && reports.len() >= reads {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            match session.read(120) {
                Ok(Some(report)) => reports.push(hex(&report)),
                Ok(None) => break,
                Err(error) => return Err(error.to_string()),
            }
        }
    }

    println!(
        "{{\"ok\":true,\"device\":{{\"vid\":\"{:04X}\",\"pid\":\"{:04X}\",\
         \"usagePage\":\"{:04X}\",\"usage\":\"{:04X}\"}},\
         \"mode\":\"{}\",\"sent\":\"{}\",\"reports\":[{}]}}",
        device.vendor_id,
        device.product_id,
        device.usage_page,
        device.usage,
        json_escape(&mode),
        sent,
        reports
            .iter()
            .map(|report| format!("\"{}\"", json_escape(report)))
            .collect::<Vec<_>>()
            .join(",")
    );
    Ok(())
}

/// 把报文补零到设备声明的长度：Windows HID 多数接口要求长度严格匹配。
/// 报文比集合声明还长时报错——静默截断会把一次协议错误伪装成「设备没应答」。
fn pad_to(frame: &[u8], len: usize) -> Result<Vec<u8>, String> {
    let len = len.max(1);
    if frame.len() > len {
        return Err(format!(
            "报文 {} 字节超过集合声明的 {} 字节",
            frame.len(),
            len
        ));
    }
    let mut out = vec![0u8; len];
    out[..frame.len()].copy_from_slice(frame);
    Ok(out)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).cloned()
}

fn required_value(args: &[String], name: &str) -> Result<String, String> {
    arg_value(args, name).ok_or_else(|| format!("缺少 {name}"))
}

fn parse_u64(args: &[String], name: &str) -> Option<u64> {
    arg_value(args, name).and_then(|raw| raw.parse::<u64>().ok())
}

fn parse_opt_hex(args: &[String], name: &str) -> Result<Option<u16>, String> {
    let Some(raw) = arg_value(args, name) else {
        return Ok(None);
    };
    parse_hex_u16(&raw)
        .map(Some)
        .map_err(|_| format!("{name} 需要十六进制数值，收到 `{raw}`"))
}

fn parse_required_hex(args: &[String], name: &str) -> Result<u16, String> {
    let raw = required_value(args, name)?;
    parse_hex_u16(&raw).map_err(|_| format!("{name} 需要十六进制数值，收到 `{raw}`"))
}

fn parse_hex_u16(raw: &str) -> Result<u16, ()> {
    let cleaned = raw.trim().trim_start_matches("0x").trim_start_matches("0X");
    u16::from_str_radix(cleaned, 16).map_err(|_| ())
}

fn parse_hex(raw: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for token in raw.split_whitespace() {
        let cleaned = token.trim_start_matches("0x").trim_start_matches("0X");
        let byte = u8::from_str_radix(cleaned, 16).map_err(|_| format!("非法字节 `{token}`"))?;
        out.push(byte);
    }
    if out.is_empty() {
        return Err("--hex 为空".to_owned());
    }
    Ok(out)
}

fn error_json(message: &str) -> String {
    format!(
        "{{\"ok\":false,\"error\":{{\"message\":\"{}\"}}}}",
        json_escape(message)
    )
}
