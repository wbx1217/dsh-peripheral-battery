//! Microsoft Phone Link 电量。
//!
//! Phone Link 把一张本地化 Adaptive Card 写到包目录：
//! `%LOCALAPPDATA%\Packages\Microsoft.YourPhone_8wekyb3d8bbwe\LocalState\
//! StartMenu\StartMenuCompanion.json`。
//! 这是未公开实现细节；只读文件，不联网，不改 Phone Link。

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde_json::Value;

const STALE_SECS: u64 = 3 * 60 * 60;

#[derive(Debug, Clone)]
pub struct PhoneReading {
    pub name: String,
    pub percent: u8,
    pub charging: bool,
    pub stale: bool,
}

#[derive(Debug, Clone, Default)]
pub struct PhoneLinkDiagnostics {
    pub file_found: bool,
    pub age_secs: Option<u64>,
    pub error: Option<String>,
}

/// 读取 Phone Link 卡片；文件不存在、格式变化或读数不明确时返回 `None`。
#[must_use]
pub fn scan() -> Option<PhoneReading> {
    scan_with_diagnostics().0
}

/// 带诊断的读取：文件是否存在、卡片年龄、失败原因。
#[must_use]
pub fn scan_with_diagnostics() -> (Option<PhoneReading>, PhoneLinkDiagnostics) {
    let local = match std::env::var_os("LOCALAPPDATA") {
        Some(value) => value,
        None => {
            return (
                None,
                PhoneLinkDiagnostics {
                    file_found: false,
                    age_secs: None,
                    error: Some("LOCALAPPDATA 不存在".to_owned()),
                },
            );
        }
    };
    let path = PathBuf::from(local)
        .join("Packages")
        .join("Microsoft.YourPhone_8wekyb3d8bbwe")
        .join("LocalState")
        .join("StartMenu")
        .join("StartMenuCompanion.json");
    let Ok(metadata) = fs::metadata(&path) else {
        return (
            None,
            PhoneLinkDiagnostics {
                file_found: false,
                age_secs: None,
                error: Some("StartMenuCompanion.json 不存在".to_owned()),
            },
        );
    };
    let age = metadata.modified().ok().and_then(|modified| {
        SystemTime::now()
            .duration_since(modified)
            .ok()
            .map(|duration| duration.as_secs())
    });
    let base = PhoneLinkDiagnostics {
        file_found: true,
        age_secs: age,
        error: None,
    };
    if metadata.len() == 0 || metadata.len() > 4 * 1024 * 1024 {
        return (
            None,
            PhoneLinkDiagnostics {
                error: Some("卡片文件为空或过大".to_owned()),
                ..base
            },
        );
    }
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) => {
            return (
                None,
                PhoneLinkDiagnostics {
                    error: Some(format!("读取卡片失败：{error}")),
                    ..base
                },
            );
        }
    };
    let root: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            return (
                None,
                PhoneLinkDiagnostics {
                    error: Some(format!("卡片 JSON 无效：{error}")),
                    ..base
                },
            );
        }
    };
    let Some(speak) = root.get("speak").and_then(Value::as_str) else {
        return (
            None,
            PhoneLinkDiagnostics {
                error: Some("卡片缺少 speak 字段".to_owned()),
                ..base
            },
        );
    };
    let Some(name) = connected_phone_name(speak) else {
        return (
            None,
            PhoneLinkDiagnostics {
                error: Some("卡片不是已连接手机".to_owned()),
                ..base
            },
        );
    };
    let japanese = speak.ends_with(" - PC に接続しました");

    let mut percent = None;
    let mut charging = false;
    let mut ambiguous = false;
    walk(&root, japanese, &mut percent, &mut charging, &mut ambiguous);

    if ambiguous {
        return (
            None,
            PhoneLinkDiagnostics {
                error: Some("卡片包含多个不一致的电量".to_owned()),
                ..base
            },
        );
    }
    let Some(percent) = percent else {
        return (
            None,
            PhoneLinkDiagnostics {
                error: Some("卡片没有可识别的电量".to_owned()),
                ..base
            },
        );
    };
    let stale = age.is_some_and(|seconds| seconds > STALE_SECS);

    (
        Some(PhoneReading {
            name,
            percent,
            charging,
            stale,
        }),
        base,
    )
}

