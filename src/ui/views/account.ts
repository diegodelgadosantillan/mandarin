import { exportAll } from '../../backup/backup.ts';
import { db } from '../../db/db.ts';
import {
  describeError,
  onSyncStatus,
  requestSync,
  resetPassword,
  signIn,
  signOutSync,
  signUp,
  type SyncStatus,
} from '../../sync/service.ts';
import { clear, h, plural, toast } from '../dom.ts';
import { saveFile } from '../save-file.ts';

function formatWhen(ms: number | null): string {
  if (!ms) return 'todavía no';
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  return new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Before the first sign-in on a device that already has data, offer a backup.
 * Sync merges rather than overwrites, but a copy in hand costs nothing.
 */
async function offerBackupFirst(): Promise<void> {
  if ((await db.cards.count()) === 0) return;
  const wants = confirm(
    'Este dispositivo ya tiene tarjetas. Al iniciar sesión se combinarán con las de tu cuenta (en cada tarjeta gana la versión más reciente; no se borra nada).\n\n¿Quieres guardar antes una copia de seguridad?',
  );
  if (!wants) return;
  const backup = await exportAll();
  const date = new Date().toISOString().slice(0, 10);
  await saveFile(new Blob([JSON.stringify(backup)], { type: 'application/json' }), `mandarin-antes-de-sincronizar-${date}.json`);
}

function signedOutForm(): HTMLElement {
  const email = h('input', { type: 'email', autocomplete: 'email', id: 'sync-email', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', id: 'sync-password', required: true });
  const message = h('p', { class: 'deck__meta', 'aria-live': 'polite' });

  const buttons: HTMLButtonElement[] = [];
  async function attempt(action: 'in' | 'up'): Promise<void> {
    message.textContent = '';
    if (!email.value.trim() || !password.value) {
      message.textContent = 'Escribe tu correo y una contraseña.';
      return;
    }
    buttons.forEach((b) => (b.disabled = true));
    try {
      await offerBackupFirst();
      if (action === 'in') await signIn(email.value, password.value);
      else await signUp(email.value, password.value);
      toast(action === 'in' ? 'Sesión iniciada. Sincronizando…' : 'Cuenta creada. Sincronizando…');
    } catch (error) {
      message.textContent = describeError(error);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  const signInButton = h('button', { class: 'btn btn--primary', type: 'submit' }, 'Entrar');
  const signUpButton = h('button', { class: 'btn', type: 'button', onclick: () => void attempt('up') }, 'Crear cuenta');
  const resetButton = h(
    'button',
    {
      class: 'btn btn--ghost btn--small',
      type: 'button',
      onclick: async () => {
        if (!email.value.trim()) {
          message.textContent = 'Escribe tu correo arriba y vuelve a pulsar.';
          return;
        }
        try {
          await resetPassword(email.value);
          message.textContent = 'Te hemos enviado un correo para elegir una contraseña nueva.';
        } catch (error) {
          message.textContent = describeError(error);
        }
      },
    },
    '¿Olvidaste la contraseña?',
  );
  buttons.push(signInButton, signUpButton);

  return h(
    'form',
    {
      class: 'account-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void attempt('in');
      },
    },
    h(
      'p',
      { class: 'deck__meta' },
      'Inicia sesión con la misma cuenta en el ordenador, el Mac y el iPhone y tu progreso se mantendrá igual en todos. La app sigue funcionando sin conexión; los cambios se suben al volver.',
    ),
    h('label', { class: 'field', for: 'sync-email' }, 'Correo', email),
    h('label', { class: 'field', for: 'sync-password' }, 'Contraseña (mínimo 6 caracteres)', password),
    h('div', { class: 'row' }, signInButton, signUpButton, resetButton),
    message,
  );
}

function signedInPanel(status: SyncStatus): { node: HTMLElement; update: (s: SyncStatus) => void } {
  const line = h('p', { class: 'deck__meta', 'aria-live': 'polite' });
  const syncButton = h(
    'button',
    { class: 'btn btn--primary', type: 'button', onclick: () => requestSync(true) },
    'Sincronizar ahora',
  );

  function update(s: SyncStatus): void {
    const pending = s.pending > 0 ? ` · ${plural(s.pending, 'cambio pendiente', 'cambios pendientes')}` : ' · todo subido';
    const describe: Partial<Record<SyncStatus['state'], string>> = {
      idle: `✅ Sincronizado ${formatWhen(s.lastSyncAt)}${pending}`,
      syncing: '🔄 Sincronizando…',
      offline: `📴 Sin conexión${pending}. Se sincronizará al volver.`,
      error: `⚠️ ${s.error ?? 'Error de sincronización.'}${pending}`,
    };
    line.textContent = describe[s.state] ?? '';
    syncButton.disabled = s.state === 'syncing';
  }
  update(status);

  const node = h(
    'div',
    {},
    h('p', {}, 'Conectado como ', h('strong', {}, status.email ?? '—')),
    line,
    h(
      'div',
      { class: 'row' },
      syncButton,
      h(
        'button',
        {
          class: 'btn btn--ghost',
          type: 'button',
          onclick: async () => {
            if (!confirm('¿Cerrar sesión? Tus datos se quedan en este dispositivo; solo dejará de sincronizarse.')) return;
            await signOutSync();
            toast('Sesión cerrada.');
          },
        },
        'Cerrar sesión',
      ),
    ),
  );
  return { node, update };
}

export function renderAccountSection(): HTMLElement {
  const body = h('div', {});
  const section = h('section', { class: 'card' }, h('h3', { class: 'section-title' }, 'Cuenta y sincronización'), body);

  // Rebuild only when the kind of panel changes; within the signed-in panel,
  // update text in place. Rebuilding on every status tick would wipe a
  // half-typed password or move focus out from under the user.
  let shown: 'unconfigured' | 'loading' | 'signed-out' | 'signed-in' | null = null;
  let shownEmail: string | null = null;
  let panel: ReturnType<typeof signedInPanel> | null = null;
  let mounted = false;

  const unsubscribe = onSyncStatus((status) => {
    if (mounted && !section.isConnected) {
      unsubscribe();
      return;
    }
    mounted = true;

    const kind =
      status.state === 'unconfigured' || status.state === 'loading' || status.state === 'signed-out'
        ? status.state
        : 'signed-in';

    if (kind === shown && (kind !== 'signed-in' || status.email === shownEmail)) {
      panel?.update(status);
      return;
    }
    shown = kind;
    shownEmail = status.email;
    panel = null;
    clear(body);

    if (kind === 'unconfigured') {
      body.append(
        h(
          'p',
          { class: 'deck__meta' },
          'La sincronización entre dispositivos aún no está activada en esta versión. Mientras tanto, usa Exportar / Importar copia para pasar tu progreso de un dispositivo a otro.',
        ),
      );
    } else if (kind === 'loading') {
      body.append(h('p', { class: 'deck__meta' }, 'Conectando…'));
    } else if (kind === 'signed-out') {
      body.append(signedOutForm());
    } else {
      panel = signedInPanel(status);
      body.append(panel.node);
    }
  });

  return section;
}
