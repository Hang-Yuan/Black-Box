use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

pub const DESKTOP_PET_LABEL: &str = "desktop-pet";
pub const DESKTOP_PET_ENABLED_EVENT: &str = "blackbox://desktop-pet-enabled";

const PET_WIDTH: f64 = 172.0;
const PET_HEIGHT: f64 = 196.0;
const EDGE_MARGIN: i32 = 12;
const CONFIG_FILE: &str = "desktop-pet.json";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct DesktopPetConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    x: Option<i32>,
    #[serde(default)]
    y: Option<i32>,
    #[serde(default)]
    appearance: DesktopPetAppearance,
}

impl Default for DesktopPetConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            x: None,
            y: None,
            appearance: DesktopPetAppearance::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopPetDesign {
    pub name: String,
    pub body: String,
    pub body_color: String,
    pub accent_color: String,
    pub eyes: String,
    pub mouth: String,
    pub accessory: String,
    pub motion: String,
    pub scale: String,
    pub show_caption: bool,
}

impl Default for DesktopPetDesign {
    fn default() -> Self {
        Self {
            name: "我的伙伴".to_string(),
            body: "cat".to_string(),
            body_color: "#202B42".to_string(),
            accent_color: "#87B9FF".to_string(),
            eyes: "sparkle".to_string(),
            mouth: "cat".to_string(),
            accessory: "star".to_string(),
            motion: "float".to_string(),
            scale: "normal".to_string(),
            show_caption: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopPetAppearance {
    pub preset_id: String,
    pub custom: DesktopPetDesign,
}

impl Default for DesktopPetAppearance {
    fn default() -> Self {
        Self {
            preset_id: "hourglass".to_string(),
            custom: DesktopPetDesign::default(),
        }
    }
}

const PRESET_IDS: &[&str] = &[
    "hourglass",
    "midnight-cat",
    "aurora-cat",
    "amber-fox",
    "snow-rabbit",
    "mint-rabbit",
    "cocoa-bear",
    "polar-bear",
    "lavender-owl",
    "forest-owl",
    "brass-robot",
    "neon-robot",
    "rain-cloud",
    "sunset-cloud",
    "lime-slime",
    "berry-slime",
    "coral-axolotl",
    "ocean-axolotl",
    "lunar-spirit",
    "star-spirit",
    "custom",
];

fn normalized_choice(value: String, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value.as_str()) {
        value
    } else {
        fallback.to_string()
    }
}

fn normalized_color(value: String, fallback: &str) -> String {
    let valid = value.len() == 7
        && value.starts_with('#')
        && value
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit());
    if valid {
        value.to_ascii_uppercase()
    } else {
        fallback.to_string()
    }
}

impl DesktopPetDesign {
    fn normalized(mut self) -> Self {
        self.name = self.name.trim().chars().take(16).collect();
        if self.name.is_empty() {
            self.name = DesktopPetDesign::default().name;
        }
        self.body = normalized_choice(
            self.body,
            &[
                "hourglass",
                "cat",
                "fox",
                "rabbit",
                "bear",
                "owl",
                "robot",
                "cloud",
                "slime",
                "axolotl",
                "spirit",
            ],
            "cat",
        );
        self.body_color = normalized_color(self.body_color, "#202B42");
        self.accent_color = normalized_color(self.accent_color, "#87B9FF");
        self.eyes = normalized_choice(
            self.eyes,
            &["dot", "sparkle", "sleepy", "visor", "wink"],
            "sparkle",
        );
        self.mouth =
            normalized_choice(self.mouth, &["smile", "cat", "tiny", "flat", "none"], "cat");
        self.accessory = normalized_choice(
            self.accessory,
            &[
                "none", "crown", "bow", "leaf", "star", "glasses", "headset", "scarf", "antenna",
            ],
            "star",
        );
        self.motion =
            normalized_choice(self.motion, &["float", "bounce", "pulse", "orbit"], "float");
        self.scale = normalized_choice(self.scale, &["compact", "normal", "large"], "normal");
        self
    }
}

impl DesktopPetAppearance {
    fn normalized(mut self) -> Self {
        self.preset_id = normalized_choice(self.preset_id, PRESET_IDS, "hourglass");
        self.custom = self.custom.normalized();
        self
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetStatus {
    pub supported: bool,
    pub enabled: bool,
    pub visible: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub platform: String,
    pub appearance: DesktopPetAppearance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MonitorBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn platform_name() -> String {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
    .to_string()
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(CONFIG_FILE))
        .map_err(|error| format!("Failed to resolve desktop pet settings: {error}"))
}

fn read_config(app: &AppHandle) -> DesktopPetConfig {
    let Ok(path) = config_path(app) else {
        return DesktopPetConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return DesktopPetConfig::default();
    };
    serde_json::from_str(&raw)
        .map(|mut config: DesktopPetConfig| {
            config.appearance = config.appearance.normalized();
            config
        })
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &DesktopPetConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create desktop pet settings directory: {error}"))?;
    }
    let raw = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Failed to encode desktop pet settings: {error}"))?;
    fs::write(&path, raw).map_err(|error| format!("Failed to write desktop pet settings: {error}"))
}

fn monitor_bounds(window: &Window) -> Result<Vec<MonitorBounds>, String> {
    window
        .available_monitors()
        .map_err(|error| format!("Failed to inspect displays: {error}"))
        .map(|monitors| {
            monitors
                .into_iter()
                .map(|monitor| {
                    let work_area = monitor.work_area();
                    MonitorBounds {
                        x: work_area.position.x,
                        y: work_area.position.y,
                        width: i32::try_from(work_area.size.width).unwrap_or(i32::MAX),
                        height: i32::try_from(work_area.size.height).unwrap_or(i32::MAX),
                    }
                })
                .collect()
        })
}

fn bounds_for_monitor(monitor: &tauri::window::Monitor) -> MonitorBounds {
    let work_area = monitor.work_area();
    MonitorBounds {
        x: work_area.position.x,
        y: work_area.position.y,
        width: i32::try_from(work_area.size.width).unwrap_or(i32::MAX),
        height: i32::try_from(work_area.size.height).unwrap_or(i32::MAX),
    }
}

fn clamp_axis(desired: i32, start: i32, span: i32, window_span: i32) -> i32 {
    let minimum = start.saturating_add(EDGE_MARGIN);
    let maximum = start
        .saturating_add(span)
        .saturating_sub(window_span)
        .saturating_sub(EDGE_MARGIN);
    if maximum < minimum {
        start
    } else {
        desired.clamp(minimum, maximum)
    }
}

fn squared_distance_to_monitor(center_x: i64, center_y: i64, monitor: MonitorBounds) -> i128 {
    let left = i64::from(monitor.x);
    let top = i64::from(monitor.y);
    let right = left + i64::from(monitor.width.max(0));
    let bottom = top + i64::from(monitor.height.max(0));
    let dx = if center_x < left {
        left - center_x
    } else if center_x > right {
        center_x - right
    } else {
        0
    };
    let dy = if center_y < top {
        top - center_y
    } else if center_y > bottom {
        center_y - bottom
    } else {
        0
    };
    i128::from(dx) * i128::from(dx) + i128::from(dy) * i128::from(dy)
}

fn clamp_position_to_monitors(
    desired: PhysicalPosition<i32>,
    window_size: PhysicalSize<u32>,
    monitors: &[MonitorBounds],
) -> PhysicalPosition<i32> {
    let Some(monitor) = monitors.iter().copied().min_by_key(|monitor| {
        squared_distance_to_monitor(
            i64::from(desired.x) + i64::from(window_size.width) / 2,
            i64::from(desired.y) + i64::from(window_size.height) / 2,
            *monitor,
        )
    }) else {
        return desired;
    };
    let width = i32::try_from(window_size.width).unwrap_or(i32::MAX);
    let height = i32::try_from(window_size.height).unwrap_or(i32::MAX);
    PhysicalPosition::new(
        clamp_axis(desired.x, monitor.x, monitor.width, width),
        clamp_axis(desired.y, monitor.y, monitor.height, height),
    )
}

fn default_position(app: &AppHandle, window: &WebviewWindow) -> PhysicalPosition<i32> {
    let size = window
        .outer_size()
        .unwrap_or_else(|_| PhysicalSize::new(PET_WIDTH as u32, PET_HEIGHT as u32));
    let preferred = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(|monitor| bounds_for_monitor(&monitor));
    let Some(bounds) = preferred else {
        return PhysicalPosition::new(EDGE_MARGIN, EDGE_MARGIN);
    };
    PhysicalPosition::new(
        bounds
            .x
            .saturating_add(bounds.width)
            .saturating_sub(i32::try_from(size.width).unwrap_or(i32::MAX))
            .saturating_sub(EDGE_MARGIN),
        bounds
            .y
            .saturating_add(bounds.height)
            .saturating_sub(i32::try_from(size.height).unwrap_or(i32::MAX))
            .saturating_sub(EDGE_MARGIN),
    )
}

fn clamp_and_place(
    app: &AppHandle,
    window: &WebviewWindow,
    requested: Option<PhysicalPosition<i32>>,
) -> Result<PhysicalPosition<i32>, String> {
    let desired = requested.unwrap_or_else(|| default_position(app, window));
    let size = window
        .outer_size()
        .map_err(|error| format!("Failed to read desktop pet size: {error}"))?;
    let monitors = window
        .available_monitors()
        .map_err(|error| format!("Failed to inspect displays: {error}"))?
        .into_iter()
        .map(|monitor| bounds_for_monitor(&monitor))
        .collect::<Vec<_>>();
    let clamped = clamp_position_to_monitors(desired, size, &monitors);
    window
        .set_position(Position::Physical(clamped))
        .map_err(|error| format!("Failed to position desktop pet: {error}"))?;
    Ok(clamped)
}

fn create_or_show(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(DESKTOP_PET_LABEL) {
        let mut config = read_config(app);
        let requested = config
            .x
            .zip(config.y)
            .map(|(x, y)| PhysicalPosition::new(x, y));
        let clamped = clamp_and_place(app, &window, requested)?;
        config.enabled = true;
        config.x = Some(clamped.x);
        config.y = Some(clamped.y);
        let _ = save_config(app, &config);
        window
            .show()
            .map_err(|error| format!("Failed to show desktop pet: {error}"))?;
        return Ok(window);
    }

    let builder = WebviewWindowBuilder::new(
        app,
        DESKTOP_PET_LABEL,
        WebviewUrl::App("index.html?desktop-pet=1".into()),
    )
    .title("Black Box Desktop Pet")
    .inner_size(PET_WIDTH, PET_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(false)
    .prevent_overflow()
    .accept_first_mouse(true);

    let window = builder
        .build()
        .map_err(|error| format!("Failed to create desktop pet: {error}"))?;
    let mut config = read_config(app);
    let requested = config
        .x
        .zip(config.y)
        .map(|(x, y)| PhysicalPosition::new(x, y));
    let clamped = clamp_and_place(app, &window, requested)?;
    config.enabled = true;
    config.x = Some(clamped.x);
    config.y = Some(clamped.y);
    save_config(app, &config)?;
    window
        .show()
        .map_err(|error| format!("Failed to show desktop pet: {error}"))?;
    Ok(window)
}

fn current_status(app: &AppHandle) -> DesktopPetStatus {
    let config = read_config(app);
    let window = app.get_webview_window(DESKTOP_PET_LABEL);
    let current_position = window
        .as_ref()
        .and_then(|window| window.outer_position().ok());
    DesktopPetStatus {
        supported: cfg!(desktop),
        enabled: config.enabled,
        visible: window
            .as_ref()
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false),
        x: current_position.map(|position| position.x).or(config.x),
        y: current_position.map(|position| position.y).or(config.y),
        platform: platform_name(),
        appearance: config.appearance,
    }
}

fn publish_status(app: &AppHandle) {
    let _ = app.emit(DESKTOP_PET_ENABLED_EVENT, current_status(app));
}

pub fn restore_if_enabled(app: &AppHandle) {
    if !read_config(app).enabled {
        return;
    }
    if let Err(error) = create_or_show(app) {
        eprintln!("[BLACKBOX] desktop pet restore skipped: {error}");
    }
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) -> bool {
    if window.label() != DESKTOP_PET_LABEL {
        return false;
    }

    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let app = window.app_handle();
            let mut config = read_config(app);
            config.enabled = false;
            if let Ok(position) = window.outer_position() {
                config.x = Some(position.x);
                config.y = Some(position.y);
            }
            let _ = save_config(app, &config);
            let _ = window.destroy();
            publish_status(app);
        }
        WindowEvent::Moved(position) => {
            let app = window.app_handle();
            let size = window
                .outer_size()
                .unwrap_or_else(|_| PhysicalSize::new(PET_WIDTH as u32, PET_HEIGHT as u32));
            let monitors = monitor_bounds(window).unwrap_or_default();
            let clamped = clamp_position_to_monitors(*position, size, &monitors);
            if clamped != *position {
                let _ = window.set_position(Position::Physical(clamped));
            }
            let mut config = read_config(app);
            config.x = Some(clamped.x);
            config.y = Some(clamped.y);
            let _ = save_config(app, &config);
        }
        _ => {}
    }
    true
}

