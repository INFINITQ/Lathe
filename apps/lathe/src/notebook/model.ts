// Notebooks in nbformat 4 (.ipynb), read and written the way Jupyter writes them: keys sorted,
// one-space indents, and text split into lines (nbformat's split_lines). A notebook saved without
// changes comes back byte for byte, and edits make small Git diffs. Numbers keep their written
// form (1.0 stays 1.0), and fields Lathe doesn't know are written back as they were.

/** A mime bundle; text values are whole strings in memory. */
export type MimeBundle = Record<string, unknown>;

export type Output =
  | { output_type: 'stream'; name: string; text: string }
  | {
      output_type: 'display_data';
      data: MimeBundle;
      metadata: Record<string, unknown>;
      /** Not saved: display ids for update_display_data. */
      transient?: Record<string, unknown>;
    }
  | {
      output_type: 'execute_result';
      data: MimeBundle;
      metadata: Record<string, unknown>;
      execution_count: number | null;
      transient?: Record<string, unknown>;
    }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };

export type CellType = 'code' | 'markdown' | 'raw';

export interface Cell {
  /** Lathe's own key for the cell while it's open (never saved). */
  key: string;
  /** nbformat 4.5's cell id; absent in older notebooks. */
  id?: string;
  cell_type: CellType;
  source: string;
  metadata: Record<string, unknown>;
  outputs: Output[];
  execution_count: number | null;
  attachments?: Record<string, MimeBundle>;
  /** Other fields, written back unchanged. */
  rest: Record<string, unknown>;
}

export interface Notebook {
  cells: Cell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
  rest: Record<string, unknown>;
}

/** A number as it was written, when JavaScript would write it differently (1.0, 1e-05). */
class RawNumber {
  constructor(readonly source: string) {}
}

let keys = 0;
export function cellKey(): string {
  return `c${++keys}`;
}

/** A new cell id, as nbformat makes them (8 hex characters). */
export function newCellId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

/** The line breaks Python's splitlines knows: \n \r \v \f \x1c \x1d \x1e \x85 U+2028 U+2029. */
const BREAKS = `\n\r\v\f\x1c\x1d\x1e\x85${String.fromCharCode(0x2028, 0x2029)}`;
const LINE = new RegExp(`[^${BREAKS}]*(?:\r\n|[${BREAKS}])?`, 'g');

/** Python's str.splitlines(True): lines with their endings. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  for (const match of text.matchAll(LINE)) if (match[0]) lines.push(match[0]);
  return lines;
}

/** nbformat's _join_lines: lines written with or without their endings. */
function joinLines(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const lines = value.map(String);
  return lines[0]?.endsWith('\n') || lines[0]?.endsWith('\r') ? lines.join('') : lines.join('\n');
}

const SPLIT_MIMES = new Set(['application/javascript', 'image/svg+xml']);

function isJsonMime(mime: string): boolean {
  return mime === 'application/json' || (mime.startsWith('application/') && mime.endsWith('+json'));
}

function joinBundle(data: unknown): MimeBundle {
  const bundle: MimeBundle = {};
  if (!data || typeof data !== 'object') return bundle;
  for (const [mime, value] of Object.entries(data as MimeBundle)) {
    bundle[mime] =
      !isJsonMime(mime) && Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? value.join('')
        : value;
  }
  return bundle;
}

