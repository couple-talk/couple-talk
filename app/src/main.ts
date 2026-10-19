import './style.css';
// Each screen's module binds its own buttons and forms when imported.
import './setup';
import './chat';
import './characters';
import './settings';
import { $, config, show } from './state';
import { setupMainWindow } from './tauri';

const DEFAULT_SERVER = import.meta.env.VITE_DEFAULT_SERVER ?? 'ws://localhost:8080';

setupMainWindow();

if (config) show('unlock');
else {
  $<HTMLInputElement>('#create-form [name=server]').value = DEFAULT_SERVER;
  show('setup');
}
