import {
  detectFormat,
  exportAll,
  importLegacy,
  importNative,
  type LegacyBackup,
  type NativeBackup,
} from '../../backup/backup.ts';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from '../../settings.ts';
import { clear, h, toast } from '../dom.ts';
import { saveFile } from '../save-file.ts';
import { isPersisted } from '../../core/storage.ts';

interface NumberFieldSpec {
  key: keyof AppSettings;
  label: string;
  hint: string;
  min: number;
  max: number;
  step?: number;
}

const FIELDS: NumberFieldSpec[] = [
  {
    key: 'newPerDay',
    label: 'Tarjetas nuevas por día',
    hint: 'Por modo. Las tarjetas en aprendizaje nunca cuentan para este límite.',
    min: 0,
    max: 500,
  },
  {
    key: 'reviewsPerDay',
    label: 'Repasos por día',
    hint: 'Por modo. Solo limita tarjetas ya maduras, no las que estás aprendiendo.',
    min: 0,
    max: 9999,
  },
  {
    key: 'leechThreshold',
    label: 'Fallos para marcar como difícil',
    hint: 'Al alcanzar este número de fallos la tarjeta aparece en «Difíciles».',
    min: 1,
    max: 50,
  },
  {
    key: 'dayStartHour',
    label: 'Hora de inicio del día',
    hint: 'Si estudias de madrugada, sigue contando como el día anterior hasta esta hora.',
    min: 0,
    max: 23,
  },
];

function renderBackupSection(): HTMLElement {
  const status = h('p', { class: 'deck__meta', 'aria-live': 'polite' });

  const persistence = h('p', { class: 'deck__meta' });
  void isPersisted().then((persisted) => {
    if (persisted === true) {
      persistence.textContent = '🔒 Almacenamiento protegido: el navegador no borrará tus datos por falta de espacio o de uso.';
    } else if (persisted === false) {
      persistence.textContent =
        '⚠️ Almacenamiento no protegido: el navegador podría borrar los datos si no abres la app en un tiempo. Instalarla (o activar la sincronización) lo evita.';
    }
  });

  const exportButton = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        exportButton.disabled = true;
        try {
          const backup = await exportAll();
          const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
          const date = new Date().toISOString().slice(0, 10);
          const outcome = await saveFile(blob, `mandarin-estudio-${date}.json`);
          if (outcome !== 'cancelled') {
            status.textContent = `Copia exportada: ${backup.cards.length} tarjetas, ${backup.logs.length} repasos registrados.`;
          }
        } finally {
          exportButton.disabled = false;
        }
      },
    },
    '⬇ Exportar todo (JSON)',
  );

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json,text/plain',
    class: 'visually-hidden',
    id: 'backup-file',
    onchange: async (event: Event) => {
      const target = event.target as HTMLInputElement;
      const file = target.files?.[0];
      target.value = '';
      if (!file) return;
      try {
        const data: unknown = JSON.parse(await file.text());
        const format = detectFormat(data);

        if (format === 'native') {
          const backup = data as NativeBackup;
          const ok = confirm(
            `Restaurar la copia del ${new Date(backup.exportedAt).toLocaleDateString('es-ES')}:\n` +
              `${backup.cards?.length ?? 0} tarjetas, ${backup.reviews?.length ?? 0} programaciones, ${backup.logs?.length ?? 0} repasos.\n\n` +
              'REEMPLAZA todos los datos actuales. ¿Continuar?',
          );
          if (!ok) return;
          const summary = await importNative(backup);
          status.textContent = `Restaurado: ${summary.cards} tarjetas, ${summary.reviews} programaciones, ${summary.logs} repasos.`;
          toast('Copia restaurada. Recargando…');
          setTimeout(() => window.location.reload(), 1200);
          return;
        }

        if (format === 'legacy-v2') {
          const backup = data as LegacyBackup;
          const ok = confirm(
            `Detectada una copia del prototipo (${backup.cards?.length ?? 0} tarjetas, ${backup.logs?.length ?? 0} repasos).\n\n` +
              'Se AÑADE a los datos actuales: las tarjetas que ya existan conservan lo suyo y adoptan el historial antiguo solo si aún no tienen. ¿Continuar?',
          );
          if (!ok) return;
          const summary = await importLegacy(backup);
          const details = [
            `${summary.cardsCreated} tarjetas nuevas`,
            `${summary.cardsExisting} ya existían`,
            `${summary.reviewsImported} historiales de estudio`,
            `${summary.logsImported} repasos`,
          ];
          if (summary.reviewsSkippedExisting > 0) details.push(`${summary.reviewsSkippedExisting} historiales conservados de esta app`);
          if (summary.logsOrphaned > 0) details.push(`${summary.logsOrphaned} repasos sin tarjeta`);
          status.textContent = `Migrado del prototipo: ${details.join(' · ')}.`;
          toast('Copia del prototipo migrada.');
          return;
        }

        toast('El archivo no parece una copia de esta aplicación ni del prototipo.', 'error');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(`No se pudo importar: ${message}`, 'error');
      }
    },
  });

  return h(
    'section',
    { class: 'card' },
    h('h3', { class: 'section-title' }, 'Copia de seguridad'),
    h(
      'p',
      { class: 'deck__meta' },
      'Todo vive en este navegador. Exporta un JSON de vez en cuando: es lo único que sobrevive a un borrado de datos del navegador, y sirve para pasar todo a otro dispositivo.',
    ),
    h(
      'div',
      { class: 'row' },
      exportButton,
      h(
        'button',
        { class: 'btn', type: 'button', onclick: () => fileInput.click() },
        '⬆ Importar copia…',
      ),
      fileInput,
    ),
    h(
      'p',
      { class: 'deck__meta', style: 'margin-top:8px' },
      'Acepta copias de esta aplicación (restauración completa) y copias del prototipo anterior (se añaden sin duplicar).',
    ),
    status,
    persistence,
  );
}

