//! 枚举本机所有 HID 集合。
//!
//! 每次刷新只做一次全量枚举，结果交给所有 provider 共享 —— 参考实现
//! 早期让每个 provider 各自走一遍 USB 树，在有多个外设的机器上白白花了
//! 两秒。这里从一开始就只枚举一次。

use std::ffi::c_void;
use std::mem::size_of;

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    DIGCF_DEVICEINTERFACE, DIGCF_PRESENT, SP_DEVICE_INTERFACE_DATA,
    SP_DEVICE_INTERFACE_DETAIL_DATA_W, SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces,
    SetupDiGetClassDevsW, SetupDiGetDeviceInterfaceDetailW,
};
use windows_sys::Win32::Devices::HumanInterfaceDevice::{
    HIDD_ATTRIBUTES, HIDP_CAPS, HidD_FreePreparsedData, HidD_GetAttributes,
    HidD_GetManufacturerString, HidD_GetPreparsedData, HidD_GetProductString, HidP_GetCaps,
};
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_ITEMS, GetLastError, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};

use crate::error::HidError;

/// `HidP_GetCaps` 成功时的返回码（NTSTATUS 形式的 `HIDP_STATUS_SUCCESS`）。
const HIDP_STATUS_SUCCESS: i32 = 0x0011_0000;

/// 一个 HID 顶层集合的描述。
#[derive(Debug, Clone, Default)]
pub struct HidDevice {
    /// USB 厂商号。
    pub vendor_id: u16,
    /// USB 产品号。
    pub product_id: u16,
    /// 设备版本号，部分固件用它区分型号。
    pub version: u16,
    /// HID 用途页，`0xFF00` 及以上是厂商自定义集合。
    pub usage_page: u16,
    /// HID 用途号。
    pub usage: u16,
    /// 输入报文长度（含 report id 字节）。
    pub input_len: u16,
    /// 输出报文长度。
    pub output_len: u16,
    /// 特性报文长度。
    pub feature_len: u16,
    /// USB 产品字符串，固件没提供时为空。
    pub product: String,
    /// USB 厂商字符串。
    pub manufacturer: String,
    /// 设备接口路径，打开句柄时用。
    pub path: String,
}

impl HidDevice {
    /// 是否为厂商自定义集合（用途页 `0xFF00` 以上）。
    #[must_use]
    pub fn is_vendor_page(&self) -> bool {
        self.usage_page >= 0xFF00
    }

    /// `VID:PID` 的十六进制文本，用于日志与匹配。
    #[must_use]
    pub fn id(&self) -> String {
        format!("{:04X}:{:04X}", self.vendor_id, self.product_id)
    }
}

/// 枚举本机当前插着的全部 HID 集合。
///
/// 打不开的集合会被跳过而不是报错 —— 被系统独占的键盘集合本来就打不开，
/// 这不是故障，不影响厂商集合的读取。
///
/// # Errors
///
/// 仅当 SetupAPI 的设备列表本身拿不到时返回 [`HidError::Enumerate`]。
pub fn enumerate() -> Result<Vec<HidDevice>, HidError> {
    // SAFETY: 只是取一个固定 GUID，函数不写任何调用方内存以外的东西。
    let mut guid = windows_sys::core::GUID::default();
    unsafe { windows_sys::Win32::Devices::HumanInterfaceDevice::HidD_GetHidGuid(&mut guid) };

    let flags = DIGCF_PRESENT | DIGCF_DEVICEINTERFACE;
    // SAFETY: 传入合法的 GUID 指针与两个 null 句柄；返回的列表由下方统一释放。
    let dev_info =
        unsafe { SetupDiGetClassDevsW(&guid, std::ptr::null(), std::ptr::null_mut(), flags) };
    // SetupAPI 用 -1 表示失败（等价于 INVALID_HANDLE_VALUE 强转成 isize）。
    if dev_info == -1 {
        // SAFETY: 纯读取线程局部错误码。
        return Err(HidError::Enumerate {
            code: unsafe { GetLastError() },
        });
    }

    let mut devices = Vec::new();
    let mut index = 0u32;
    loop {
        // SAFETY: `did` 是本栈上的有效结构，cbSize 已按真实大小填写。
        let mut did = SP_DEVICE_INTERFACE_DATA {
            cbSize: size_of::<SP_DEVICE_INTERFACE_DATA>() as u32,
            ..Default::default()
        };
        let ok = unsafe {
            SetupDiEnumDeviceInterfaces(dev_info, std::ptr::null_mut(), &guid, index, &mut did)
        };
        if ok == 0 {
            // SAFETY: 纯读取线程局部错误码。
            let code = unsafe { GetLastError() };
            if code == ERROR_NO_MORE_ITEMS {
                break;
            }
            // SAFETY: dev_info 由本函数独占，提前返回前必须释放。
            unsafe { SetupDiDestroyDeviceInfoList(dev_info) };
            return Err(HidError::Enumerate { code });
        }
        index += 1;

        if let Some(device) = interface_path(dev_info, &did).and_then(|path| describe(&path)) {
            devices.push(device);
        }
    }

    // SAFETY: `dev_info` 由 SetupDiGetClassDevsW 返回，此处是本函数唯一的所有者。
    unsafe { SetupDiDestroyDeviceInfoList(dev_info) };
    Ok(devices)
}

