import { columnLetter, parseFile, type ParsedRow, type SheetResult } from '../../import/parse.ts';
import { classifyKind } from '../../import/classify.ts';
import { commitImport, type CommitResult } from '../../import/reconcile.ts';
import type { CardKind, HskLevel } from '../../db/types.ts';
import { clear, h, plural, toast } from '../dom.ts';

interface PreviewRow extends ParsedRow {
  include: boolean;
}

interface PreviewFile {
  key: string;
  fileName: string;
  deckName: string;
  level: HskLevel | undefined;
  sheets: SheetResult[];
  rows: PreviewRow[];
  error?: string;
}

/** Rows rendered before the "show all" escape hatch, so a huge sheet can't hang the UI. */
const RENDER_CAP = 1000;

const KIND_LABEL: Record<CardKind, string> = { word: 'Palabra', sentence: 'Oración' };

let files: PreviewFile[] = [];
let results: CommitResult[] = [];
let counter = 0;

export function renderImport(root: HTMLElement): void {
  files = [];
  results = [];

  const list = h('div', {});
  const resultList = h('div', {});

  const input = h('input', {
    type: 'file',
    multiple: true,
    accept: '.xlsx,.xls,.xlsm,.csv,.tsv,.txt',
    class: 'visually-hidden',
    id: 'file-input',
    onchange: (event: Event) => {
      const target = event.target as HTMLInputElement;
      if (target.files) void addFiles([...target.files]);
      target.value = '';
    },
  });

  const dropzone = h(
    'div',
    { class: 'dropzone' },
    h('p', {}, 'Arrastra tus archivos Excel o CSV aquí'),
    h(
      'button',
      {
        class: 'btn btn--primary',
        type: 'button',
        onclick: () => input.click(),
      },
      'Elegir archivos',
    ),
    input,
    h(
      'p',
      { style: 'margin-top:12px;font-size:0.82rem' },
      'Columna 1 hanzi · columna 2 pinyin · columna 3 español. Se leen todas las hojas del libro.',
    ),
  );

  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth++;
    dropzone.classList.add('dropzone--over');
  });
  dropzone.addEventListener('dragover', (event) => event.preventDefault());
  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('dropzone--over');
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('dropzone--over');
    const dropped = event.dataTransfer?.files;
    if (dropped && dropped.length > 0) void addFiles([...dropped]);
  });

  root.append(
    h('h2', {}, 'Importar'),
    h('p', { class: 'subtitle' }, 'Revisa la clasificación antes de confirmar. Un archivo = un mazo.'),
    dropzone,
    resultList,
    list,
  );

  async function addFiles(incoming: File[]): Promise<void> {
    const parsed = await Promise.all(incoming.map((file) => parseFile(file)));
    for (const result of parsed) {
      const rows: PreviewRow[] = result.sheets.flatMap((sheet) =>
        sheet.rows.map((row) => ({ ...row, include: true })),
      );
      const preview: PreviewFile = {
        key: `f${counter++}`,
        fileName: result.fileName,
        deckName: result.deckName,
        level: undefined,
        sheets: result.sheets,
        rows,
      };
      if (result.error) preview.error = result.error;
      files.push(preview);
    }
    renderList();
  }

  function renderList(): void {
    clear(list);
    for (const file of files) list.append(renderFileCard(file, onCommitted, onDiscard));
  }

  function onDiscard(file: PreviewFile): void {
    files = files.filter((f) => f !== file);
    renderList();
  }

  function onCommitted(file: PreviewFile, result: CommitResult): void {
    results = [result, ...results];
    files = files.filter((f) => f !== file);
    clear(resultList);
    for (const item of results) resultList.append(renderResult(item));
    renderList();
  }
}

function renderResult(result: CommitResult): HTMLElement {
  const stat = (value: number, label: string) =>
    h('div', {}, h('b', {}, String(value)), h('span', {}, label));

  const extras: HTMLElement[] = [];
  if (result.duplicatesInFile > 0) {
    extras.push(
      h(
        'p',
        { class: 'deck__meta', style: 'margin:8px 0 0' },
        `${plural(result.duplicatesInFile, 'fila duplicada', 'filas duplicadas')} dentro del archivo (se conservó la última).`,
      ),
    );
  }
  if (result.inOtherDeck > 0) {
    extras.push(
      h(
        'p',
        { class: 'deck__meta', style: 'margin:8px 0 0' },
        `${plural(result.inOtherDeck, 'tarjeta ya existía', 'tarjetas ya existían')} en otro mazo; se dejaron allí con su historial.`,
      ),
    );
  }

  return h(
    'section',
    { class: 'card' },
    h('h3', { style: 'margin:0 0 4px' }, `Importado: ${result.deckName}`),
    h('p', { class: 'deck__meta' }, `${plural(result.cardCount, 'tarjeta activa', 'tarjetas activas')} en el mazo.`),
    h(
      'div',
      { class: 'summary-grid' },
      stat(result.added, 'nuevas'),
      stat(result.updated, 'actualizadas'),
      stat(result.unchanged, 'sin cambios'),
      stat(result.restored, 'restauradas'),
      stat(result.softDeleted, 'archivadas'),
    ),
    ...extras,
  );
}

