use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, image::Image};
use tauri_plugin_notification::NotificationExt;

const KEYCHAIN_SERVICE: &str = "dev.coupletalk.app";
#[cfg(desktop)]
const TRAY_ID: &str = "main";
// One shortcut for both platforms; a configurable one can come later if it clashes with something (see setup_shortcut).
#[cfg(desktop)]
const HIDE_ALL_SHORTCUT: &str = "CmdOrCtrl+Shift+H";

/// Returns this install's device key from the OS credential store. With `fresh`, saves it if none exists yet;
/// without, a missing key is the error "missing" (unlock must not silently mint a new one).
/// It peppers the lock-password wrap so a copy of app storage alone can't be brute-forced offline.
#[tauri::command]
fn device_key(fresh: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    device_key_in(KEYCHAIN_SERVICE, fresh)
}

fn device_key_in(service: &str, fresh: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let entry = keyring::Entry::new(service, "device-key").map_err(|e| e.to_string())?;
    match (entry.get_secret(), fresh) {
        (Ok(key), _) => Ok(key),
        (Err(keyring::Error::NoEntry), Some(fresh)) => entry.set_secret(&fresh).map(|_| fresh).map_err(|e| e.to_string()),
        (Err(keyring::Error::NoEntry), None) => Err("missing".into()),
        (Err(e), _) => Err(e.to_string()),
    }
}

/// What the tray menu and the hide-all shortcut control (#5). The pets are shown when `pets_on && !stealth`;
/// the main window follows `stealth`, remembering whether it was open so "show again" doesn't pop it up unasked.
#[derive(Default)]
struct Visibility {
    pets_off: bool,
    stealth: bool,
    main_was_visible: bool,
}

#[derive(Default)]
struct Ui {
    vis: Mutex<Visibility>,
}

fn with_vis<T>(app: &AppHandle, f: impl FnOnce(&mut Visibility) -> T) -> T {
    let ui = app.state::<Ui>();
    let mut vis = ui.vis.lock().unwrap();
    f(&mut vis)
}

/// Pushes the current visibility to the windows. The pet windows hide themselves: they also hide the partner
/// pet until a partner exists, and only they know both reasons.
fn apply_visibility(app: &AppHandle) {
    let (pets, stealth, main_was_visible) = with_vis(app, |v| (!v.pets_off && !v.stealth, v.stealth, v.main_was_visible));
    let _ = app.emit_to("pet", "pets-visible", pets);
    let _ = app.emit_to("pet-me", "pets-visible", pets);
    if let Some(main) = app.get_webview_window("main") {
        if stealth {
            let _ = main.hide();
        } else if main_was_visible {
            let _ = main.show();
        }
    }
}

