//! 常驻 sidecar：JSON-lines RPC，给 DSH 插件做 HID 会话与系统数据源。
//!
//! 协议：每行一个 JSON 请求，响应也是每行一个 JSON。
//! 请求：`{"id":1,"cmd":"open","vid":"373B","pid":"1115","usagePage":"FF02"}`
//! 响应：`{"id":1,"ok":true,"result":{...}}` 或 `{"id":1,"ok":false,"error":{...}}`
//!
//! 命令：ping / list / xinput / genericBattery / open / read / write / getFeature / close / listen / sessions / shutdown
//!
//! 空闲 `--idle-seconds`（默认 900）没有请求时退出；宿主负责按需拉起。

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::ExitCode;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DBT_DEVICEARRIVAL, DBT_DEVICEREMOVECOMPLETE, DBT_DEVNODES_CHANGED,
    DBT_DEVTYP_DEVICEINTERFACE, DEV_BROADCAST_DEVICEINTERFACE_W, DEVICE_NOTIFY_WINDOW_HANDLE,
    DefWindowProcW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, RegisterClassW,
    RegisterDeviceNotificationW, TranslateMessage, WM_DEVICECHANGE, WNDCLASSW,
};

use peripheral_battery::ble;
use peripheral_battery::generic;
use peripheral_battery::hid::session::hex;
use peripheral_battery::hid::{self, HidDevice, HidSession};
use peripheral_battery::phonelink;
use peripheral_battery::util::now_ms;
use peripheral_battery::xinput;
use windows_sys::Win32::Devices::HumanInterfaceDevice::GUID_DEVINTERFACE_HID;

struct Session {
    device: HidDevice,
    hid: HidSession,
}

