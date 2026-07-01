use std::sync::Mutex;
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

// the novelupdates cover cdn is cloudflare locked and sends a cross-origin-resource-policy header, so the
// webview can neither present a clearance from js nor render the image cross origin. a hidden webview solves
// the challenge, this command reads the resulting httpOnly cf_clearance out of the shared cookie jar, and the
// nucover protocol below refetches the image natively (past cors and corp) with that cookie
struct NuClearance(Mutex<Option<(String, String)>>); // (cf_clearance, user agent)

#[tauri::command]
async fn nu_refresh(app: tauri::AppHandle, ua: String) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    // cookies_for_url pumps the gtk loop so it has to run on the main thread
    let _ = app.run_on_main_thread(move || {
        let value = handle
            .get_webview_window("main")
            .and_then(|w| w.cookies_for_url("https://www.novelupdates.com/".parse().unwrap()).ok())
            .and_then(|cookies| {
                cookies
                    .into_iter()
                    .find(|c| c.name() == "cf_clearance")
                    .map(|c| c.value().to_string())
            });
        let _ = tx.send(value);
    });
    match rx.recv() {
        Ok(Some(clearance)) => {
            *app.state::<NuClearance>().0.lock().unwrap() = Some((clearance, ua));
            true
        }
        _ => false,
    }
}

fn nucover_response(app: &tauri::AppHandle, uri: &str) -> tauri::http::Response<Vec<u8>> {
    let fail = |code: u16| {
        tauri::http::Response::builder()
            .status(code)
            .body(Vec::new())
            .unwrap()
    };

    let target = match tauri::Url::parse(uri)
        .ok()
        .and_then(|u| u.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.into_owned()))
    {
        Some(t) => t,
        None => return fail(400),
    };
    if !target.starts_with("https://cdn.novelupdates.com/") {
        return fail(403);
    }

    let (clearance, ua) = match app.state::<NuClearance>().0.lock().unwrap().clone() {
        Some(c) => c,
        None => return fail(503),
    };

    let client = match reqwest::blocking::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return fail(500),
    };
    let resp = client
        .get(&target)
        .header("Cookie", format!("cf_clearance={}", clearance))
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
                Ok(b) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", ct)
                    .header("Cache-Control", "public, max-age=86400")
                    .body(b.to_vec())
                    .unwrap(),
                Err(_) => fail(502),
            }
        }
        Ok(r) => fail(r.status().as_u16()),
        Err(_) => fail(502),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        )
        .invoke_handler(tauri::generate_handler![nu_refresh])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