function renderFileCard(
  file: PreviewFile,
  onCommitted: (file: PreviewFile, result: CommitResult) => void,
  onDiscard: (file: PreviewFile) => void,
): HTMLElement {
  const section = h('section', { class: 'card' });

  if (file.error) {
    section.append(
      h('h3', { style: 'margin:0 0 4px' }, file.fileName),
      h('div', { class: 'error-box' }, `No se pudo leer el archivo: ${file.error}`),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => onDiscard(file) }, 'Quitar'),
    );
    return section;
  }

  if (file.rows.length === 0) {
    const skipped = file.sheets.reduce((sum, sheet) => sum + sheet.skipped, 0);
    section.append(
      h('h3', { style: 'margin:0 0 4px' }, file.fileName),
      h(
        'div',
        { class: 'error-box' },
        `Ninguna fila tiene caracteres chinos en la columna del hanzi (${plural(skipped, 'fila revisada', 'filas revisadas')}). Revisa que el archivo tenga el hanzi en una de sus columnas.`,
      ),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => onDiscard(file) }, 'Quitar'),
    );
    return section;
  }

  const nameInput = h('input', {
    type: 'text',
    value: file.deckName,
    'aria-label': 'Nombre del mazo',
    oninput: (event: Event) => {
      file.deckName = (event.target as HTMLInputElement).value;
      commitButton.textContent = `Importar a «${file.deckName.trim() || file.fileName}»`;
    },
  });

  const levelSelect = h(
    'select',
    {
      'aria-label': 'Nivel HSK del mazo',
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        file.level = value === '' ? undefined : (Number(value) as HskLevel);
      },
    },
    h('option', { value: '' }, 'Sin nivel'),
    h('option', { value: '1' }, 'HSK 1'),
    h('option', { value: '2' }, 'HSK 2'),
    h('option', { value: '3' }, 'HSK 3'),
  );

  const chips = h(
    'div',
    { class: 'sheet-chips' },
    ...file.sheets.map((sheet) => {
      const cols = `${columnLetter(sheet.columns[0])}/${columnLetter(sheet.columns[1])}/${columnLetter(sheet.columns[2])}`;
      const parts = [`${sheet.sheet}`, cols, plural(sheet.rows.length, 'fila', 'filas')];
      if (sheet.skipped > 0) parts.push(`${sheet.skipped} omitidas`);
      return h('span', { class: sheet.detected ? 'tag tag--warn' : 'tag' }, parts.join(' · '));
    }),
  );

  const detected = file.sheets.some((sheet) => sheet.detected);
  const detectedNote = detected
    ? h(
        'p',
        { class: 'deck__meta', style: 'margin:0 0 8px' },
        'La columna 1 no contenía hanzi, así que se detectaron las columnas automáticamente (marcadas en naranja). Verifica la vista previa.',
      )
    : null;

  const counts = h('p', { class: 'deck__meta', style: 'margin:10px 0 0' });

  const tbody = h('tbody', {});
  const table = h(
    'table',
    { class: 'preview' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col' }, 'Hanzi'),
        h('th', { scope: 'col' }, 'Pinyin'),
        h('th', { scope: 'col' }, 'Español'),
        h('th', { scope: 'col' }, 'Tipo'),
        h('th', { scope: 'col' }, 'Incluir'),
      ),
    ),
    tbody,
  );

  let rendered = Math.min(file.rows.length, RENDER_CAP);

  const showAllButton = h(
    'button',
    {
      class: 'btn btn--small btn--ghost',
      type: 'button',
      onclick: () => {
        rendered = file.rows.length;
        paintRows();
      },
    },
    `Mostrar las ${file.rows.length} filas`,
  );

  const moreNote = h('div', { style: 'padding:8px;text-align:center' }, showAllButton);

  function updateCounts(): void {
    const included = file.rows.filter((row) => row.include);
    const words = included.filter((row) => row.kind === 'word').length;
    const sentences = included.length - words;
    counts.textContent = `${plural(included.length, 'fila seleccionada', 'filas seleccionadas')} de ${file.rows.length} · ${words} palabras · ${sentences} oraciones`;
    commitButton.disabled = included.length === 0;
  }

  function paintRows(): void {
    clear(tbody);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < rendered; i++) {
      const row = file.rows[i];
      if (row) fragment.append(renderRow(row, updateCounts));
    }
    tbody.append(fragment);
    moreNote.style.display = rendered < file.rows.length ? '' : 'none';
    updateCounts();
  }

  function bulkKind(kind: CardKind | 'auto'): void {
    for (const row of file.rows) {
      row.kind = kind === 'auto' ? classifyKind(row.hanzi, row.pinyin) : kind;
    }
    paintRows();
  }

  function bulkInclude(include: boolean): void {
    for (const row of file.rows) row.include = include;
    paintRows();
  }

  const commitButton = h(
    'button',
    {
      class: 'btn btn--primary',
      type: 'button',
      onclick: async () => {
        commitButton.disabled = true;
        try {
          const selected = file.rows
            .filter((row) => row.include)
            .map((row) => ({ hanzi: row.hanzi, pinyin: row.pinyin, spanish: row.spanish, kind: row.kind }));
          const name = file.deckName.trim() || file.fileName;
          const result = await commitImport(name, file.level, selected);
          toast(`«${result.deckName}»: ${result.added} nuevas, ${result.updated} actualizadas.`);
          onCommitted(file, result);
        } catch (error) {
          commitButton.disabled = false;
          const message = error instanceof Error ? error.message : String(error);
          toast(`No se pudo importar: ${message}`, 'error');
        }
      },
    },
    `Importar a «${file.deckName.trim() || file.fileName}»`,
  );

  section.append(
    h('h3', { style: 'margin:0 0 10px' }, file.fileName),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field grow' }, 'Nombre del mazo', nameInput),
      h('label', { class: 'field' }, 'Nivel HSK', levelSelect),
    ),
    chips,
    ...(detectedNote ? [detectedNote] : []),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => bulkKind('word') }, 'Todas palabra'),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => bulkKind('sentence') }, 'Todas oración'),
      h('button', { class: 'btn btn--small', type: 'button', onclick: () => bulkKind('auto') }, 'Clasificación automática'),
      h('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => bulkInclude(true) }, 'Seleccionar todo'),
      h('button', { class: 'btn btn--small btn--ghost', type: 'button', onclick: () => bulkInclude(false) }, 'Ninguna'),
    ),
    counts,
    h('div', { class: 'preview-scroll' }, table, moreNote),
    h(
      'div',
      { class: 'row', style: 'margin-top:12px' },
      commitButton,
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => onDiscard(file) }, 'Descartar'),
    ),
  );

  paintRows();
  return section;
}