/// 所有 stdout JSON 行走同一把锁：主线程应答与设备事件不会互相插行。
static OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn write_line(value: &Value) {
    let lock = OUTPUT_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    println!("{value}");
    let _ = std::io::stdout().flush();
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!(
            "{}",
            json!({"ok": true, "daemonVersion": env!("CARGO_PKG_VERSION")})
        );
        return ExitCode::SUCCESS;
    }

    let idle_seconds = arg_u64(&args, "--idle-seconds").unwrap_or(900).max(5);
    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in BufReader::new(stdin.lock()).lines() {
            match line {
                Ok(text) => {
                    if sender.send(text).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    spawn_device_watcher();

    let mut sessions: HashMap<u64, Session> = HashMap::new();
    let mut next_session = 1u64;
    let idle = Duration::from_secs(idle_seconds);

    loop {
        match receiver.recv_timeout(idle) {
            Ok(line) => {
                if line.trim().is_empty() {
                    continue;
                }
                // 每次请求都刷新空闲计时；下一轮 recv_timeout 从此刻重新计。
                let (response, shutdown) = handle(&line, &mut sessions, &mut next_session);
                write_line(&response);
                if shutdown {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    ExitCode::SUCCESS
}

fn handle(
    line: &str,
    sessions: &mut HashMap<u64, Session>,
    next_session: &mut u64,
) -> (Value, bool) {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return (
                json!({
                    "id": null,
                    "ok": false,
                    "error": {"code": "bad_json", "message": error.to_string()}
                }),
                false,
            );
        }
    };

    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let cmd = request.get("cmd").and_then(Value::as_str).unwrap_or("");

    if cmd == "shutdown" {
        return (
            json!({"id": id, "ok": true, "result": {"shutdown": true}}),
            true,
        );
    }

    match dispatch(cmd, &request, sessions, next_session) {
        Ok(result) => (json!({"id": id, "ok": true, "result": result}), false),
        Err((code, message)) => (
            json!({"id": id, "ok": false, "error": {"code": code, "message": message}}),
            false,
        ),
    }
}

fn dispatch(
    cmd: &str,
    request: &Value,
    sessions: &mut HashMap<u64, Session>,
    next_session: &mut u64,
) -> Result<Value, (String, String)> {
    match cmd {
        "ping" => Ok(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "pid": std::process::id(),
            "now": now_ms()
        })),
        "list" => Ok(json!({"devices": enumerate_devices()?})),
        "xinput" => {
            let devices = xinput_values();
            Ok(json!({"devices": devices, "count": devices.len()}))
        }
        "genericBattery" => {
            let (devices, diagnostics) = generic_values();
            Ok(json!({"devices": devices, "diagnostics": diagnostics}))
        }
        "phonelink" => {
            let (reading, diagnostics) = phonelink::scan_with_diagnostics();
            Ok(json!({
                "devices": reading.map(|value| vec![json!({
                    "key": "phonelink",
                    "name": value.name,
                    "kind": "phone",
                    "transport": "Phone Link",
                    "status": if value.stale { "asleep" } else { "online" },
                    "percent": value.percent,
                    "charging": value.charging,
                    "source": "phonelink"
                })]).unwrap_or_default(),
                "diagnostics": {
                    "fileFound": diagnostics.file_found,
                    "ageSecs": diagnostics.age_secs,
                    "error": diagnostics.error
                }
            }))
        }
        "ble" => {
            let (devices, diagnostics) = ble_values();
            Ok(json!({"devices": devices, "diagnostics": diagnostics}))
        }
        "open" => open(request, sessions, next_session),
        "read" => read_session(request, sessions),
        "write" => write_session(request, sessions),
        "getFeature" => get_feature(request, sessions),
        "close" => close_session(request, sessions),
        "flush" => flush_session(request, sessions),
        "listen" => listen(request),
        "sessions" => Ok(json!({"count": sessions.len()})),
        other => Err(("unknown_command".to_owned(), format!("未知命令 `{other}`"))),
    }
}

fn enumerate_devices() -> Result<Vec<Value>, (String, String)> {
    let devices = hid::enumerate().map_err(|error| ("hid".to_owned(), error.to_string()))?;
    Ok(devices.iter().map(device_value).collect())
}

fn device_value(device: &HidDevice) -> Value {
    json!({
        "path": device.path,
        "vid": format!("{:04X}", device.vendor_id),
        "pid": format!("{:04X}", device.product_id),
        "version": format!("{:04X}", device.version),
        "usagePage": format!("{:04X}", device.usage_page),
        "usage": format!("{:04X}", device.usage),
        "inputLen": device.input_len,
        "outputLen": device.output_len,
        "featureLen": device.feature_len,
        "product": device.product,
        "manufacturer": device.manufacturer,
        "vendorPage": device.is_vendor_page(),
    })
}

fn xinput_values() -> Vec<Value> {
    xinput::devices_json()
        .iter()
        .filter_map(|text| serde_json::from_str::<Value>(text).ok())
        .collect()
}

fn generic_values() -> (Vec<Value>, Value) {
    let devices = match hid::enumerate() {
        Ok(devices) => devices,
        Err(error) => {
            return (
                Vec::new(),
                json!({"enumerated": 0, "matched": 0, "error": error.to_string()}),
            );
        }
    };
    let enumerated = devices.len();
    let mut seen = HashSet::new();
    let mut values = Vec::new();
    for device in &devices {
        let pair = (device.vendor_id, device.product_id);
        if !seen.insert(pair) {
            continue;
        }
        let Some(reading) = generic::read(device) else {
            continue;
        };
        values.push(json!({
            "key": format!("hid:{:04X}:{:04X}", device.vendor_id, device.product_id),
            "name": reading.name,
            "kind": "other",
            "transport": "HID · Battery",
            "status": "online",
            "percent": reading.percent,
            "charging": null,
            "source": "generic",
            "vid": format!("{:04X}", device.vendor_id),
            "pid": format!("{:04X}", device.product_id)
        }));
    }
    let matched = values.len();
    (
        values,
        json!({"enumerated": enumerated, "matched": matched, "error": null}),
    )
}

fn ble_values() -> (Vec<Value>, Value) {
    let scan = ble::scan_with_diagnostics();
    let devices = scan
        .devices
        .iter()
        .map(|device| {
            json!({
                "id": device.id,
                "name": device.name,
                "source": device.source,
                "percent": device.percent,
                "charging": device.charging,
                "detail": device.detail,
                "components": device.components.iter().map(|component| json!({
                    "label": component.label,
                    "percent": component.percent,
                    "charging": component.charging
                })).collect::<Vec<_>>(),
                "connected": device.connected
            })
        })
        .collect();
    let diagnostics = json!({
        "gatt": scan.diagnostics.gatt,
        "windows": scan.diagnostics.windows,
        "fastpair": scan.diagnostics.fastpair,
        "fastpairAdvertisements": scan.diagnostics.fastpair_advertisements,
        "fastpairError": scan.diagnostics.fastpair_error
    });
    (devices, diagnostics)
}

fn open(
    request: &Value,
    sessions: &mut HashMap<u64, Session>,
    next_session: &mut u64,
) -> Result<Value, (String, String)> {
    let path = request.get("path").and_then(Value::as_str);
    let vid = request_hex_u16(request, "vid");
    let pid = request_hex_u16(request, "pid");
    let usage_page = request_hex_u16(request, "usagePage");
    let usage = request_hex_u16(request, "usage");
    let in_len = request
        .get("inLen")
        .and_then(Value::as_u64)
        .map(|v| v as u16);
    let out_len = request
        .get("outLen")
        .and_then(Value::as_u64)
        .map(|v| v as u16);
    let feature_len = request
        .get("featureLen")
        .and_then(Value::as_u64)
        .map(|v| v as u16);
    let writable = request
        .get("writable")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    if path.is_none() && vid.is_none() && pid.is_none() {
        return Err((
            "bad_request".to_owned(),
            "open 需要 path 或 vid/pid".to_owned(),
        ));
    }

    let devices = hid::enumerate().map_err(|error| ("hid".to_owned(), error.to_string()))?;
    let device = devices
        .into_iter()
        .find(|device| {
            path.is_none_or(|want| device.path == want)
                && vid.is_none_or(|want| device.vendor_id == want)
                && pid.is_none_or(|want| device.product_id == want)
                && usage_page.is_none_or(|want| device.usage_page == want)
                && usage.is_none_or(|want| device.usage == want)
                && in_len.is_none_or(|want| device.input_len == want)
                && out_len.is_none_or(|want| device.output_len == want)
                && feature_len.is_none_or(|want| device.feature_len == want)
        })
        .ok_or_else(|| ("not_found".to_owned(), "没有匹配的 HID 集合".to_owned()))?;

    let hid = HidSession::open(&device.path, writable)
        .map_err(|error| ("hid".to_owned(), error.to_string()))?
        .with_report_lengths(device.input_len, device.output_len, device.feature_len);

    let id = *next_session;
    *next_session += 1;
    let response_device = device_value(&device);
    sessions.insert(id, Session { device, hid });
    Ok(json!({"session": id, "device": response_device}))
}

fn read_session(
    request: &Value,
    sessions: &HashMap<u64, Session>,
) -> Result<Value, (String, String)> {
    let id = session_id(request)?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| ("not_found".to_owned(), format!("session {id} 不存在")))?;
    let timeout = request
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(300) as u32;
    match session.hid.read(timeout) {
        Ok(Some(report)) => Ok(json!({"report": hex(&report), "len": report.len()})),
        Ok(None) => Ok(json!({"report": null, "len": 0})),
        Err(error) => Err(("hid".to_owned(), error.to_string())),
    }
}

fn write_session(
    request: &Value,
    sessions: &HashMap<u64, Session>,
) -> Result<Value, (String, String)> {
    let id = session_id(request)?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| ("not_found".to_owned(), format!("session {id} 不存在")))?;
    let frame = parse_hex_frame(request.get("hex").and_then(Value::as_str))?;
    let mode = request
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("write");
    let timeout = request
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(400) as u32;

    match mode {
        "write" | "setOut" => {
            let padded = pad_to(&frame, usize::from(session.device.output_len), "输出报文")?;
            let result = if mode == "write" {
                session.hid.write(&padded, timeout)
            } else {
                session.hid.set_output_report(&padded)
            };
            result.map_err(|error| ("hid".to_owned(), error.to_string()))?;
            Ok(json!({"sent": hex(&padded), "len": padded.len()}))
        }
        "setFeature" => {
            let padded = pad_to(
                &frame,
                usize::from(session.device.feature_len),
                "Feature 报文",
            )?;
            session
                .hid
                .set_feature(&padded)
                .map_err(|error| ("hid".to_owned(), error.to_string()))?;
            Ok(json!({"sent": hex(&padded), "len": padded.len()}))
        }
        other => Err((
            "bad_request".to_owned(),
            format!("write 不支持 mode `{other}`，用 getFeature 读 Feature"),
        )),
    }
}

