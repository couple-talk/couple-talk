const KEYCHAIN_SERVICE: &str = "dev.coupletalk.app";

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![device_key])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
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
