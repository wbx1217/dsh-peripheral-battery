//! XInput 手柄电量：四档映射成百分比。
//!
//! XInput 不暴露精确百分比，只给 empty/low/medium/full；这里取每档的中间值
//! （5/20/50/100），有线手柄（BatteryType=1）显示 100% 充电中。

use windows_sys::Win32::UI::Input::XboxController::{
    BATTERY_DEVTYPE_GAMEPAD, XINPUT_BATTERY_INFORMATION, XINPUT_STATE, XInputGetBatteryInformation,
    XInputGetState,
};

/// 枚举槽位 0–3，返回每个已连接手柄的设备 JSON。
#[must_use]
pub fn devices_json() -> Vec<String> {
    let mut devices = Vec::new();
    for slot in 0u32..4 {
        // SAFETY: 出参是本栈上的有效结构，XInput 只写这两个结构。
        let mut state = unsafe { std::mem::zeroed::<XINPUT_STATE>() };
        if unsafe { XInputGetState(slot, &mut state) } != 0 {
            continue;
        }
        let mut info = unsafe { std::mem::zeroed::<XINPUT_BATTERY_INFORMATION>() };
        let read_ok =
            unsafe { XInputGetBatteryInformation(slot, BATTERY_DEVTYPE_GAMEPAD, &mut info) } == 0;
        if !read_ok || info.BatteryType == 0 {
            continue;
        }
        let (percent, charging, level) = if info.BatteryType == 1 {
            (100u8, true, "full")
        } else {
            match info.BatteryLevel {
                3 => (100, false, "full"),
                2 => (50, false, "medium"),
                1 => (20, false, "low"),
                0 => (5, false, "empty"),
                _ => (0, false, "unknown"),
            }
        };
        devices.push(format!(
            "{{\"key\":\"xinput-{slot}\",\"name\":\"Xbox 手柄\",\"kind\":\"controller\",\
             \"transport\":\"XInput\",\"status\":\"online\",\"percent\":{percent},\
             \"charging\":{charging},\"updatedAt\":null,\"source\":\"xinput\",\"level\":\"{level}\"}}"
        ));
    }
    devices
}