fn get_feature(
    request: &Value,
    sessions: &HashMap<u64, Session>,
) -> Result<Value, (String, String)> {
    let id = session_id(request)?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| ("not_found".to_owned(), format!("session {id} 不存在")))?;
    let frame = parse_hex_frame(request.get("hex").and_then(Value::as_str))?;
    let mut buffer = pad_to(
        &frame,
        usize::from(session.device.feature_len),
        "Feature 报文",
    )?;
    session
        .hid
        .get_feature(&mut buffer)
        .map_err(|error| ("hid".to_owned(), error.to_string()))?;
    Ok(json!({"report": hex(&buffer), "len": buffer.len()}))
}

fn close_session(
    request: &Value,
    sessions: &mut HashMap<u64, Session>,
) -> Result<Value, (String, String)> {
    let id = session_id(request)?;
    let removed = sessions.remove(&id).is_some();
    Ok(json!({"closed": removed}))
}

fn flush_session(
    request: &Value,
    sessions: &HashMap<u64, Session>,
) -> Result<Value, (String, String)> {
    let id = session_id(request)?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| ("not_found".to_owned(), format!("session {id} 不存在")))?;
    let idle = request.get("idleMs").and_then(Value::as_u64).unwrap_or(20) as u32;
    session.hid.flush(idle);
    Ok(json!({"flushed": true}))
}

