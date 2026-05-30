use tauri_plugin_shell::ShellExt;
use std::sync::{Arc, Mutex};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let backend_process = Arc::new(Mutex::new(None));
  let backend_process_clone = Arc::clone(&backend_process);

  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(move |app| {
      // Registra o plugin de logs tanto em dev quanto em produção para termos diagnóstico
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;

      // Inicia o sidecar do backend em produção (em dev, rodamos o python de forma independente)
      #[cfg(not(debug_assertions))]
      {
        match app.shell().sidecar("backend") {
          Ok(sidecar) => {
            // Desativa a abertura automática do navegador e garante a porta 8000
            let sidecar = sidecar
              .args(["--port", "8000"])
              .env("FORM_PRO_NO_BROWSER", "1");

            match sidecar.spawn() {
              Ok((_rx, child)) => {
                let mut process = backend_process_clone.lock().unwrap();
                *process = Some(child);
                log::info!("Sidecar 'backend' iniciado com sucesso.");
              }
              Err(e) => {
                log::error!("Falha ao dar spawn no sidecar 'backend': {:?}", e);
              }
            }
          }
          Err(e) => {
            log::error!("Falha ao resolver o sidecar 'backend': {:?}", e);
          }
        }
      }

      Ok(())
    })
    .on_window_event(move |_window, event| {
      // Quando a janela principal é destruída, mata o processo do backend
      if let tauri::WindowEvent::Destroyed = event {
        let mut process = backend_process.lock().unwrap();
        if let Some(child) = process.take() {
          let _ = child.kill();
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
