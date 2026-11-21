//! 错误类型。
//!
//! 每个错误都带上足够定位问题的上下文（接口路径、Win32 错误码、期望长度），
//! 因为这些程序出问题时用户只能看到一句提示，日志里必须有料可查。

use std::fmt::Write as _;

/// HID 访问层的错误。
#[derive(Debug, thiserror::Error)]
pub enum HidError {
    /// SetupAPI 枚举失败。
    #[error("枚举 HID 设备失败（Win32 错误码 {code}）")]
    Enumerate {
        /// `GetLastError()` 的返回值。
        code: u32,
    },
    /// 打开设备接口失败，多半是被别的程序独占或者已经拔掉。
    #[error("打开设备失败：{path}（Win32 错误码 {code}）")]
    Open {
        /// 设备接口路径。
        path: String,
        /// `GetLastError()` 的返回值。
        code: u32,
    },
    /// 读取报文失败。
    #[error("读取报文失败（Win32 错误码 {code}）")]
    Read {
        /// `GetLastError()` 的返回值。
        code: u32,
    },
    /// 写入报文失败。
    #[error("发送报文失败（Win32 错误码 {code}）")]
    Write {
        /// `GetLastError()` 的返回值。
        code: u32,
    },
    /// 等待超时 —— 设备很可能在休眠。
    #[error("等待设备应答超时（{0} 毫秒）")]
    Timeout(u32),
    /// 命令行参数不对（只有 probe 工具会用到）。
    #[error("{0}")]
    Usage(String),
    /// 报文长度与设备声明的不一致。
    #[error("报文长度不符：设备要求 {expected} 字节，实际 {actual} 字节")]
    ReportLength {
        /// 设备声明的长度。
        expected: usize,
        /// 调用方给出的长度。
        actual: usize,
    },
}

/// 一次电量查询失败的原因。
#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    /// 底层 HID 出错。
    #[error(transparent)]
    Hid(#[from] HidError),
    /// 命令发出去了，但设备一个字都没回 —— 休眠或被别的程序接管。
    #[error("设备无应答")]
    NoResponse,
    /// 回了，但字节对不上协议。
    #[error("应答格式不符：{0}")]
    Malformed(&'static str),
}

/// 记录一条报文的十六进制文本（最多 `limit` 字节），用于日志。
#[must_use]
pub fn hex_preview(bytes: &[u8], limit: usize) -> String {
    let shown = bytes.len().min(limit);
    let mut out = String::with_capacity(shown * 3 + 8);
    for (index, byte) in bytes[..shown].iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        let _ = write!(out, "{byte:02X}");
    }
    if bytes.len() > shown {
        out.push_str(" …");
    }
    out
}