/// 取一条设备接口的路径。拿不到就返回 `None`，由调用方跳过。
fn interface_path(
    dev_info: windows_sys::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO,
    did: &SP_DEVICE_INTERFACE_DATA,
) -> Option<String> {
    let mut required = 0u32;
    // SAFETY: 第一次调用只查询所需缓冲区大小，detail 指针为 null 是官方用法。
    unsafe {
        SetupDiGetDeviceInterfaceDetailW(
            dev_info,
            did,
            std::ptr::null_mut(),
            0,
            &mut required,
            std::ptr::null_mut(),
        );
    }
    if required == 0 {
        return None;
    }

    let mut buf = vec![0u8; required as usize];
    // cbSize 字段在前 4 字节，x64 上是 8。用 write_unaligned 避免对齐假设。
    // SAFETY: buf 长度至少为 required（>= 4），写入 4 字节不越界。
    unsafe {
        std::ptr::write_unaligned(
            buf.as_mut_ptr().cast::<u32>(),
            size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32,
        );
    }
    // SAFETY: buf 满足 required 长度，detail 由 SetupAPI 写入，读回后立刻转成 String。
    let ok = unsafe {
        SetupDiGetDeviceInterfaceDetailW(
            dev_info,
            did,
            buf.as_mut_ptr().cast::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>(),
            required,
            &mut required,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return None;
    }

    // DevicePath 从偏移 4 开始，是一段以 NUL 结尾的 UTF-16。手工解码可以
    // 完全避开对 buf 的对齐要求。
    let units: Vec<u16> = buf[4..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_ne_bytes(*pair))
        .collect();
    let end = units
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(units.len());
    if end == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&units[..end]))
}

/// 打开一条路径并读取 VID/PID、能力、产品字符串。
fn describe(path: &str) -> Option<HidDevice> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    // SAFETY: wide 以 NUL 结尾且在本函数内一直有效；只请求读取权限与共享打开，
    // 不写设备。句柄在函数结束前关闭。
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }

    let device = read_description(handle, path);

    // SAFETY: handle 由上面的 CreateFileW 取得，且本函数是唯一持有者。
    unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    device
}

/// 从已打开的句柄读出描述信息。
fn read_description(
    handle: windows_sys::Win32::Foundation::HANDLE,
    path: &str,
) -> Option<HidDevice> {
    // SAFETY: handle 有效；attrs 是本栈上的有效结构，Size 已按真实大小填写。
    let mut attrs = HIDD_ATTRIBUTES {
        Size: size_of::<HIDD_ATTRIBUTES>() as u32,
        ..Default::default()
    };
    let ok = unsafe { HidD_GetAttributes(handle, &mut attrs) };
    if !ok {
        return None;
    }

    let mut preparsed: isize = 0;
    // SAFETY: handle 有效；preparsed 是出参，成功后必须配对释放（下方立即释放）。
    let got_preparsed = unsafe { HidD_GetPreparsedData(handle, &mut preparsed) };
    if !got_preparsed {
        return None;
    }

    let mut caps = HIDP_CAPS::default();
    // SAFETY: preparsed 由 HidD_GetPreparsedData 填充，caps 是本栈上的有效结构。
    let status = unsafe { HidP_GetCaps(preparsed, &mut caps) };
    // SAFETY: 与上面的 HidD_GetPreparsedData 配对，且只释放一次。
    unsafe { HidD_FreePreparsedData(preparsed) };
    if status != HIDP_STATUS_SUCCESS {
        return None;
    }

    Some(HidDevice {
        vendor_id: attrs.VendorID,
        product_id: attrs.ProductID,
        version: attrs.VersionNumber,
        usage_page: caps.UsagePage,
        usage: caps.Usage,
        input_len: caps.InputReportByteLength,
        output_len: caps.OutputReportByteLength,
        feature_len: caps.FeatureReportByteLength,
        product: wide_string(handle, true),
        manufacturer: wide_string(handle, false),
        path: path.to_owned(),
    })
}

/// 读取产品名或厂商名，失败时返回空串（很多 dongle 本来就不提供）。
fn wide_string(handle: windows_sys::Win32::Foundation::HANDLE, product: bool) -> String {
    // HidD_Get*String 的长度参数是字节数，256 字节 = 128 个 UTF-16 单元。
    let mut buf = [0u16; 128];
    let bytes = (buf.len() * size_of::<u16>()) as u32;
    let ptr = buf.as_mut_ptr().cast::<c_void>();
    // SAFETY: handle 有效，buf 是长度足够的可写缓冲区。
    let ok = unsafe {
        if product {
            HidD_GetProductString(handle, ptr, bytes)
        } else {
            HidD_GetManufacturerString(handle, ptr, bytes)
        }
    };
    if !ok {
        return String::new();
    }
    let end = buf.iter().position(|&unit| unit == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}
