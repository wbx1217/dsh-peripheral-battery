//! BLE 电量：GATT Battery Service + Windows 已知的蓝牙电量属性。
//!
//! 两者都要求设备实际连接：蓝牙 PnP 节点和电量属性在设备关机后仍会保留，
//! 所以先建立「蓝牙地址 -> ConnectionStatus」映射，非 Connected 的设备直接跳过。

use std::collections::HashMap;
use std::future::{Future, IntoFuture};
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use windows::Devices::Bluetooth::Advertisement::{
    BluetoothLEAdvertisement, BluetoothLEAdvertisementDataSection,
    BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcher,
    BluetoothLEScanningMode,
};
use windows::Devices::Bluetooth::GenericAttributeProfile::{GattCharacteristic, GattDeviceService};
use windows::Devices::Bluetooth::{BluetoothCacheMode, BluetoothDevice, BluetoothLEDevice};
use windows::Devices::Enumeration::DeviceInformation;
use windows::Foundation::TypedEventHandler;
use windows::Storage::Streams::DataReader;
use windows::core::GUID;

use windows_sys::Win32::Devices::DeviceAndDriverInstallation::{
    DIGCF_ALLCLASSES, DIGCF_PRESENT, SP_DEVINFO_DATA, SetupDiDestroyDeviceInfoList,
    SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
    SetupDiGetDevicePropertyW,
};
use windows_sys::Win32::Devices::Properties::DEVPROP_TYPE_BYTE;
use windows_sys::Win32::Foundation::DEVPROPKEY;
use windows_sys::Win32::System::Com::CoInitializeEx;

const BATTERY_SERVICE: GUID = GUID::from_u128(0x0000180f_0000_1000_8000_00805f9b34fb);
const BATTERY_LEVEL: GUID = GUID::from_u128(0x00002a19_0000_1000_8000_00805f9b34fb);

const BATTERY_PROPERTY: DEVPROPKEY = DEVPROPKEY {
    fmtid: windows_sys::core::GUID {
        data1: 0x104e_a319,
        data2: 0x6ee2,
        data3: 0x4701,
        data4: [0xbd, 0x47, 0x8d, 0xdb, 0xf4, 0x25, 0xbb, 0xe5],
    },
    pid: 2,
};

/// 一台蓝牙设备的电量读数。
#[derive(Debug, Clone)]
pub struct BleDevice {
    /// 设备 id（GATT 用 DeviceInformation.Id，devnode 用实例 id）。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// `gatt` / `windows` / `fastpair`。
    pub source: &'static str,
    /// 0–100。
    pub percent: u8,
    /// 充电状态；未知为 `None`。
    pub charging: Option<bool>,
    /// Fast Pair 的左右耳/充电盒详情。
    pub detail: Option<String>,
    /// Fast Pair 的结构化组件，供 UI 直接渲染。
    pub components: Vec<BleComponent>,
    /// 当前是否连接。
    pub connected: bool,
}

#[derive(Debug, Clone)]
pub struct BleComponent {
    pub label: String,
    pub percent: u8,
    pub charging: bool,
}

#[derive(Debug, Clone, Default)]
pub struct BleDiagnostics {
    pub gatt: usize,
    pub windows: usize,
    pub fastpair: usize,
    pub fastpair_advertisements: u32,
    pub fastpair_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BleScan {
    pub devices: Vec<BleDevice>,
    pub diagnostics: BleDiagnostics,
}

/// 忙等阻塞执行器：把 WinRT 的 IAsyncOperation 桥接成同步 CLI。
struct ThreadWaker(std::thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        // WinRT 完成回调通常会 unpark；2ms 是兜底，避免无唤醒源时永久挂起。
        std::thread::park_timeout(Duration::from_millis(2));
    }
}

/// 扫描所有蓝牙设备：先 GATT，再用 Windows 已知电量属性兜底。
#[must_use]
pub fn scan() -> Vec<BleDevice> {
    scan_with_diagnostics().devices
}

