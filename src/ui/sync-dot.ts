import { onSyncStatus, type SyncState } from '../sync/service.ts';
import { h } from './dom.ts';

const LABEL: Record<SyncState, string> = {
  unconfigured: '',
  loading: 'Sincronización: iniciando…',
  'signed-out': 'Sincronización desactivada: inicia sesión en Ajustes',
  idle: 'Sincronizado',
  syncing: 'Sincronizando…',
  offline: 'Sin conexión: los cambios se subirán al volver',
  error: 'Error de sincronización: ver Ajustes',
};

/**
 * Small status dot in the header, linking to the sync settings. Hidden when
 * sync isn't configured, so a local-only install looks exactly as before.
 */
export function renderSyncDot(): HTMLElement {
  const dot = h('a', { class: 'sync-dot', href: '#/ajustes', role: 'status' });
  onSyncStatus((status) => {
    dot.hidden = status.state === 'unconfigured';
    dot.dataset.state = status.state;
    const pending = status.pending > 0 && status.state !== 'syncing' ? ` · ${status.pending} cambios pendientes` : '';
    const label = LABEL[status.state] + pending;
    dot.title = label;
    dot.setAttribute('aria-label', label);
  });
  return dot;
}
