import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { requestPersistence } from './core/storage.ts';
import { toast } from './ui/dom.ts';
import { startApp } from './ui/app.ts';

// Silent auto-update: a new version installs in the background and activates
// on the next visit. In dev the virtual module is a no-op.
registerSW({ immediate: true });

// Protect the study database from storage eviction (Safari's 7-day rule, disk
// pressure). Fire-and-forget: the app works the same either way.
void requestPersistence();

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection:', event.reason);
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
  toast(`Error inesperado: ${message}`, 'error');
});

const mount = document.getElementById('app');
if (mount) startApp(mount);