/// 扫描并返回每个数据源的计数/错误，供诊断使用。
#[must_use]
pub fn scan_with_diagnostics() -> BleScan {
    // SAFETY: 只初始化当前线程的 COM 公寓；返回值忽略（可能在别处已初始化）。
    let _ = unsafe { CoInitializeEx(std::ptr::null(), 0) };

    let connections = connection_map();
    let gatt = gatt_scan(&connections);
    let gatt_count = gatt.len();
    let mut devices = gatt;

    let mut seen_names: Vec<String> = devices
        .iter()
        .map(|device| device.name.to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();

    let windows = devnode_scan(&connections);
    let windows_count = windows.len();
    for device in windows {
        let key = device.name.to_ascii_lowercase();
        if !key.is_empty() && seen_names.contains(&key) {
            continue;
        }
        seen_names.push(key);
        devices.push(device);
    }

    let (fastpair, fastpair_diagnostics) = fastpair_scan(&connections);
    let fastpair_count = fastpair.len();
    for device in fastpair {
        let key = device.name.to_ascii_lowercase();
        if !key.is_empty() && seen_names.contains(&key) {
            continue;
        }
        seen_names.push(key);
        devices.push(device);
    }

    BleScan {
        devices,
        diagnostics: BleDiagnostics {
            gatt: gatt_count,
            windows: windows_count,
            fastpair: fastpair_count,
            fastpair_advertisements: fastpair_diagnostics.advertisements,
            fastpair_error: fastpair_diagnostics.error,
        },
    }
}

fn connection_map() -> HashMap<u64, (bool, String)> {
    let mut map = HashMap::new();
    collect_bluetooth_devices(&mut map);
    collect_ble_devices(&mut map);
    map
}

fn collect_bluetooth_devices(map: &mut HashMap<u64, (bool, String)>) {
    let Ok(selector) = BluetoothDevice::GetDeviceSelector() else {
        return;
    };
    let Ok(operation) = DeviceInformation::FindAllAsyncAqsFilter(&selector) else {
        return;
    };
    let Ok(infos) = block_on(operation.into_future()) else {
        return;
    };
    for index in 0..infos.Size().unwrap_or(0) {
        let Ok(info) = infos.GetAt(index) else {
            continue;
        };
        let Ok(id) = info.Id() else {
            continue;
        };
        let Ok(operation) = BluetoothDevice::FromIdAsync(&id) else {
            continue;
        };
        let Ok(device) = block_on(operation.into_future()) else {
            continue;
        };
        let Ok(address) = device.BluetoothAddress() else {
            continue;
        };
        if address == 0 {
            continue;
        }
        let status = device
            .ConnectionStatus()
            .map(|value| value.0 == 1)
            .unwrap_or(false);
        let name = device
            .Name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        map.entry(address).or_insert((status, name));
    }
}

fn collect_ble_devices(map: &mut HashMap<u64, (bool, String)>) {
    let Ok(selector) = BluetoothLEDevice::GetDeviceSelector() else {
        return;
    };
    let Ok(operation) = DeviceInformation::FindAllAsyncAqsFilter(&selector) else {
        return;
    };
    let Ok(infos) = block_on(operation.into_future()) else {
        return;
    };
    for index in 0..infos.Size().unwrap_or(0) {
        let Ok(info) = infos.GetAt(index) else {
            continue;
        };
        let Ok(id) = info.Id() else {
            continue;
        };
        let Ok(operation) = BluetoothLEDevice::FromIdAsync(&id) else {
            continue;
        };
        let Ok(device) = block_on(operation.into_future()) else {
            continue;
        };
        let Ok(address) = device.BluetoothAddress() else {
            continue;
        };
        if address == 0 {
            continue;
        }
        let status = device
            .ConnectionStatus()
            .map(|value| value.0 == 1)
            .unwrap_or(false);
        let name = device
            .Name()
            .map(|value| value.to_string())
            .unwrap_or_default();
        map.entry(address).or_insert((status, name));
    }
}

fn gatt_scan(connections: &HashMap<u64, (bool, String)>) -> Vec<BleDevice> {
    let mut devices = Vec::new();
    let Ok(selector) = BluetoothLEDevice::GetDeviceSelector() else {
        return devices;
    };
    let Ok(operation) = DeviceInformation::FindAllAsyncAqsFilter(&selector) else {
        return devices;
    };
    let Ok(infos) = block_on(operation.into_future()) else {
        return devices;
    };

    for index in 0..infos.Size().unwrap_or(0) {
        let Ok(info) = infos.GetAt(index) else {
            continue;
        };
        let Ok(id) = info.Id() else {
            continue;
        };
        let Ok(operation) = BluetoothLEDevice::FromIdAsync(&id) else {
            continue;
        };
        let Ok(device) = block_on(operation.into_future()) else {
            continue;
        };

        let address = device.BluetoothAddress().ok();
        let (connected, name) = address
            .and_then(|address| {
                connections
                    .get(&address)
                    .map(|(connected, name)| (*connected, name.clone()))
            })
            .unwrap_or_else(|| {
                (
                    false,
                    info.Name()
                        .map(|value| value.to_string())
                        .unwrap_or_default(),
                )
            });

        let Ok(operation) = device.GetGattServicesForUuidWithCacheModeAsync(
            BATTERY_SERVICE,
            BluetoothCacheMode::Uncached,
        ) else {
            continue;
        };
        let Ok(result) = block_on(operation.into_future()) else {
            continue;
        };
        let Ok(services) = result.Services() else {
            continue;
        };
        if services.Size().unwrap_or(0) == 0 {
            continue;
        }
        let Ok(service) = services.GetAt(0) else {
            continue;
        };
        let service: GattDeviceService = service;

        let Ok(operation) = service.GetCharacteristicsForUuidWithCacheModeAsync(
            BATTERY_LEVEL,
            BluetoothCacheMode::Uncached,
        ) else {
            continue;
        };
        let Ok(result) = block_on(operation.into_future()) else {
            continue;
        };
        let Ok(characteristics) = result.Characteristics() else {
            continue;
        };
        if characteristics.Size().unwrap_or(0) == 0 {
            continue;
        }
        let Ok(characteristic) = characteristics.GetAt(0) else {
            continue;
        };
        let characteristic: GattCharacteristic = characteristic;

        let Ok(operation) =
            characteristic.ReadValueWithCacheModeAsync(BluetoothCacheMode::Uncached)
        else {
            continue;
        };
        let Ok(read) = block_on(operation.into_future()) else {
            continue;
        };
        let Ok(buffer) = read.Value() else {
            continue;
        };
        let Ok(reader) = DataReader::FromBuffer(&buffer) else {
            continue;
        };
        let Ok(percent) = reader.ReadByte() else {
            continue;
        };
        if percent > 100 {
            continue;
        }

        devices.push(BleDevice {
            id: id.to_string(),
            name,
            source: "gatt",
            percent,
            charging: None,
            detail: None,
            components: Vec::new(),
            connected,
        });
    }

    devices
}

fn devnode_scan(connections: &HashMap<u64, (bool, String)>) -> Vec<BleDevice> {
    let mut devices = Vec::new();
    // SAFETY: 传空枚举器/父窗口，返回的设备信息集由本函数在末尾释放。
    // 用全部设备类而不是 Bluetooth 类：BTHENUM 音频/HID 子节点的 Class 往往
    // 是 MEDIA / System，按 Bluetooth 类枚举会漏掉它们。
    let device_info_set = unsafe {
        SetupDiGetClassDevsW(
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            DIGCF_ALLCLASSES | DIGCF_PRESENT,
        )
    };
    if device_info_set == -1 {
        return devices;
    }

    let mut index = 0u32;
    loop {
        // SAFETY: did 是本栈上按真实大小初始化的结构。
        let mut did: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
        did.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        if unsafe { SetupDiEnumDeviceInfo(device_info_set, index, &mut did) } == 0 {
            break;
        }
        index += 1;

        let mut instance_buffer = [0u16; 512];
        if unsafe {
            SetupDiGetDeviceInstanceIdW(
                device_info_set,
                &did,
                instance_buffer.as_mut_ptr(),
                instance_buffer.len() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            continue;
        }
        let length = instance_buffer
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(instance_buffer.len());
        let instance = String::from_utf16_lossy(&instance_buffer[..length]);
        let upper = instance.to_ascii_uppercase();
        if !upper.starts_with("BTHENUM\\") && !upper.starts_with("BTHLE\\") {
            continue;
        }

        let address = bluetooth_address_of(&instance);
        if let Some(address) = address {
            if let Some((connected, _)) = connections.get(&address) {
                if !*connected {
                    continue;
                }
            }
        }

        let mut property_type = 0u32;
        let mut data = [0u8; 8];
        let mut required = 0u32;
        // SAFETY: 属性 key 是常量，缓冲区是本栈上的可写数组。
        let ok = unsafe {
            SetupDiGetDevicePropertyW(
                device_info_set,
                &did,
                &BATTERY_PROPERTY,
                &mut property_type,
                data.as_mut_ptr(),
                data.len() as u32,
                &mut required,
                0,
            )
        };
        if ok == 0 || property_type != DEVPROP_TYPE_BYTE {
            continue;
        }
        let percent = data[0];
        if percent > 100 {
            continue;
        }

        let name = address
            .and_then(|address| connections.get(&address).map(|(_, name)| name.clone()))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| instance.clone());
        devices.push(BleDevice {
            id: instance,
            name,
            source: "windows",
            percent,
            charging: None,
            detail: None,
            components: Vec::new(),
            connected: true,
        });
    }

    // SAFETY: 设备信息集由本函数独占，释放一次。
    unsafe { SetupDiDestroyDeviceInfoList(device_info_set) };
    devices
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct FastPairComponent {
    percent: u8,
    charging: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct FastPairBattery {
    left: Option<FastPairComponent>,
    right: Option<FastPairComponent>,
    case: Option<FastPairComponent>,
}

impl FastPairComponent {
    fn label(&self) -> String {
        format!(
            "{}%{}",
            self.percent,
            if self.charging { " ⚡" } else { "" }
        )
    }
}

impl FastPairBattery {
    fn components(&self) -> Vec<BleComponent> {
        let mut result = Vec::new();
        if let Some(left) = self.left {
            result.push(BleComponent {
                label: "L".to_owned(),
                percent: left.percent,
                charging: left.charging,
            });
        }
        if let Some(right) = self.right {
            result.push(BleComponent {
                label: "R".to_owned(),
                percent: right.percent,
                charging: right.charging,
            });
        }
        if let Some(case) = self.case {
            result.push(BleComponent {
                label: "盒".to_owned(),
                percent: case.percent,
                charging: case.charging,
            });
        }
        result
    }

    fn detail(&self) -> String {
        let mut parts = Vec::new();
        if let Some(left) = self.left {
            parts.push(format!("L {}", left.label()));
        }
        if let Some(right) = self.right {
            parts.push(format!("R {}", right.label()));
        }
        if let Some(case) = self.case {
            parts.push(format!("盒 {}", case.label()));
        }
        parts.join(" · ")
    }

    fn display(&self) -> Option<(u8, bool)> {
        let components = [self.left, self.right, self.case]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let discharging = components
            .iter()
            .filter(|component| !component.charging)
            .min_by_key(|component| component.percent);
        if let Some(component) = discharging {
            return Some((component.percent, false));
        }
        components
            .iter()
            .min_by_key(|component| component.percent)
            .map(|component| (component.percent, true))
    }
}

fn fastpair_component(byte: u8) -> Option<FastPairComponent> {
    let percent = byte & 0x7F;
    if percent > 100 {
        return None;
    }
    Some(FastPairComponent {
        percent,
        charging: byte & 0x80 != 0,
    })
}

fn parse_fastpair_payload(data: &[u8]) -> Option<FastPairBattery> {
    // Fast Pair "Battery Notification": service data version 0, then TLV.
    if data.len() < 2 || data[0] != 0x00 {
        return None;
    }
    let mut index = 1;
    while index < data.len() {
        let header = data[index];
        let length = usize::from(header >> 4);
        let kind = header & 0x0F;
        if index + 1 + length > data.len() {
            return None;
        }
        if (kind == 3 || kind == 4) && length >= 1 {
            let left = fastpair_component(data[index + 1]);
            let right = (length >= 2)
                .then(|| fastpair_component(data[index + 2]))
                .flatten();
            let case = (length >= 3)
                .then(|| fastpair_component(data[index + 3]))
                .flatten();
            let battery = FastPairBattery { left, right, case };
            if battery.display().is_some() {
                return Some(battery);
            }
        }
        index += 1 + length;
    }
    None
}

fn parse_fastpair_section(data: &[u8]) -> Option<FastPairBattery> {
    // Some WinRT builds leave the 16-bit UUID in the data section.
    if data.len() >= 2 && data[0] == 0x2C && data[1] == 0xFE {
        return parse_fastpair_payload(&data[2..]);
    }
    parse_fastpair_payload(data)
}

fn fastpair_battery(advertisement: &BluetoothLEAdvertisement) -> Option<FastPairBattery> {
    let sections = advertisement.GetSectionsByType(0x16).ok()?;
    for index in 0..sections.Size().ok()? {
        let Ok(section) = sections.GetAt(index) else {
            continue;
        };
        let section: BluetoothLEAdvertisementDataSection = section;
        let Ok(buffer) = section.Data() else {
            continue;
        };
        let Ok(reader) = DataReader::FromBuffer(&buffer) else {
            continue;
        };
        let Ok(length) = reader.UnconsumedBufferLength() else {
            continue;
        };
        let mut data = vec![0u8; length as usize];
        if reader.ReadBytes(&mut data).is_err() {
            continue;
        }
        if let Some(battery) = parse_fastpair_section(&data) {
            return Some(battery);
        }
    }
    None
}

#[derive(Debug, Clone, Default)]
struct FastPairScanDiagnostics {
    advertisements: u32,
    error: Option<String>,
}

fn fastpair_scan(
    connections: &HashMap<u64, (bool, String)>,
) -> (Vec<BleDevice>, FastPairScanDiagnostics) {
    if connections.is_empty() {
        return (Vec::new(), FastPairScanDiagnostics::default());
    }
    let Ok(watcher) = BluetoothLEAdvertisementWatcher::new() else {
        return (
            Vec::new(),
            FastPairScanDiagnostics {
                advertisements: 0,
                error: Some("无法创建 BLE 广播 watcher".to_owned()),
            },
        );
    };
    let found = Arc::new(Mutex::new(HashMap::<u64, FastPairBattery>::new()));
    let diagnostics = Arc::new(Mutex::new(FastPairScanDiagnostics::default()));
    let sink = Arc::clone(&found);
    let diag_sink = Arc::clone(&diagnostics);
    let handler = TypedEventHandler::new(
        move |_sender, args: windows::core::Ref<BluetoothLEAdvertisementReceivedEventArgs>| {
            let Some(args) = args.as_ref() else {
                return Ok(());
            };
            if let Ok(mut diagnostic) = diag_sink.lock() {
                diagnostic.advertisements += 1;
            }
            let Ok(address) = args.BluetoothAddress() else {
                return Ok(());
            };
            let Ok(advertisement) = args.Advertisement() else {
                return Ok(());
            };
            if let Some(battery) = fastpair_battery(&advertisement) {
                if let Ok(mut map) = sink.lock() {
                    map.insert(address, battery);
                }
            }
            Ok(())
        },
    );
    if watcher.Received(&handler).is_err() {
        if let Ok(mut diagnostic) = diagnostics.lock() {
            diagnostic.error = Some("BLE 广播事件订阅失败".to_owned());
        }
        return (
            Vec::new(),
            diagnostics
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default(),
        );
    }
    let _ = watcher.SetScanningMode(BluetoothLEScanningMode::Active);
    if watcher.Start().is_err() {
        if let Ok(mut diagnostic) = diagnostics.lock() {
            diagnostic.error = Some("BLE 广播扫描启动失败".to_owned());
        }
        return (
            Vec::new(),
            diagnostics
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default(),
        );
    }
    std::thread::sleep(Duration::from_millis(2000));
    let _ = watcher.Stop();

    let diagnostic = diagnostics
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let mut devices = Vec::new();
    let Ok(map) = found.lock() else {
        return (devices, diagnostic);
    };
    for (address, battery) in map.iter() {
        let Some((connected, name)) = connections.get(address) else {
            continue;
        };
        if !*connected {
            continue;
        }
        let Some((percent, charging)) = battery.display() else {
            continue;
        };
        devices.push(BleDevice {
            id: format!("fastpair:{address:012X}"),
            name: if name.is_empty() {
                "Fast Pair earbuds".to_owned()
            } else {
                name.clone()
            },
            source: "fastpair",
            percent,
            charging: Some(charging),
            detail: Some(battery.detail()),
            components: battery.components(),
            connected: true,
        });
    }
    (devices, diagnostic)
}

/// 从实例 id 中提取 12 位十六进制蓝牙地址（`DEV_<addr>` 或 `...&0&<addr>_...`）。
fn bluetooth_address_of(instance: &str) -> Option<u64> {
    let upper = instance.to_ascii_uppercase();
    for marker in ["DEV_", "&0&"] {
        let mut search_from = 0usize;
        while let Some(offset) = upper[search_from..].find(marker) {
            let start = search_from + offset + marker.len();
            if start + 12 <= upper.len() {
                let candidate = &upper[start..start + 12];
                if candidate.chars().all(|ch| ch.is_ascii_hexdigit()) {
                    if let Ok(value) = u64::from_str_radix(candidate, 16) {
                        return Some(value);
                    }
                }
            }
            search_from = start;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::parse_fastpair_section;

    #[test]
    fn parses_fast_pair_battery_components() {
        // version + TLV type 3 len 3: left 100%, right invalid, case 80%.
        let battery =
            parse_fastpair_section(&[0x00, 0x33, 0x64, 0x70, 0x50]).expect("battery should parse");
        assert_eq!(battery.left.map(|c| c.percent), Some(100));
        assert_eq!(battery.right, None);
        assert_eq!(battery.case.map(|c| c.percent), Some(80));
        assert_eq!(battery.display(), Some((80, false)));
    }

    #[test]
    fn accepts_service_uuid_prefix_and_charging_bits() {
        let battery = parse_fastpair_section(&[0x2C, 0xFE, 0x00, 0x33, 0xE4, 0x50, 0x7F])
            .expect("battery should parse");
        assert_eq!(battery.left.map(|c| c.percent), Some(100));
        assert!(battery.left.is_some_and(|c| c.charging));
        assert_eq!(battery.right.map(|c| c.percent), Some(80));
        assert_eq!(battery.display(), Some((80, false)));
    }

    #[test]
    fn ignores_discoverable_model_id_only() {
        assert!(parse_fastpair_section(&[0x01, 0x02, 0x03]).is_none());
    }
}