fn listen(request: &Value) -> Result<Value, (String, String)> {
    let vid = request_hex_u16(request, "vid");
    let pid = request_hex_u16(request, "pid");
    let usage_page = request_hex_u16(request, "usagePage");
    let seconds = request
        .get("seconds")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, 30);

    let devices = hid::enumerate().map_err(|error| ("hid".to_owned(), error.to_string()))?;
    let matched: Vec<HidDevice> = devices
        .into_iter()
        .filter(|device| {
            vid.is_none_or(|want| device.vendor_id == want)
                && pid.is_none_or(|want| device.product_id == want)
                && usage_page.is_none_or(|want| device.usage_page == want)
        })
        .collect();
    if matched.is_empty() {
        return Err(("not_found".to_owned(), "没有匹配的 HID 集合".to_owned()));
    }

    let mut collections = Vec::new();
    let mut opened: Vec<(HidDevice, HidSession)> = Vec::new();
    for device in matched {
        match HidSession::open(&device.path, false) {
            Ok(session) => {
                let session = session.with_report_lengths(
                    device.input_len,
                    device.output_len,
                    device.feature_len,
                );
                collections.push(json!({
                    "usagePage": format!("{:04X}", device.usage_page),
                    "inLen": device.input_len,
                    "outLen": device.output_len,
                    "fea": device.feature_len,
                    "opened": true
                }));
                opened.push((device, session));
            }
            Err(error) => collections.push(json!({
                "usagePage": format!("{:04X}", device.usage_page),
                "inLen": device.input_len,
                "outLen": device.output_len,
                "fea": device.feature_len,
                "opened": false,
                "error": error.to_string()
            })),
        }
    }
    if opened.is_empty() {
        return Err(("hid".to_owned(), "所有匹配的集合都打不开".to_owned()));
    }

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut reports: Vec<Value> = Vec::new();
    while Instant::now() < deadline && reports.len() < 2000 {
        let mut got_any = false;
        for (device, session) in &opened {
            match session.read(80) {
                Ok(Some(report)) => {
                    got_any = true;
                    reports.push(json!({
                        "usagePage": format!("{:04X}", device.usage_page),
                        "inLen": device.input_len,
                        "len": report.len(),
                        "hex": hex(&report)
                    }));
                }
                Ok(None) => {}
                Err(_) => {}
            }
        }
        if !got_any {
            thread::sleep(Duration::from_millis(20));
        }
    }

    Ok(json!({
        "windowMs": seconds * 1000,
        "collections": collections,
        "reports": reports
    }))
}

fn session_id(request: &Value) -> Result<u64, (String, String)> {
    request
        .get("session")
        .and_then(Value::as_u64)
        .ok_or_else(|| ("bad_request".to_owned(), "缺少 session".to_owned()))
}

