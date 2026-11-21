//! Windows HID 访问层。
//!
//! 对外只暴露两个安全类型：[`HidDevice`]（枚举结果）与 [`HidSession`]（一个
//! 打开的句柄）。所有 `unsafe` 都封闭在本模块内，且逐处标注 SAFETY 理由。

pub mod enumerate;
pub mod session;

pub use enumerate::{HidDevice, enumerate};
pub use session::HidSession;
