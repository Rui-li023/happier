#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    App, AppHandle, Manager, Runtime,
};

#[cfg(desktop)]
use crate::menu::{OPEN_UPDATES_MENU_ID, QUIT_APP_MENU_ID, SHOW_MAIN_WINDOW_MENU_ID};

#[cfg(desktop)]
use serde::Deserialize;

#[cfg(desktop)]
const TRAY_ICON_ID: &str = "main";
/// The tray shows only the Happier mark; status lives in the menu it opens, so the icon never
/// grows a title. macOS gets a template image the menu bar tints for light and dark bars
/// (tray-icon draws it 18pt tall; 36px is its @2x). Windows and Linux get 32px images picked by the
/// tray's own theme: the full-colour mark on a light tray, a white silhouette on a dark one, where
/// the dark bag would vanish. All are rendered from `icons/AppIcon.icon/Assets/*.svg` by
/// `node scripts/generateTrayIcons.mjs`.
#[cfg(target_os = "macos")]
const TRAY_ICON: Image<'static> = tauri::include_image!("./icons/tray/tray-template.png");
#[cfg(all(desktop, not(target_os = "macos")))]
const TRAY_ICON_FOR_LIGHT_TRAY: Image<'static> = tauri::include_image!("./icons/tray/tray.png");
#[cfg(all(desktop, not(target_os = "macos")))]
const TRAY_ICON_FOR_DARK_TRAY: Image<'static> = tauri::include_image!("./icons/tray/tray-dark.png");
#[cfg(desktop)]
const TRAY_TOOLTIP: &str = "Happier";
/// The tray is how Windows and Linux reach Quit at all: they get no app menu, and closing the main
/// window only hides it. It is also the only way to bring that window back on those platforms.
#[cfg(desktop)]
const DESKTOP_TRAY_ENABLED: bool = true;

#[cfg(desktop)]
fn is_desktop_tray_enabled_for_build() -> bool {
    DESKTOP_TRAY_ENABLED
}

#[cfg(desktop)]
pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    if !is_desktop_tray_enabled_for_build() {
        return Ok(());
    }

    let initial_state = DesktopTrayStatePayload {
        label: "Happier".to_string(),
        detail: "Checking connection".to_string(),
        open_label: default_open_label(),
        quit_label: default_quit_label(),
        updates_label: None,
        updates_enabled: None,
    };

    #[cfg(target_os = "macos")]
    let icon = TRAY_ICON;
    #[cfg(target_os = "windows")]
    let icon = tray_icon_for(windows_tray_theme());
    // The portal answers asynchronously; until it does the theme is unknown.
    #[cfg(target_os = "linux")]
    let icon = tray_icon_for(TrayThemeSignal::FreedesktopColorScheme(None));

    // No click handler: every platform opens the menu on click (Linux can only ever do that), and
    // the menu's Open item is how the hidden main window comes back.
    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip(TRAY_TOOLTIP)
        .menu(&build_menu(app, &initial_state)?)
        .show_menu_on_left_click(true)
        .build(app)?;

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    follow_tray_theme(app);

    Ok(())
}

/// The tray's own theme as its platform reports it. macOS needs none: AppKit tints the template.
#[cfg(any(test, all(desktop, not(target_os = "macos"))))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayThemeSignal {
    /// `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\SystemUsesLightTheme`:
    /// the taskbar follows the Windows (system) mode, which can differ from the app mode
    /// (`AppsUseLightTheme`). `None` when the value is absent or unreadable.
    #[cfg(any(test, target_os = "windows"))]
    WindowsSystemUsesLightTheme(Option<u32>),
    /// The freedesktop settings portal's `org.freedesktop.appearance` `color-scheme`: 0 no
    /// preference, 1 prefer dark, 2 prefer light; unknown values mean 0. `None` without a portal.
    #[cfg(any(test, target_os = "linux"))]
    FreedesktopColorScheme(Option<u32>),
}

/// Whether the tray is known to be light, so the full-colour mark reads on it. Anything unknown
/// counts as dark and gets the white silhouette: Windows without the value predates the light
/// taskbar, and most Linux panels are dark — GNOME's stays dark in every style, and its settings
/// only ever report "no preference" or "prefer dark".
#[cfg(any(test, all(desktop, not(target_os = "macos"))))]
fn tray_is_light(signal: TrayThemeSignal) -> bool {
    match signal {
        #[cfg(any(test, target_os = "windows"))]
        TrayThemeSignal::WindowsSystemUsesLightTheme(value) => {
            value.is_some_and(|value| value != 0)
        }
        #[cfg(any(test, target_os = "linux"))]
        TrayThemeSignal::FreedesktopColorScheme(value) => value == Some(2),
    }
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn tray_icon_for(signal: TrayThemeSignal) -> Image<'static> {
    if tray_is_light(signal) {
        TRAY_ICON_FOR_LIGHT_TRAY
    } else {
        TRAY_ICON_FOR_DARK_TRAY
    }
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn set_tray_icon_for<R: Runtime>(app: &AppHandle<R>, signal: TrayThemeSignal) {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };
    if let Err(error) = tray.set_icon(Some(tray_icon_for(signal))) {
        log::warn!("failed to switch the tray icon to the tray theme: {error}");
    }
}