#[tauri::command]
pub fn get_desktop_pet_status(app: AppHandle) -> Result<DesktopPetStatus, String> {
    Ok(current_status(&app))
}

#[tauri::command]
pub fn set_desktop_pet_enabled(app: AppHandle, enabled: bool) -> Result<DesktopPetStatus, String> {
    let mut config = read_config(&app);
    config.enabled = enabled;
    save_config(&app, &config)?;

    if enabled {
        create_or_show(&app)?;
    } else if let Some(window) = app.get_webview_window(DESKTOP_PET_LABEL) {
        if let Ok(position) = window.outer_position() {
            config.x = Some(position.x);
            config.y = Some(position.y);
            save_config(&app, &config)?;
        }
        window
            .destroy()
            .map_err(|error| format!("Failed to close desktop pet: {error}"))?;
    }

    let status = current_status(&app);
    let _ = app.emit(DESKTOP_PET_ENABLED_EVENT, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn set_desktop_pet_appearance(
    app: AppHandle,
    appearance: DesktopPetAppearance,
) -> Result<DesktopPetStatus, String> {
    let mut config = read_config(&app);
    config.appearance = appearance.normalized();
    save_config(&app, &config)?;
    let status = current_status(&app);
    let _ = app.emit(DESKTOP_PET_ENABLED_EVENT, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    window
        .show()
        .map_err(|error| format!("Failed to show main window: {error}"))?;
    let _ = window.unminimize();
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus main window: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_position_to_monitors, DesktopPetAppearance, DesktopPetConfig, DesktopPetDesign,
        MonitorBounds, EDGE_MARGIN,
    };
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn keeps_pet_inside_the_selected_display_work_area() {
        let monitors = [MonitorBounds {
            x: 0,
            y: 24,
            width: 1440,
            height: 876,
        }];
        let clamped = clamp_position_to_monitors(
            PhysicalPosition::new(1400, 890),
            PhysicalSize::new(172, 196),
            &monitors,
        );
        assert_eq!(clamped.x, 1440 - 172 - EDGE_MARGIN);
        assert_eq!(clamped.y, 24 + 876 - 196 - EDGE_MARGIN);
    }

    #[test]
    fn supports_displays_to_the_left_of_the_primary_display() {
        let monitors = [
            MonitorBounds {
                x: -1920,
                y: 0,
                width: 1920,
                height: 1080,
            },
            MonitorBounds {
                x: 0,
                y: 24,
                width: 1440,
                height: 876,
            },
        ];
        let clamped = clamp_position_to_monitors(
            PhysicalPosition::new(-1918, 100),
            PhysicalSize::new(172, 196),
            &monitors,
        );
        assert_eq!(clamped.x, -1920 + EDGE_MARGIN);
        assert_eq!(clamped.y, 100);
    }

    #[test]
    fn recovers_to_nearest_display_after_a_display_is_removed() {
        let monitors = [MonitorBounds {
            x: 0,
            y: 24,
            width: 1440,
            height: 876,
        }];
        let clamped = clamp_position_to_monitors(
            PhysicalPosition::new(2300, 400),
            PhysicalSize::new(172, 196),
            &monitors,
        );
        assert_eq!(clamped.x, 1440 - 172 - EDGE_MARGIN);
        assert_eq!(clamped.y, 400);
    }

    #[test]
    fn anchors_oversized_windows_to_the_work_area_origin() {
        let monitors = [MonitorBounds {
            x: 100,
            y: 50,
            width: 120,
            height: 100,
        }];
        let clamped = clamp_position_to_monitors(
            PhysicalPosition::new(500, 500),
            PhysicalSize::new(172, 196),
            &monitors,
        );
        assert_eq!(clamped, PhysicalPosition::new(100, 50));
    }

    #[test]
    fn migrates_the_original_toggle_only_config_to_the_hourglass_preset() {
        let config: DesktopPetConfig =
            serde_json::from_str(r#"{"enabled":true,"x":20,"y":30}"#).unwrap();
        assert!(config.enabled);
        assert_eq!(config.appearance.preset_id, "hourglass");
        assert_eq!(config.appearance.custom.body, "cat");
        assert!(config.appearance.custom.show_caption);
    }

    #[test]
    fn normalizes_untrusted_appearance_fields_before_persisting() {
        let appearance = DesktopPetAppearance {
            preset_id: "missing".to_string(),
            custom: DesktopPetDesign {
                name: "  a very long desktop companion name  ".to_string(),
                body: "dragon".to_string(),
                body_color: "url(file:///tmp/private)".to_string(),
                accent_color: "#aabbcc".to_string(),
                eyes: "laser".to_string(),
                ..DesktopPetDesign::default()
            },
        }
        .normalized();

        assert_eq!(appearance.preset_id, "hourglass");
        assert_eq!(appearance.custom.name.chars().count(), 16);
        assert_eq!(appearance.custom.body, "cat");
        assert_eq!(appearance.custom.body_color, "#202B42");
        assert_eq!(appearance.custom.accent_color, "#AABBCC");
        assert_eq!(appearance.custom.eyes, "sparkle");
    }
}
