const KEYCHAIN_SERVICE: &str = "dev.coupletalk.app";

/// Returns this install's device key from the OS credential store, saving `fresh` if none exists yet.
/// It peppers the lock-password wrap so a copy of app storage alone can't be brute-forced offline.
#[tauri::command]
fn device_key(fresh: Vec<u8>) -> Result<Vec<u8>, String> {
    device_key_in(KEYCHAIN_SERVICE, fresh)
}

fn device_key_in(service: &str, fresh: Vec<u8>) -> Result<Vec<u8>, String> {
    let entry = keyring::Entry::new(service, "device-key").map_err(|e| e.to_string())?;
    match entry.get_secret() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => entry.set_secret(&fresh).map(|_| fresh).map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
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
        let first = super::device_key_in(service, vec![1; 32]).unwrap();
        let second = super::device_key_in(service, vec![2; 32]).unwrap();
        keyring::Entry::new(service, "device-key").unwrap().delete_credential().unwrap();
        assert_eq!(first, vec![1; 32]);
        assert_eq!(second, first);
    }
}