fn request_hex_u16(request: &Value, key: &str) -> Option<u16> {
    let value = request.get(key)?;
    if let Some(number) = value.as_u64() {
        return u16::try_from(number).ok();
    }
    let text = value.as_str()?.trim();
    let cleaned = text.trim_start_matches("0x").trim_start_matches("0X");
    u16::from_str_radix(cleaned, 16).ok()
}

fn parse_hex_frame(text: Option<&str>) -> Result<Vec<u8>, (String, String)> {
    let text = text.ok_or_else(|| ("bad_request".to_owned(), "缺少 hex".to_owned()))?;
    let mut out = Vec::new();
    for token in text.split_whitespace() {
        let cleaned = token.trim_start_matches("0x").trim_start_matches("0X");
        let byte = u8::from_str_radix(cleaned, 16)
            .map_err(|_| ("bad_hex".to_owned(), format!("非法字节 `{token}`")))?;
        out.push(byte);
    }
    if out.is_empty() {
        return Err(("bad_hex".to_owned(), "hex 为空".to_owned()));
    }
    Ok(out)
}

fn pad_to(frame: &[u8], len: usize, label: &str) -> Result<Vec<u8>, (String, String)> {
    let len = if len == 0 { frame.len() } else { len };
    if frame.len() > len {
        return Err((
            "bad_length".to_owned(),
            format!("{label} {} 字节超过集合声明的 {len} 字节", frame.len()),
        ));
    }
    let mut out = vec![0u8; len];
    out[..frame.len()].copy_from_slice(frame);
    Ok(out)
}

fn arg_u64(args: &[String], name: &str) -> Option<u64> {
    let index = args.iter().position(|arg| arg == name)?;
    args.get(index + 1).and_then(|raw| raw.parse::<u64>().ok())
}

/// 起一个隐藏消息窗口监听设备接口变化；收到事件就向宿主写一行 JSON。
fn spawn_device_watcher() {
    thread::spawn(|| unsafe {
        run_watcher_window();
    });
}

/// # Safety
/// 只在专用线程调用；Win32 窗口/消息对象由该线程独占。
unsafe fn run_watcher_window() {
    let class_name: Vec<u16> = "PeripheralBatteryDaemonWatcher\0".encode_utf16().collect();
    // SAFETY: 模块句柄由系统提供；WNDCLASSW 在本栈上完整初始化。
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let mut class: WNDCLASSW = unsafe { std::mem::zeroed() };
    class.lpfnWndProc = Some(watcher_proc);
    class.hInstance = instance;
    class.lpszClassName = class_name.as_ptr();
    if unsafe { RegisterClassW(&class) } == 0 {
        return;
    }

    // SAFETY: 消息专用窗口 HWND_MESSAGE，参数均为本线程有效的值。
    let window = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if window.is_null() {
        return;
    }

    // 只注册 HID 接口；蓝牙/音频变化由宿主的低频签名兜底覆盖。
    let mut filter: DEV_BROADCAST_DEVICEINTERFACE_W = unsafe { std::mem::zeroed() };
    filter.dbcc_size = std::mem::size_of::<DEV_BROADCAST_DEVICEINTERFACE_W>() as u32;
    filter.dbcc_devicetype = DBT_DEVTYP_DEVICEINTERFACE;
    filter.dbcc_classguid = GUID_DEVINTERFACE_HID;
    // SAFETY: filter 在本线程生命周期内有效；窗口句柄由上面创建。
    unsafe {
        RegisterDeviceNotificationW(
            window,
            &filter as *const _ as *const core::ffi::c_void,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        );
    }

    let mut message: MSG = unsafe { std::mem::zeroed() };
    // SAFETY: 标准消息循环；message 为本栈结构。
    while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe extern "system" fn watcher_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_DEVICECHANGE {
        let event = wparam as u32;
        if event == DBT_DEVICEARRIVAL
            || event == DBT_DEVICEREMOVECOMPLETE
            || event == DBT_DEVNODES_CHANGED
        {
            write_line(&json!({"event": "devicesChanged", "at": now_ms()}));
        }
        return 1;
    }
    // SAFETY: 未处理的消息交回系统默认窗口过程。
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}