export async function renderSettings(root: HTMLElement): Promise<void> {
  const settings = await loadSettings();
  const pending: Partial<AppSettings> = {};

  const status = h('p', { class: 'deck__meta', 'aria-live': 'polite' });
  const form = h('div', { class: 'settings-grid' });

  for (const field of FIELDS) {
    const input = h('input', {
      type: 'number',
      value: String(settings[field.key] as number),
      min: String(field.min),
      max: String(field.max),
      step: String(field.step ?? 1),
      id: `set-${field.key}`,
      onchange: (event: Event) => {
        const raw = Number((event.target as HTMLInputElement).value);
        const clamped = Math.min(Math.max(Number.isFinite(raw) ? raw : field.min, field.min), field.max);
        (event.target as HTMLInputElement).value = String(clamped);
        (pending as Record<string, unknown>)[field.key] = clamped;
        status.textContent = 'Cambios sin guardar.';
      },
    });

    form.append(
      h(
        'div',
        { class: 'settings-field' },
        h('label', { class: 'field', for: `set-${field.key}` }, field.label, input),
        h('small', {}, field.hint),
      ),
    );
  }

  // Speech rate: a fraction with its own slider.
  const rateInput = h('input', {
    type: 'range',
    min: '0.6',
    max: '1.0',
    step: '0.05',
    value: String(settings.speechRate),
    id: 'set-speechrate',
    oninput: (event: Event) => {
      const value = Number((event.target as HTMLInputElement).value);
      pending.speechRate = value;
      rateOut.textContent = `${value.toFixed(2).replace('.', ',')}×`;
      status.textContent = 'Cambios sin guardar.';
    },
  });
  const rateOut = h('output', { class: 'tag tag--accent' }, `${settings.speechRate.toFixed(2).replace('.', ',')}×`);

  form.append(
    h(
      'div',
      { class: 'settings-field' },
      h('label', { class: 'field', for: 'set-speechrate' }, 'Velocidad de la voz', rateInput),
      rateOut,
      h('small', {}, 'Velocidad del audio en chino (0,6× – 1×). También ajustable durante el dictado.'),
    ),
  );

  // Retention is a fraction, so it gets its own control.
  const retentionInput = h('input', {
    type: 'range',
    min: '0.7',
    max: '0.97',
    step: '0.01',
    value: String(settings.requestRetention),
    id: 'set-retention',
    oninput: (event: Event) => {
      const value = Number((event.target as HTMLInputElement).value);
      pending.requestRetention = value;
      retentionLabel.textContent = `${Math.round(value * 100)} %`;
      status.textContent = 'Cambios sin guardar.';
    },
  });
  const retentionLabel = h('output', { class: 'tag tag--accent' }, `${Math.round(settings.requestRetention * 100)} %`);

  form.append(
    h(
      'div',
      { class: 'settings-field' },
      h('label', { class: 'field', for: 'set-retention' }, 'Retención objetivo', retentionInput),
      retentionLabel,
      h(
        'small',
        {},
        'Probabilidad de acertar que buscas al repasar. Más alta = intervalos más cortos y más repasos.',
      ),
    ),
  );

  root.append(
    h('h2', {}, 'Ajustes'),
    h('p', { class: 'subtitle' }, 'Los límites diarios se aplican por modo de ejercicio.'),
    h(
      'section',
      { class: 'card' },
      form,
      status,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn btn--primary',
            type: 'button',
            onclick: async () => {
              await saveSettings(pending);
              status.textContent = 'Guardado.';
              toast('Ajustes guardados.');
            },
          },
          'Guardar',
        ),
        h(
          'button',
          {
            class: 'btn btn--ghost',
            type: 'button',
            onclick: async () => {
              if (!confirm('¿Restaurar todos los ajustes a sus valores por defecto?')) return;
              await saveSettings(DEFAULT_SETTINGS);
              toast('Ajustes restaurados.');
              clear(root);
              await renderSettings(root);
            },
          },
          'Restaurar valores por defecto',
        ),
      ),
    ),
    renderBackupSection(),
    h(
      'section',
      { class: 'card' },
      h('h3', { class: 'section-title' }, 'Algoritmo'),
      h(
        'p',
        { class: 'deck__meta' },
        'FSRS-5 con el conjunto de parámetros por defecto (19 pesos). Pasos de aprendizaje: ',
        h('code', {}, settings.learningSteps.map((m) => `${m} min`).join(' → ')),
        '. Pasos de reaprendizaje: ',
        h('code', {}, settings.relearningSteps.map((m) => `${m} min`).join(' → ')),
        '.',
      ),
    ),
  );
}
