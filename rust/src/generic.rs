//! 标准 HID Battery Usage 兜底。
//!
//! 读取 Generic Device Controls `0x06:0x20`（Battery Strength）和
//! Battery System `0x85:0x65`（Absolute State Of Charge）。这些字段不依赖
//! 厂商协议，适用于暴露标准电池用量的键鼠/耳机/手柄。

use windows_sys::Win32::Devices::HumanInterfaceDevice::{
    HIDP_CAPS, HIDP_VALUE_CAPS, HidD_FreePreparsedData, HidD_GetFeature, HidD_GetInputReport,
    HidD_GetPreparsedData, HidP_Feature, HidP_GetCaps, HidP_GetUsageValue, HidP_GetValueCaps,
    HidP_Input,
};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};

use crate::hid::HidDevice;

const HIDP_STATUS_SUCCESS: i32 = 0x0011_0000;

#[derive(Debug, Clone)]
pub struct GenericBattery {
    pub percent: u8,
    pub name: String,
}

/// 尝试读取一台 HID 集合的标准电量字段。
///
/// 失败不是错误：没有标准 Battery Usage 的设备会直接返回 `None`。
#[must_use]
pub fn read(device: &HidDevice) -> Option<GenericBattery> {
    // 触控笔/绘图板、UPS/电源集合不碰，避免副作用。
    if device.usage_page == 0x0D || device.usage_page == 0x84 || device.usage_page == 0x85 {
        return None;
    }

    let wide: Vec<u16> = device
        .path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: wide 以 NUL 结尾；只请求读权限，不写设备。
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

    let result = read_handle(handle, device);
    // SAFETY: handle 由 CreateFileW 返回，且本函数是唯一持有者。
    unsafe { CloseHandle(handle) };
    result
}

fn read_handle(handle: HANDLE, device: &HidDevice) -> Option<GenericBattery> {
    let mut preparsed: isize = 0;
    // SAFETY: 输出参数由本函数持有，失败时不会使用。
    if !unsafe { HidD_GetPreparsedData(handle, &mut preparsed) } {
        return None;
    }
    if preparsed == 0 {
        return None;
    }

    let mut caps = HIDP_CAPS::default();
    // SAFETY: preparsed 有效；caps 是栈上输出结构。
    let caps_ok = unsafe { HidP_GetCaps(preparsed, &mut caps) } == HIDP_STATUS_SUCCESS;
    let result = if caps_ok {
        read_caps(handle, preparsed, &caps, device)
    } else {
        None
    };

    // SAFETY: preparsed 由 HidD_GetPreparsedData 分配，必须配对释放。
    unsafe { HidD_FreePreparsedData(preparsed) };
    result
}

fn read_caps(
    handle: HANDLE,
    preparsed: isize,
    caps: &HIDP_CAPS,
    device: &HidDevice,
) -> Option<GenericBattery> {
    for (report_type, count, length) in [
        (
            HidP_Feature,
            caps.NumberFeatureValueCaps,
            caps.FeatureReportByteLength,
        ),
        (
            HidP_Input,
            caps.NumberInputValueCaps,
            caps.InputReportByteLength,
        ),
    ] {
        if count == 0 || length == 0 {
            continue;
        }
        let mut values = vec![HIDP_VALUE_CAPS::default(); count as usize];
        let mut value_count = count;
        // SAFETY: values 容量为 count；preparsed 有效。
        let status = unsafe {
            HidP_GetValueCaps(
                report_type,
                values.as_mut_ptr(),
                &mut value_count,
                preparsed,
            )
        };
        if status != HIDP_STATUS_SUCCESS {
            continue;
        }

        for value in values.iter().take(value_count as usize) {
            let usage = unsafe {
                if value.IsRange {
                    value.Anonymous.Range.UsageMin
                } else {
                    value.Anonymous.NotRange.Usage
                }
            };
            if !is_battery_usage(value.UsagePage, usage) {
                continue;
            }

            let mut buffer = vec![0u8; usize::from(length)];
            if buffer.is_empty() {
                continue;
            }
            buffer[0] = value.ReportID;
            // SAFETY: buffer 长度与设备报告长度一致，report_id 已放在首字节。
            let got = unsafe {
                if report_type == HidP_Feature {
                    HidD_GetFeature(handle, buffer.as_mut_ptr().cast(), length.into())
                } else {
                    HidD_GetInputReport(handle, buffer.as_mut_ptr().cast(), length.into())
                }
            };
            if !got {
                continue;
            }

            let mut raw = 0u32;
            // SAFETY: buffer/preparsed 有效；usage 来自 value caps。
            let usage_status = unsafe {
                HidP_GetUsageValue(
                    report_type,
                    value.UsagePage,
                    value.LinkCollection,
                    usage,
                    &mut raw,
                    preparsed,
                    buffer.as_ptr().cast(),
                    length.into(),
                )
            };
            if usage_status != HIDP_STATUS_SUCCESS {
                continue;
            }
            if let Some(percent) = percent_from_value(device.vendor_id, value, raw) {
                return Some(GenericBattery {
                    percent,
                    name: if device.product.trim().is_empty() {
                        "Wireless device".to_owned()
                    } else {
                        device.product.clone()
                    },
                });
            }
        }
    }
    None
}

fn is_battery_usage(page: u16, usage: u16) -> bool {
    (page == 0x06 && usage == 0x20) || (page == 0x85 && usage == 0x65)
}

fn percent_from_value(vendor_id: u16, value: &HIDP_VALUE_CAPS, raw: u32) -> Option<u8> {
    // Apple 的 Magic 系列声明 0..255，但实际直接上报百分比。
    if vendor_id == 0x05AC && raw <= 100 {
        return Some(raw as u8);
    }
    if value.LogicalMax > value.LogicalMin {
        let span = i64::from(value.LogicalMax) - i64::from(value.LogicalMin);
        let offset = i64::from(raw) - i64::from(value.LogicalMin);
        return Some(((offset * 100 / span).clamp(0, 100)) as u8);
    }
    if raw <= 100 { Some(raw as u8) } else { None }
}

#[cfg(test)]
mod tests {
    use super::percent_from_value;
    use windows_sys::Win32::Devices::HumanInterfaceDevice::HIDP_VALUE_CAPS;

    fn caps(min: i32, max: i32) -> HIDP_VALUE_CAPS {
        HIDP_VALUE_CAPS {
            LogicalMin: min,
            LogicalMax: max,
            ..Default::default()
        }
    }

    #[test]
    fn scales_logical_range() {
        assert_eq!(percent_from_value(0x1234, &caps(0, 255), 128), Some(50));
        assert_eq!(percent_from_value(0x1234, &caps(0, 100), 64), Some(64));
        assert_eq!(percent_from_value(0x1234, &caps(20, 80), 50), Some(50));
    }

    #[test]
    fn clamps_and_handles_degenerate_range() {
        assert_eq!(percent_from_value(0x1234, &caps(0, 255), 400), Some(100));
        assert_eq!(percent_from_value(0x1234, &caps(0, 0), 80), Some(80));
        assert_eq!(percent_from_value(0x1234, &caps(0, 0), 120), None);
    }

    #[test]
    fn apple_percent_quirk() {
        assert_eq!(percent_from_value(0x05AC, &caps(0, 255), 75), Some(75));
    }
}
