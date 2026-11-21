//! 一个打开的 HID 句柄。
//!
//! 一律使用 overlapped I/O：同一个句柄上的阻塞读和写会互相打架，参考实现
//! 就踩过这个坑（进程被内核直接干掉）。带超时的读写是查询厂商协议的前提 ——
//! 休眠中的设备会一直不应答。

use std::ffi::c_void;

use windows_sys::Win32::Foundation::ERROR_WRITE_FAULT;
use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, ReadFile,
    WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};

use crate::error::HidError;

/// `ReadFile` / `WriteFile` 在 overlapped 模式下返回的「稍后完成」错误码。
const ERROR_IO_PENDING: u32 = 997;

/// 取消一次 IO 后，最多再等多久让它真正收尾（毫秒）。
const CANCEL_WAIT_MS: u32 = 1000;

/// 一个打开的 HID 设备句柄。
///
/// 句柄在 [`Drop`] 时关闭；不会跨线程共享（内部无同步）。
#[derive(Debug)]
pub struct HidSession {
    handle: HANDLE,
    event: HANDLE,
    input_len: u16,
    output_len: u16,
    feature_len: u16,
}

impl HidSession {
    /// 打开设备接口路径。
    ///
    /// `writable` 为 `false` 时只请求读权限 —— 被动监听必须用这种方式，
    /// 避免往共享接收器里注入任何字节。
    ///
    /// # Errors
    ///
    /// 句柄或事件创建失败时返回 [`HidError::Open`]。
    pub fn open(path: &str, writable: bool) -> Result<Self, HidError> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let access = if writable {
            GENERIC_READ | GENERIC_WRITE
        } else {
            GENERIC_READ
        };