function renderRow(row: PreviewRow, onChange: () => void): HTMLElement {
  const tr = h('tr', { class: row.include ? '' : 'excluded' });

  const kindButton = h('button', {
    class: 'btn btn--small kind-toggle',
    type: 'button',
    'aria-pressed': String(row.kind === 'sentence'),
  });

  function paintKind(): void {
    kindButton.textContent = KIND_LABEL[row.kind];
    kindButton.setAttribute('aria-pressed', String(row.kind === 'sentence'));
    kindButton.setAttribute(
      'aria-label',
      `${row.hanzi}: ${KIND_LABEL[row.kind]}. Cambiar a ${row.kind === 'word' ? 'oración' : 'palabra'}`,
    );
  }

  kindButton.addEventListener('click', () => {
    row.kind = row.kind === 'word' ? 'sentence' : 'word';
    paintKind();
    onChange();
  });
  paintKind();

  const checkbox = h('input', {
    type: 'checkbox',
    checked: row.include,
    'aria-label': `Incluir ${row.hanzi}`,
    onchange: (event: Event) => {
      row.include = (event.target as HTMLInputElement).checked;
      tr.classList.toggle('excluded', !row.include);
      onChange();
    },
  });

  tr.append(
    h('td', { class: 'col-hanzi' }, row.hanzi),
    h('td', {}, row.pinyin),
    h('td', {}, row.spanish),
    h('td', { class: 'col-kind' }, kindButton),
    h('td', { class: 'col-include' }, h('label', { class: 'tap-target' }, checkbox)),
  );
  return tr;
}