fn connected_phone_name(speak: &str) -> Option<String> {
    for suffix in [" - Connected to your PC", " - PC に接続しました"] {
        if let Some(name) = speak.strip_suffix(suffix) {
            let name = name.trim();
            if !name.is_empty() {
                return Some(name.to_owned());
            }
        }
    }
    None
}

fn walk(
    value: &Value,
    japanese: bool,
    percent: &mut Option<u8>,
    charging: &mut bool,
    ambiguous: &mut bool,
) {
    if let Some(items) = value.as_array() {
        for item in items {
            walk(item, japanese, percent, charging, ambiguous);
        }
        return;
    }
    let Some(object) = value.as_object() else {
        return;
    };

    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        if !matches!(
            kind,
            "AdaptiveCard" | "Container" | "ColumnSet" | "Column" | "TextBlock" | "Image"
        ) {
            return;
        }
    }

    if let Some(tooltip) = object.get("tooltip").and_then(Value::as_str) {
        let tooltip_japanese = tooltip.starts_with("バッテリー 残量 ");
        if tooltip_japanese == japanese {
            if let Some((level, charge)) = battery_from_tooltip(tooltip, japanese) {
                let text_matches = object
                    .get("text")
                    .and_then(Value::as_str)
                    .is_none_or(|text| text == format!("{level}%"));
                if text_matches {
                    if percent.is_some_and(|old| old != level || *charging != charge) {
                        *ambiguous = true;
                    }
                    *percent = Some(level);
                    *charging = charge;
                }
            }
        }
    }

    for field in ["body", "items", "columns"] {
        if let Some(child) = object.get(field) {
            walk(child, japanese, percent, charging, ambiguous);
        }
    }
}

fn battery_from_tooltip(tooltip: &str, japanese: bool) -> Option<(u8, bool)> {
    let prefix = if japanese {
        "バッテリー 残量 "
    } else {
        "Battery "
    };
    let rest = tooltip.strip_prefix(prefix)?;
    let digits: String = rest
        .chars()
        .take_while(char::is_ascii_digit)
        .take(3)
        .collect();
    if digits.is_empty() {
        return None;
    }
    let after_digits = &rest[digits.len()..];
    let after_percent = after_digits.strip_prefix('%')?;
    let level: u8 = digits.parse().ok()?;
    if level > 100 {
        return None;
    }
    if japanese {
        return after_percent.is_empty().then_some((level, false));
    }
    match after_percent {
        " remaining" => Some((level, false)),
        " remaining, charging" => Some((level, true)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{battery_from_tooltip, connected_phone_name};

    #[test]
    fn extracts_phone_name() {
        assert_eq!(
            connected_phone_name("Pixel 9 - Connected to your PC").as_deref(),
            Some("Pixel 9")
        );
        assert_eq!(
            connected_phone_name("Pixel 9 - PC に接続しました").as_deref(),
            Some("Pixel 9")
        );
        assert_eq!(connected_phone_name("Pixel 9"), None);
    }

    #[test]
    fn parses_english_and_japanese_battery() {
        assert_eq!(
            battery_from_tooltip("Battery 64% remaining", false),
            Some((64, false))
        );
        assert_eq!(
            battery_from_tooltip("Battery 64% remaining, charging", false),
            Some((64, true))
        );
        assert_eq!(
            battery_from_tooltip("バッテリー 残量 64%", true),
            Some((64, false))
        );
        assert_eq!(battery_from_tooltip("Battery 101% remaining", false), None);
        assert_eq!(battery_from_tooltip("Battery 64%", false), None);
    }
}