fn open_main(app: &AppHandle) {
    with_vis(app, |v| {
        v.stealth = false;
        v.main_was_visible = true;
    });
    apply_visibility(app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn toggle_stealth(app: &AppHandle) {
    let main_visible = app.get_webview_window("main").and_then(|w| w.is_visible().ok()).unwrap_or(false);
    with_vis(app, |v| {
        if !v.stealth {
            v.main_was_visible = main_visible;
        }
        v.stealth = !v.stealth;
    });
    apply_visibility(app);
}

/// Asked by a pet window when it starts, since an emit before it listens would be lost.
#[tauri::command]
fn pets_visible(app: AppHandle) -> bool {
    with_vis(&app, |v| !v.pets_off && !v.stealth)
}

/// Draws a red dot of the given size: the unread badge, alone on the taskbar or composited onto the tray icon.
fn dot(size: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let c = (size as f32 - 1.0) / 2.0;
    let r = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            // One pixel of anti-aliasing at the edge.
            let a = (r - d).clamp(0.0, 1.0);
            let i = ((y * size + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&[0xe8, 0x3d, 0x3d, (a * 255.0) as u8]);
        }
    }
    rgba
}

/// The app icon with a dot in the bottom-right corner, for the tray while something is unread.
fn icon_with_dot(icon: &Image<'_>) -> Image<'static> {
    let (w, h) = (icon.width(), icon.height());
    let mut rgba = icon.rgba().to_vec();
    let size = (w.min(h) / 2).max(4);
    let d = dot(size);
    for y in 0..size {
        for x in 0..size {
            let src = ((y * size + x) * 4) as usize;
            let a = d[src + 3] as u32;
            if a == 0 {
                continue;
            }
            let dst = (((h - size + y) * w + (w - size + x)) * 4) as usize;
            for k in 0..3 {
                rgba[dst + k] = ((d[src + k] as u32 * a + rgba[dst + k] as u32 * (255 - a)) / 255) as u8;
            }
            rgba[dst + 3] = (a + rgba[dst + 3] as u32 * (255 - a) / 255).min(255) as u8;
        }
    }
    Image::new_owned(rgba, w, h)
}

/// Unread partner messages, from the chat window: shown as a dock badge (macOS), a taskbar overlay (Windows)
/// and a dot on the tray icon. The count never includes message text.
#[tauri::command]
fn set_unread(app: AppHandle, n: i64) {
    let badge = if n > 0 { Some(n) } else { None };
    if let Some(main) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        let _ = main.set_overlay_icon(badge.map(|_| Image::new_owned(dot(16), 16, 16)));
        #[cfg(not(target_os = "windows"))]
        let _ = main.set_badge_count(badge);
    }
    #[cfg(desktop)]
    if let (Some(tray), Some(icon)) = (app.tray_by_id(TRAY_ID), app.default_window_icon()) {
        let _ = tray.set_icon(Some(if badge.is_some() { icon_with_dot(icon) } else { icon.clone() }));
        let _ = tray.set_tooltip(Some(match badge {
            Some(n) => format!("couple-talk: 안 읽은 메시지 {n}개"),
            None => "couple-talk".to_string(),
        }));
    }
}

/// OS notification for a new message. Without `body` only "새 메시지가 왔어요" is shown, which is the default:
/// the text may be on a screen someone else can see. While everything is hidden with the shortcut nothing is
/// shown at all (that is what the shortcut is for); the badge still counts.
/// Same as the tray's 종료. Destroying the windows from JS stops at the main window: the page running the loop goes with it.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn notify(app: AppHandle, body: Option<String>) -> Result<(), String> {
    if with_vis(&app, |v| v.stealth) {
        return Ok(());
    }
    app.notification()
        .builder()
        .title("couple-talk")
        .body(body.unwrap_or_else(|| "새 메시지가 왔어요".to_string()))
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "열기", true, None::<&str>)?;
    let pets = MenuItem::with_id(app, "pets", "캐릭터 숨기기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pets, &quit])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID).menu(&menu).tooltip("couple-talk").show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(move |app, e| match e.id.as_ref() {
        "open" => open_main(app),
        "pets" => {
            let off = with_vis(app, |v| {
                v.pets_off = !v.pets_off;
                v.pets_off
            });
            let _ = pets.set_text(if off { "캐릭터 보이기" } else { "캐릭터 숨기기" });
            apply_visibility(app);
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;
    Ok(())
}

/// Registers the hide-all shortcut. Another program may already own the key combination (RegisterHotKey fails
/// on Windows then), so a failure only loses the shortcut, never the app: the tray menu still works.
#[cfg(desktop)]
fn setup_shortcut(app: &AppHandle) -> tauri::Result<()> {
    use tauri_plugin_global_shortcut::{Builder, GlobalShortcutExt, ShortcutState};
    app.plugin(Builder::new().build())?;
    let registered = app.global_shortcut().on_shortcut(HIDE_ALL_SHORTCUT, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_stealth(app);
        }
    });
    if let Err(e) = registered {
        eprintln!("hide-all shortcut {HIDE_ALL_SHORTCUT} unavailable: {e}");
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Ui::default())
        .invoke_handler(tauri::generate_handler![device_key, pets_visible, set_unread, notify, quit])
        .setup(|app| {
            #[cfg(desktop)]
            {
                setup_tray(app.handle())?;
                setup_shortcut(app.handle())?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[test]
    fn dot_is_round_and_opaque_in_the_middle() {
        let d = super::dot(16);
        let px = |x: usize, y: usize| d[(y * 16 + x) * 4 + 3];
        assert_eq!(px(8, 8), 255);
        assert_eq!(px(0, 0), 0);
        assert_eq!(px(15, 15), 0);
        assert!(px(8, 1) > 0);
    }

    #[test]
    fn dot_is_composited_into_the_corner_only() {
        let base = tauri::image::Image::new_owned(vec![0x10; 32 * 32 * 4], 32, 32);
        let out = super::icon_with_dot(&base);
        let px = |x: usize, y: usize| &out.rgba()[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(px(0, 0), &[0x10; 4]);
        assert_eq!(px(24, 24), &[0xe8, 0x3d, 0x3d, 0xff]);
    }

    // Touches the real OS keychain (under a separate service), so it only runs on demand:
    // cargo test --lib -- --ignored
    #[test]
    #[ignore]
    fn device_key_is_created_once_then_reused() {
        let service = "dev.coupletalk.app.test";
        let missing = super::device_key_in(service, None);
        let first = super::device_key_in(service, Some(vec![1; 32])).unwrap();
        let second = super::device_key_in(service, Some(vec![2; 32])).unwrap();
        let read = super::device_key_in(service, None).unwrap();
        keyring::Entry::new(service, "device-key").unwrap().delete_credential().unwrap();
        assert_eq!(missing, Err("missing".to_string()));
        assert_eq!(first, vec![1; 32]);
        assert_eq!(second, first);
        assert_eq!(read, first);
    }
}