#[cfg(target_os = "windows")]
fn windows_tray_theme() -> TrayThemeSignal {
    let value = windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_u32("SystemUsesLightTheme"))
        .inspect_err(|error| log::info!("tray theme unknown, using the dark-tray icon: {error}"))
        .ok();
    TrayThemeSignal::WindowsSystemUsesLightTheme(value)
}

/// Re-reads the taskbar mode on `ThemeChanged`, which tao raises from `WM_SETTINGCHANGE` when the
/// app mode flips. That is the only theme-change signal this process receives, so a Custom-mode
/// switch of the Windows mode alone shows up at the next app-mode switch or launch.
#[cfg(target_os = "windows")]
fn follow_tray_theme<R: Runtime>(app: &mut App<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
            set_tray_icon_for(&handle, windows_tray_theme());
        }
    });
}

/// Reads the portal's `color-scheme` once and follows its `SettingChanged` signal, both on the
/// GTK main context (no thread, no polling). Uses `Read` rather than `ReadOne` (portal v2) so
/// older portals answer too; `Read` wraps the value in an extra variant, hence the unwrap loop.
#[cfg(target_os = "linux")]
fn follow_tray_theme<R: Runtime>(app: &mut App<R>) {
    use gtk::{gio, glib, glib::ToVariant};

    const PORTAL: &str = "org.freedesktop.portal.Desktop";
    const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
    const SETTINGS: &str = "org.freedesktop.portal.Settings";
    const APPEARANCE: &str = "org.freedesktop.appearance";
    const COLOR_SCHEME: &str = "color-scheme";

    fn color_scheme(mut value: glib::Variant) -> Option<u32> {
        while value.type_() == glib::VariantTy::VARIANT {
            value = value.as_variant()?;
        }
        value.get::<u32>()
    }

    let handle = app.handle().clone();
    gio::bus_get(gio::BusType::Session, gio::Cancellable::NONE, move |bus| {
        let bus = match bus {
            Ok(bus) => bus,
            Err(error) => {
                log::info!("tray theme unknown (no session bus): {error}");
                return;
            }
        };

        let on_change = handle.clone();
        // The closure owns a connection clone, which keeps the shared session bus alive for as
        // long as the subscription (the app's lifetime).
        let kept_bus = bus.clone();
        bus.signal_subscribe(
            Some(PORTAL),
            Some(SETTINGS),
            Some("SettingChanged"),
            Some(PORTAL_PATH),
            Some(APPEARANCE),
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, parameters| {
                let _keep_alive = &kept_bus;
                if let Some((_, key, value)) = parameters.get::<(String, String, glib::Variant)>() {
                    if key == COLOR_SCHEME {
                        let signal = TrayThemeSignal::FreedesktopColorScheme(color_scheme(value));
                        set_tray_icon_for(&on_change, signal);
                    }
                }
            },
        );

        bus.call(
            Some(PORTAL),
            PORTAL_PATH,
            SETTINGS,
            "Read",
            Some(&(APPEARANCE, COLOR_SCHEME).to_variant()),
            glib::VariantTy::new("(v)").ok(),
            gio::DBusCallFlags::NONE,
            -1,
            gio::Cancellable::NONE,
            move |reply| {
                let value = match reply {
                    Ok(reply) => color_scheme(reply.child_value(0)),
                    Err(error) => {
                        log::info!("tray theme unknown (no settings portal): {error}");
                        None
                    }
                };
                set_tray_icon_for(&handle, TrayThemeSignal::FreedesktopColorScheme(value));
            },
        );
    });
}

#[cfg(desktop)]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTrayStatePayload {
    /// The menu's status line, "label · detail". Unknown fields (the retired `status`) are ignored.
    pub label: String,
    pub detail: String,
    /// The menu labels, localized by the app (U14). The English defaults only cover the frames
    /// before the app's first update and an app that does not send them.
    #[serde(default = "default_open_label")]
    pub open_label: String,
    #[serde(default = "default_quit_label")]
    pub quit_label: String,
    /// "Updates available (3)…" — present only while there is an update to act on. Absent (older
    /// apps, nothing to update) means no item.
    #[serde(default)]
    pub updates_label: Option<String>,
    /// `false` while the item only reports ("Updating…"). Absent (older apps) = enabled.
    #[serde(default)]
    pub updates_enabled: Option<bool>,
}