function splitBundle(data: MimeBundle): MimeBundle {
  const bundle: MimeBundle = {};
  for (const [mime, value] of Object.entries(data)) {
    bundle[mime] =
      typeof value === 'string' && (mime.startsWith('text/') || SPLIT_MIMES.has(mime))
        ? splitLines(value)
        : value;
  }
  return bundle;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOutput(raw: Record<string, unknown>): Output {
  const type = raw.output_type;
  if (type === 'stream') {
    return { output_type: 'stream', name: String(raw.name ?? 'stdout'), text: joinLines(raw.text) };
  }
  if (type === 'error') {
    return {
      output_type: 'error',
      ename: String(raw.ename ?? ''),
      evalue: String(raw.evalue ?? ''),
      traceback: Array.isArray(raw.traceback) ? raw.traceback.map(String) : [],
    };
  }
  if (type === 'execute_result') {
    return {
      output_type: 'execute_result',
      data: joinBundle(raw.data),
      metadata: record(raw.metadata),
      execution_count: typeof raw.execution_count === 'number' ? raw.execution_count : null,
    };
  }
  return {
    output_type: 'display_data',
    data: joinBundle(raw.data),
    metadata: record(raw.metadata),
  };
}

const CELL_FIELDS = new Set([
  'id',
  'cell_type',
  'source',
  'metadata',
  'outputs',
  'execution_count',
  'attachments',
]);

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

/** Keeps numbers whose written form JavaScript would change (1.0, 1e-05). */
const keepNumbers: Reviver = (_key, value, context) =>
  typeof value === 'number' && context?.source !== undefined && context.source !== String(value)
    ? new RawNumber(context.source)
    : value;

/** Reads an .ipynb file. Throws with a readable message when it isn't one. */
export function parseNotebook(text: string): Notebook {
  if (!text.trim()) return emptyNotebook();
  const raw = JSON.parse(text, keepNumbers as (key: string, value: unknown) => unknown) as Record<
    string,
    unknown
  >;
  const nbformat = typeof raw.nbformat === 'number' ? raw.nbformat : 0;
  if (nbformat !== 4) {
    throw new Error(
      nbformat
        ? `This notebook is in nbformat ${nbformat}; Lathe opens nbformat 4.`
        : "This isn't a Jupyter notebook.",
    );
  }
  const cells = (Array.isArray(raw.cells) ? raw.cells : []).map((item): Cell => {
    const cell = record(item);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cell)) if (!CELL_FIELDS.has(key)) rest[key] = value;
    const type =
      cell.cell_type === 'markdown' || cell.cell_type === 'raw' ? cell.cell_type : 'code';
    return {
      key: cellKey(),
      ...(typeof cell.id === 'string' ? { id: cell.id } : {}),
      cell_type: type,
      source: joinLines(cell.source),
      metadata: record(cell.metadata),
      outputs:
        type === 'code' && Array.isArray(cell.outputs)
          ? cell.outputs.map((o) => readOutput(record(o)))
          : [],
      execution_count: typeof cell.execution_count === 'number' ? cell.execution_count : null,
      ...(cell.attachments
        ? {
            attachments: Object.fromEntries(
              Object.entries(record(cell.attachments)).map(([k, v]) => [k, joinBundle(v)]),
            ),
          }
        : {}),
      rest,
    };
  });
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!['cells', 'metadata', 'nbformat', 'nbformat_minor'].includes(key)) rest[key] = value;
  }
  return {
    cells,
    metadata: record(raw.metadata),
    nbformat,
    nbformat_minor: typeof raw.nbformat_minor === 'number' ? raw.nbformat_minor : 0,
    rest,
  };
}

export function emptyNotebook(): Notebook {
  return {
    cells: [newCell('code', '', true)],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
    rest: {},
  };
}

export function newCell(type: CellType, source = '', withId = true): Cell {
  return {
    key: cellKey(),
    ...(withId ? { id: newCellId() } : {}),
    cell_type: type,
    source,
    metadata: {},
    outputs: [],
    execution_count: null,
    rest: {},
  };
}

function writeOutput(output: Output): Record<string, unknown> {
  switch (output.output_type) {
    case 'stream':
      return { name: output.name, output_type: 'stream', text: splitLines(output.text) };
    case 'error':
      return {
        ename: output.ename,
        evalue: output.evalue,
        output_type: 'error',
        traceback: output.traceback,
      };
    case 'execute_result':
      return {
        data: splitBundle(output.data),
        execution_count: output.execution_count,
        metadata: output.metadata,
        output_type: 'execute_result',
      };
    default:
      return {
        data: splitBundle(output.data),
        metadata: output.metadata,
        output_type: 'display_data',
      };
  }
}

function writeCell(cell: Cell): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...cell.rest,
    cell_type: cell.cell_type,
    metadata: cell.metadata,
    source: splitLines(cell.source),
  };
  if (cell.id !== undefined) out.id = cell.id;
  if (cell.attachments) {
    out.attachments = Object.fromEntries(
      Object.entries(cell.attachments).map(([k, v]) => [k, splitBundle(v)]),
    );
  }
  if (cell.cell_type === 'code') {
    out.execution_count = cell.execution_count;
    out.outputs = cell.outputs.map(writeOutput);
  }
  return out;
}

/** Python's json.dumps(value, sort_keys=True, indent=1, ensure_ascii=False). */
export function pythonJson(value: unknown, level = 0): string {
  if (value instanceof RawNumber) return value.source;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : value < 0 ? '-Infinity' : 'NaN';
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  const pad = ' '.repeat(level + 1);
  const end = ' '.repeat(level);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => pad + pythonJson(v, level + 1)).join(',\n')}\n${end}]`;
  }
  const object = value as Record<string, unknown>;
  const names = Object.keys(object)
    .filter((k) => object[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!names.length) return '{}';
  return `{\n${names
    .map((k) => `${pad}${JSON.stringify(k)}: ${pythonJson(object[k], level + 1)}`)
    .join(',\n')}\n${end}}`;
}

/** The .ipynb text for a notebook, as nbformat.write would produce it. */
export function serializeNotebook(notebook: Notebook): string {
  return `${pythonJson({
    ...notebook.rest,
    cells: notebook.cells.map(writeCell),
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformat_minor,
  })}\n`;
}

/** Joins a text output's value (a string, or lines). */
export function joinText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join('') : typeof value === 'string' ? value : '';
}