        // SAFETY: wide 以 NUL 结尾且在调用期间有效；失败时返回 INVALID_HANDLE_VALUE。
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            // SAFETY: 纯读取线程局部错误码。
            return Err(HidError::Open {
                path: path.to_owned(),
                code: unsafe { GetLastError() },
            });
        }

        // SAFETY: 手工重置事件，初始未触发；名称传 null 表示匿名事件。所有权归本结构体。
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            // SAFETY: handle 刚创建成功，尚未移交，此处关闭不会二次释放。
            unsafe { CloseHandle(handle) };
            // SAFETY: 纯读取线程局部错误码。
            return Err(HidError::Open {
                path: path.to_owned(),
                code: unsafe { GetLastError() },
            });
        }

        Ok(Self {
            handle,
            event,
            input_len: 0,
            output_len: 0,
            feature_len: 0,
        })
    }

    /// 记录设备声明的报文长度，供 [`Self::read`] 分配缓冲区。
    ///
    /// 长度来自枚举结果；不设置时默认按 64 字节处理。
    #[must_use]
    pub fn with_report_lengths(
        mut self,
        input_len: u16,
        output_len: u16,
        feature_len: u16,
    ) -> Self {
        self.input_len = input_len;
        self.output_len = output_len;
        self.feature_len = feature_len;
        self
    }

    /// 设备声明的输入报文长度（未设置时为 64）。
    #[must_use]
    pub fn input_len(&self) -> usize {
        if self.input_len == 0 {
            64
        } else {
            usize::from(self.input_len)
        }
    }

    /// 设备声明的输出报文长度（未设置时为 64）。
    #[must_use]
    pub fn output_len(&self) -> usize {
        if self.output_len == 0 {
            64
        } else {
            usize::from(self.output_len)
        }
    }

    /// 设备声明的特性报文长度（未设置时为 64）。
    #[must_use]
    pub fn feature_len(&self) -> usize {
        if self.feature_len == 0 {
            64
        } else {
            usize::from(self.feature_len)
        }
    }

    /// 读一条输入报文。
    ///
    /// 超时返回 `Ok(None)`；设备拔掉返回 `Err`。
    ///
    /// # Errors
    ///
    /// 句柄失效或读取失败时返回 [`HidError::Read`]。
    pub fn read(&self, timeout_ms: u32) -> Result<Option<Vec<u8>>, HidError> {
        let len = self.input_len();
        let mut buf = vec![0u8; len];
        // OVERLAPPED 放堆上：取消超时时有权利把那块内存留在原地（泄漏也比
        // 让内核往已释放的栈帧里写强）。
        // SAFETY: OVERLAPPED 是纯 POD，零值是合法的初始状态。
        let mut overlapped = Box::new(unsafe { std::mem::zeroed::<OVERLAPPED>() });
        overlapped.hEvent = self.event;
        // SAFETY: 事件由本结构体持有，重置不涉及其他线程。
        unsafe { ResetEvent(self.event) };

        let mut read = 0u32;
        // SAFETY: buf 长度等于设备声明的输入报文长度；overlapped 在本函数期间一直有效。
        let started = unsafe {
            ReadFile(
                self.handle,
                buf.as_mut_ptr(),
                u32::try_from(len).unwrap_or(u32::MAX),
                &mut read,
                &mut *overlapped,
            )
        };

        if started == 0 {
            // SAFETY: 纯读取线程局部错误码。
            let err = unsafe { GetLastError() };
            if err != ERROR_IO_PENDING {
                return Err(HidError::Read { code: err });
            }
            // SAFETY: 事件句柄有效，等待时长由调用方给定。
            let waited = unsafe { WaitForSingleObject(self.event, timeout_ms) };
            if waited != WAIT_OBJECT_0 {
                // 取消后必须等内核真正结束这次 IO，否则 buf 可能在函数返回后仍被写入。
                // 但「等」也得有上限：驱动不回取消请求时，宁可泄漏本次 IO 的
                // 缓冲区，也不能把线程挂在核心里、更不能让内核写已释放内存。
                // SAFETY: overlapped 与句柄均有效。
                unsafe { CancelIoEx(self.handle, &*overlapped) };
                // SAFETY: 同上，只等有限时间。
                let drained = unsafe { WaitForSingleObject(self.event, CANCEL_WAIT_MS) };
                if drained == WAIT_OBJECT_0 {
                    // SAFETY: 事件已触发，取走结果后 OVERLAPPED 可以安全释放。
                    unsafe { GetOverlappedResult(self.handle, &*overlapped, &mut read, 0) };
                } else {
                    crate::diag::log("取消 HID 读超时：泄漏本次 IO 的缓冲区，避免内核写已释放内存");
                    std::mem::forget(buf);
                    std::mem::forget(overlapped);
                }
                return Ok(None);
            }
            // SAFETY: 事件已触发，overlapped 有效，bWait=FALSE 只取结果。
            let ok = unsafe { GetOverlappedResult(self.handle, &*overlapped, &mut read, 0) };
            if ok == 0 {
                // SAFETY: 纯读取线程局部错误码。
                return Err(HidError::Read {
                    code: unsafe { GetLastError() },
                });
            }
        }

        let read = usize::try_from(read).unwrap_or(0);
        buf.truncate(read.min(len));
        Ok(Some(buf))
    }

    /// 写一条输出报文（interrupt OUT 管道）。
    ///
    /// # Errors
    ///
    /// 写入失败或超时时返回 [`HidError::Write`] / [`HidError::Timeout`]。
    pub fn write(&self, report: &[u8], timeout_ms: u32) -> Result<(), HidError> {
        // SAFETY: OVERLAPPED 是纯 POD，零值是合法的初始状态。
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = self.event;
        // SAFETY: 事件由本结构体持有，重置不涉及其他线程。
        unsafe { ResetEvent(self.event) };

        let mut written = 0u32;
        // SAFETY: report 在调用期间有效，长度由切片保证。
        let started = unsafe {
            WriteFile(
                self.handle,
                report.as_ptr(),
                u32::try_from(report.len()).unwrap_or(u32::MAX),
                &mut written,
                &mut overlapped,
            )
        };

        if started == 0 {
            // SAFETY: 纯读取线程局部错误码。
            let err = unsafe { GetLastError() };
            if err != ERROR_IO_PENDING {
                return Err(HidError::Write { code: err });
            }
            // SAFETY: 事件句柄有效，等待时长由调用方给定。
            let waited = unsafe { WaitForSingleObject(self.event, timeout_ms) };
            if waited != WAIT_OBJECT_0 {
                // 写路径不能像读那样「泄漏缓冲区了事」：这里要读的 `report` 是调用方
                // 借给我们的，函数一返回它就归调用方处置。所以只能等内核确认取消完成
                // （bWait=TRUE），但至少先把「卡住了」记下来，别让下一次挂起无从查起。
                crate::diag::log(&format!("HID 写超时（{timeout_ms}ms），等待内核完成取消"));
                // SAFETY: overlapped 与句柄均有效；bWait=TRUE 保证同步到完成状态。
                unsafe {
                    CancelIoEx(self.handle, &overlapped);
                    GetOverlappedResult(self.handle, &overlapped, &mut written, 1);
                }
                return Err(HidError::Timeout(timeout_ms));
            }
            // 事件触发只代表 IO「结束」，不代表「成功」：设备拒收时照样会完成。
            // 必须取一次结果，否则写失败会被静默吞成成功。
            // SAFETY: 事件已触发，overlapped 有效，bWait=FALSE 只取结果。
            let ok = unsafe { GetOverlappedResult(self.handle, &overlapped, &mut written, 0) };
            if ok == 0 {
                // SAFETY: 纯读取线程局部错误码。
                return Err(HidError::Write {
                    code: unsafe { GetLastError() },
                });
            }
            if usize::try_from(written).unwrap_or(0) != report.len() {
                return Err(HidError::Write {
                    code: ERROR_WRITE_FAULT,
                });
            }
        }
        Ok(())
    }

    /// 通过控制管道写输出报文（`HID SET_REPORT`）。
    ///
    /// 部分固件只认这条路径 —— 迈从的键盘固件就拒绝 interrupt OUT。
    ///
    /// # Errors
    ///
    /// 报文长度非法或设备拒绝时返回错误。
    pub fn set_output_report(&self, report: &[u8]) -> Result<(), HidError> {
        let expected = self.output_len();
        if report.len() > expected {
            return Err(HidError::ReportLength {
                expected,
                actual: report.len(),
            });
        }
        // 短了就补零：固件按「设备声明的长度」收报文，少给字节有的驱动直接拒收。
        // （探针工具一直是这么补的，这里跟它对齐。）
        let padded;
        let report = if report.len() == expected {
            report
        } else {
            padded = {
                let mut buf = vec![0u8; expected];
                buf[..report.len()].copy_from_slice(report);
                buf
            };
            padded.as_slice()
        };
        // SAFETY: report 长度已对齐到设备声明的输出报文长度，句柄有效。
        let ok = unsafe {
            windows_sys::Win32::Devices::HumanInterfaceDevice::HidD_SetOutputReport(
                self.handle,
                report.as_ptr().cast::<c_void>(),
                u32::try_from(report.len()).unwrap_or(u32::MAX),
            )
        };
        if !ok {
            // SAFETY: 纯读取线程局部错误码。
            return Err(HidError::Write {
                code: unsafe { GetLastError() },
            });
        }
        Ok(())
    }

    /// 读特性报文（`HID GET_FEATURE`）。
    ///
    /// # Errors
    ///
    /// 报文长度非法或设备拒绝时返回错误。
    pub fn get_feature(&self, report: &mut [u8]) -> Result<(), HidError> {
        let expected = self.feature_len();
        if report.len() != expected {
            return Err(HidError::ReportLength {
                expected,
                actual: report.len(),
            });
        }
        // SAFETY: report 长度已校验，句柄有效，缓冲区可写。
        let ok = unsafe {
            windows_sys::Win32::Devices::HumanInterfaceDevice::HidD_GetFeature(
                self.handle,
                report.as_mut_ptr().cast::<c_void>(),
                u32::try_from(report.len()).unwrap_or(u32::MAX),
            )
        };
        if !ok {
            // SAFETY: 纯读取线程局部错误码。
            return Err(HidError::Read {
                code: unsafe { GetLastError() },
            });
        }
        Ok(())
    }

    /// 写特性报文（`HID SET_FEATURE`）。
    ///
    /// # Errors
    ///
    /// 报文长度非法或设备拒绝时返回错误。
    pub fn set_feature(&self, report: &[u8]) -> Result<(), HidError> {
        let expected = self.feature_len();
        if report.len() != expected {
            return Err(HidError::ReportLength {
                expected,
                actual: report.len(),
            });
        }
        // SAFETY: report 长度已校验，句柄有效。
        let ok = unsafe {
            windows_sys::Win32::Devices::HumanInterfaceDevice::HidD_SetFeature(
                self.handle,
                report.as_ptr().cast::<c_void>(),
                u32::try_from(report.len()).unwrap_or(u32::MAX),
            )
        };
        if !ok {
            // SAFETY: 纯读取线程局部错误码。
            return Err(HidError::Write {
                code: unsafe { GetLastError() },
            });
        }
        Ok(())
    }

    /// 清空输入队列：一直读到空闲为止。
    ///
    /// 查询前必须先清干净，否则读到的会是上一轮残留的状态报文。
    pub fn flush(&self, idle_ms: u32) {
        for _ in 0..32 {
            match self.read(idle_ms) {
                Ok(Some(_)) => continue,
                _ => break,
            }
        }
    }
}

impl Drop for HidSession {
    fn drop(&mut self) {
        // SAFETY: 两个句柄都由 Self 独占持有，Drop 只执行一次。
        unsafe {
            if !self.event.is_null() {
                CloseHandle(self.event);
            }
            if self.handle != INVALID_HANDLE_VALUE && !self.handle.is_null() {
                CloseHandle(self.handle);
            }
        }
    }
}

/// 辅助：把字节切片格式化成 `02 80 09 ...` 便于日志比对。
///
/// # Examples
///
/// ```
/// use peripheral_battery::hid::session::hex;
/// assert_eq!(hex(&[0x02, 0x1E, 0xFF]), "02 1E FF");
/// ```
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 3);
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(&format!("{byte:02X}"));
    }
    out
}
