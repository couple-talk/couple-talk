import './style.css';
// Each screen's module binds its own buttons and forms when imported.
import './setup';
import './chat';
import './characters';
import { $, config, show } from './state';
import { isTauri, quitApp, setupMainWindow } from './tauri';

const DEFAULT_SERVER = import.meta.env.VITE_DEFAULT_SERVER ?? 'ws://localhost:8080';

$('#quit').hidden = !isTauri;
$('#quit').onclick = quitApp;
setupMainWindow();

if (config) show('unlock');
else {
  $<HTMLInputElement>('#create-form [name=server]').value = DEFAULT_SERVER;
  show('setup');
}
