use parking_lot::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{Emitter, Manager, UriSchemeContext, UriSchemeResponder};

struct NuClearance(Mutex<Option<(String, String)>>); // (cf_clearance, user agent)

// keep in tray flag plus a handle to the menu checkmark so the tray toggle and
// the frontend command can keep the check in sync
#[cfg(desktop)]
struct TrayCtl {
    keep: Mutex<bool>,
    #[cfg(not(target_os = "macos"))]
    item: Mutex<Option<tauri::menu::CheckMenuItem<tauri::Wry>>>,
}

// one pooled client instead of a fresh tls stack per cover, redirects stay on the cdn host
// and never loop past the default hop budget
fn client() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 10 {
                        return attempt.stop();
                    }
                    if attempt.url().as_str().starts_with("https://cdn.novelupdates.com/") {
                        attempt.follow()
                    } else {
                        attempt.stop()
                    }
                }))
                .build()
                .ok()
        })
        .as_ref()
}

#[tauri::command]
async fn nu_refresh(app: tauri::AppHandle, ua: String) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    // cookies_for_url pumps the gtk loop so it has to run on the main thread
    let dispatched = app.run_on_main_thread(move || {
        // read the exact cookie set the browser would send to the cdn (cf_clearance plus __cf_bm and any
        // others), so the native fetch presents the same thing the webview does
        let header = handle
            .get_webview_window("main")
            .and_then(|w| {
                w.cookies_for_url("https://cdn.novelupdates.com/".parse().unwrap())
                    .ok()
            })
            .map(|cookies| {
                let names: Vec<&str> = cookies.iter().map(|c| c.name()).collect();
                log::info!("nu_refresh: cdn cookies {:?}", names);
                cookies
                    .iter()
                    .map(|c| format!("{}={}", c.name(), c.value()))
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .filter(|h| h.contains("cf_clearance"));
        let _ = tx.send(header);
    });
    if dispatched.is_err() {
        log::warn!("nu_refresh: main thread dispatch failed");
        return false;
    }
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Some(cookie)) => {
            log::info!(
                "nu_refresh: cookie header ready ({} chars), ua={}",
                cookie.len(),
                ua
            );
            *app.state::<NuClearance>().0.lock() = Some((cookie, ua));
            true
        }
        _ => {
            log::warn!("nu_refresh: no cf_clearance in the cdn cookie jar");
            false
        }
    }
}

fn nucover_response(app: &tauri::AppHandle, uri: &str) -> tauri::http::Response<Vec<u8>> {
    let fail = |code: u16| {
        tauri::http::Response::builder()
            .status(code)
            .body(Vec::new())
            .unwrap()
    };

    let target = match tauri::Url::parse(uri).ok().and_then(|u| {
        u.query_pairs()
            .find(|(k, _)| k == "u")
            .map(|(_, v)| v.into_owned())
    }) {
        Some(t) => t,
        None => return fail(400),
    };
    if !target.starts_with("https://cdn.novelupdates.com/") {
        return fail(403);
    }

    let (cookie, ua) = match app.state::<NuClearance>().0.lock().clone() {
        Some(c) => c,
        None => {
            log::warn!("nucover: no clearance cached yet for {}", target);
            return fail(503);
        }
    };

    let client = match client() {
        Some(c) => c,
        None => return fail(500),
    };
    let resp = client
        .get(&target)
        .header("Cookie", cookie)
        .header("User-Agent", ua)
        .header("Referer", "https://www.novelupdates.com/")
        .header("Accept", "image/avif,image/webp,image/*,*/*;q=0.8")
        .send();

    match resp {
        Ok(r) if r.status().is_success() => {
            let ct = r
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            match r.bytes() {
                Ok(b) => {
                    log::info!("nucover ok {} bytes {}", b.len(), target);
                    tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", ct)
                        .header("Cache-Control", "public, max-age=86400")
                        .body(b.to_vec())
                        .unwrap()
                }
                Err(_) => fail(502),
            }
        }
        Ok(r) => {
            log::warn!("nucover cdn returned {} for {}", r.status(), target);
            fail(r.status().as_u16())
        }
        Err(e) => {
            log::warn!("nucover fetch error {} for {}", e, target);
            fail(502)
        }
    }
}

