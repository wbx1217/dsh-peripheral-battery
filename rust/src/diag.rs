//! 极简诊断日志。
//!
//! 这个程序是 `windows_subsystem = "windows"`，没有控制台，出问题时用户手上
//! 什么都没有。所以关键路径（托盘注册、每轮轮询结果）都往
//! `%LOCALAPPDATA%\PeripheralBattery\log.txt` 写一行，方便事后对账。
//!
//! 只追加、不轮转：一天几 KB，一年也就几百 KB。

use std::fs::{File, OpenOptions, create_dir_all};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::System::SystemInformation::GetLocalTime;

static LOG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
/// 长期持有的文件句柄。
///
/// 之前每写一行就 open/append/close 一次 —— 轮询每轮两行、托盘注册再多几行，
/// 一天下来是几万次系统调用。改成打开一次、失败（比如被删/被占）时再重开。
static LOG_FILE: Mutex<Option<File>> = Mutex::new(None);

/// 写一行日志。任何 IO 失败都静默忽略 —— 日志不该影响主流程。
pub fn log(message: &str) {
    let Some(path) = LOG_PATH.get_or_init(resolve_path).as_ref() else {
        return;
    };
    let mut slot = LOG_FILE.lock().unwrap_or_else(|poison| poison.into_inner());
    if slot.is_none() {
        *slot = OpenOptions::new().create(true).append(true).open(path).ok();
    }
    let Some(file) = slot.as_mut() else {
        return;
    };
    let line = format!("[{}] {message}", timestamp());
    if writeln!(file, "{line}").is_err() {
        // 句柄坏了（文件被删/被锁）：丢掉，下一次重开。
        *slot = None;
    }
}

/// `%LOCALAPPDATA%\PeripheralBattery\log.txt`
fn resolve_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = PathBuf::from(base).join("PeripheralBattery");
    create_dir_all(&dir).ok()?;
    Some(dir.join("log.txt"))
}

/// `MM-DD HH:MM:SS`
fn timestamp() -> String {
    // SAFETY: 出参是本栈上的有效结构，函数不持有指针。
    let time = unsafe {
        let mut value = std::mem::zeroed();
        GetLocalTime(&mut value);
        value
    };
    format!(
        "{:02}-{:02} {:02}:{:02}:{:02}",
        time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond
    )
}