#[cfg(desktop)]
fn default_open_label() -> String {
    "Open Happier".to_string()
}

#[cfg(desktop)]
fn default_quit_label() -> String {
    "Quit Happier".to_string()
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_set_tray_state<R: Runtime>(
    app: AppHandle<R>,
    state: DesktopTrayStatePayload,
) -> Result<(), String> {
    if !is_desktop_tray_enabled_for_build() {
        return Ok(());
    }

    apply_tray_state(&app, &state).map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn apply_tray_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &DesktopTrayStatePayload,
) -> tauri::Result<()> {
    let tray = app
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;

    tray.set_menu(Some(build_menu(app, state)?))?;
    Ok(())
}

#[cfg(desktop)]
fn build_menu<R: Runtime>(
    app: &impl Manager<R>,
    state: &DesktopTrayStatePayload,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let status_item = MenuItemBuilder::new(status_line(state))
        .enabled(false)
        .build(app)?;
    let show_main_window_item =
        MenuItemBuilder::with_id(SHOW_MAIN_WINDOW_MENU_ID, state.open_label.clone()).build(app)?;
    let quit_app =
        MenuItemBuilder::with_id(QUIT_APP_MENU_ID, state.quit_label.clone()).build(app)?;

    let mut menu = MenuBuilder::new(app).item(&status_item).separator();
    if let Some(label) = state
        .updates_label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
    {
        menu = menu.item(
            &MenuItemBuilder::with_id(OPEN_UPDATES_MENU_ID, label)
                .enabled(state.updates_enabled.unwrap_or(true))
                .build(app)?,
        );
    }
    menu.item(&show_main_window_item)
        .separator()
        .item(&quit_app)
        .build()
}

#[cfg(desktop)]
fn status_line(state: &DesktopTrayStatePayload) -> String {
    format!("{} · {}", state.label, state.detail)
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    #[test]
    fn tray_icon_follows_the_tray_theme_and_unknown_means_a_dark_tray() {
        use TrayThemeSignal::*;
        assert!(tray_is_light(WindowsSystemUsesLightTheme(Some(1))));
        assert!(!tray_is_light(WindowsSystemUsesLightTheme(Some(0))));
        assert!(!tray_is_light(WindowsSystemUsesLightTheme(None)));
        assert!(tray_is_light(FreedesktopColorScheme(Some(2))));
        assert!(!tray_is_light(FreedesktopColorScheme(Some(1))));
        assert!(!tray_is_light(FreedesktopColorScheme(Some(0))));
        assert!(!tray_is_light(FreedesktopColorScheme(Some(7))));
        assert!(!tray_is_light(FreedesktopColorScheme(None)));
    }

    #[test]
    fn every_desktop_build_ships_the_tray_so_quit_is_reachable() {
        // Windows and Linux have no other quit or re-show affordance: no app menu, and the main
        // window hides on close.
        assert!(is_desktop_tray_enabled_for_build());
    }

    #[test]
    fn tray_menu_labels_come_from_the_app_and_default_to_english() {
        let localized: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"status":"healthy","label":"Verbunden","detail":"Online","openLabel":"Happier öffnen","quitLabel":"Happier beenden"}"#,
        )
        .expect("payload parses");
        assert_eq!(localized.open_label, "Happier öffnen");
        assert_eq!(localized.quit_label, "Happier beenden");

        let older: DesktopTrayStatePayload =
            serde_json::from_str(r#"{"status":"healthy","label":"Connected","detail":"Online"}"#)
                .expect("payload without labels parses");
        assert_eq!(older.open_label, "Open Happier");
        assert_eq!(older.quit_label, "Quit Happier");
        assert_eq!(older.updates_label, None);

        let with_updates: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"label":"Connected","detail":"Online","updatesLabel":"Updates available (2)…"}"#,
        )
        .expect("payload with an updates item parses");
        assert_eq!(
            with_updates.updates_label.as_deref(),
            Some("Updates available (2)…")
        );
        assert_eq!(with_updates.updates_enabled, None);

        let reporting: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"label":"Connected","detail":"Online","updatesLabel":"Updating…","updatesEnabled":false}"#,
        )
        .expect("payload with a disabled updates item parses");
        assert_eq!(reporting.updates_enabled, Some(false));
    }

    #[test]
    fn the_menu_status_line_joins_label_and_detail() {
        let state: DesktopTrayStatePayload = serde_json::from_str(
            r#"{"label":"Connected","detail":"Online · 2/2","openLabel":"Open Happier","quitLabel":"Quit Happier"}"#,
        )
        .expect("payload without status parses");
        assert_eq!(status_line(&state), "Connected · Online · 2/2");
    }
}