// surface the main window over whatever has it covered
#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// the tray toggle flips the flag and mirrors the new state into local storage
// through an event so the frontend can persist it
#[cfg(all(desktop, not(target_os = "macos")))]
fn toggle_keep(app: &tauri::AppHandle) {
    let ctl = app.state::<TrayCtl>();
    let mut flag = ctl.keep.lock();
    *flag = !*flag;
    if let Some(item) = ctl.item.lock().as_ref() {
        let _ = item.set_checked(*flag);
    }
    let _ = app.emit("traykeep", *flag);
}

#[cfg(desktop)]
fn quit_app(app: &tauri::AppHandle) {
    // drop the tray so the icon leaves the panel before the process ends
    if let Some(tray) = app.remove_tray_by_id("main") {
        drop(tray);
    }
    app.exit(0);
}

// the linux tray backend panics inside its lazy loader when no appindicator
// library is present, probe the same two sonames up front so a missing tray
// degrades to a warning instead of taking the app down
#[cfg(desktop)]
fn tray_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        (unsafe { libloading::Library::new("libayatana-appindicator3.so.1").is_ok() })
            || unsafe { libloading::Library::new("libappindicator3.so.1").is_ok() }
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

// build the tray icon; creation can fail on linux when the appindicator
// library is missing, so callers degrade to plain quit on close
#[cfg(desktop)]
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<tauri::tray::TrayIcon> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};

    let menu = Menu::new(app)?;
    let open = MenuItem::with_id(app, "open", "Open Vellum", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Vellum", true, None::<&str>)?;
    menu.append(&open)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    // close to tray is a windows/linux behavior, the mac bar extra only opens and quits
    #[cfg(not(target_os = "macos"))]
    {
        let keep =
            CheckMenuItem::with_id(app, "keep", "Keep in tray when closed", true, false, None::<&str>)?;
        menu.append(&keep)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        *app.state::<TrayCtl>().item.lock() = Some(keep);
    }
    menu.append(&quit)?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let builder = tauri::tray::TrayIconBuilder::with_id("main")
        .menu(&menu)
        .icon(icon)
        .tooltip("Vellum")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            #[cfg(not(target_os = "macos"))]
            "keep" => toggle_keep(app),
            "quit" => quit_app(app),
            _ => {}
        });
    #[cfg(target_os = "macos")]
    let builder = builder.tray_icon_as_template(true);
    builder.build(app)
}

// sync the keep in tray flag from the frontend (local storage is the source of
// truth) and report whether the tray is actually available; on mac the flag is
// ignored because close to tray is a windows/linux behavior
#[cfg(desktop)]
#[tauri::command]
fn tray_keep(app: tauri::AppHandle, value: Option<bool>) -> bool {
    let ctl = app.state::<TrayCtl>();
    #[cfg(target_os = "macos")]
    let _ = (&ctl, value);
    #[cfg(not(target_os = "macos"))]
    if let Some(v) = value {
        *ctl.keep.lock() = v;
        if let Some(item) = ctl.item.lock().as_ref() {
            let _ = item.set_checked(v);
        }
    }
    app.tray_by_id("main").is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(NuClearance(Mutex::new(None)))
        .register_asynchronous_uri_scheme_protocol(
            "nucover",
            |ctx: UriSchemeContext<_>, request, responder: UriSchemeResponder| {
                let app = ctx.app_handle().clone();
                let uri = request.uri().to_string();
                std::thread::spawn(move || {
                    responder.respond(nucover_response(&app, &uri));
                });
            },
        );

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // a second launch surfaces the existing window instead of starting a second copy
            show_main(app);
        }))
        .invoke_handler(tauri::generate_handler![nu_refresh, tray_keep])
        .on_window_event(|window, event| {
            // close to tray hides instead of quitting when the tray is up and the flag is on
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();
                    let keep = *app.state::<TrayCtl>().keep.lock();
                    if cfg!(not(target_os = "macos")) && keep && app.tray_by_id("main").is_some() {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            }
        });

    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![nu_refresh]);

    builder
        .setup(|app| {
            // logger on in release too, so the nucover diagnostics land in the app log file
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            #[cfg(desktop)]
            {
                app.manage(TrayCtl {
                    keep: Mutex::new(false),
                    #[cfg(not(target_os = "macos"))]
                    item: Mutex::new(None),
                });
                // a missing appindicator on linux must not take the window down with it
                if tray_supported() {
                    if let Err(e) = build_tray(app.handle()) {
                        log::warn!("tray unavailable: {}", e);
                    }
                } else {
                    log::warn!("tray unavailable: appindicator library not found");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
