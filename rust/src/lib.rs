//! 2.4G 无线外设电量工具的协议层与 HID 访问层。
//!
//! 这是从 `PeripheralBattery` 裁剪出来的库：只保留「读」的能力，没有托盘、
//! 没有 UI、没有注册表偏好。DSH 插件通过 `peripheral-battery-cli` 调用它。

pub mod ble;
pub mod diag;
pub mod error;
pub mod generic;
pub mod hid;
pub mod phonelink;
pub mod util;
pub mod xinput;

pub use error::{DeviceError, HidError};
