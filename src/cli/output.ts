import type { FlagValue } from '@/cli/parser.ts';
import { toLipaError } from '@/core/errors.ts';

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    fix?: string;
    details?: Record<string, unknown>;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface OutputOptions {
  json: boolean;
  color: boolean;
}

export function emit<T>(envelope: Envelope<T>, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  if (!envelope.ok) {
    const lines = [`Error: ${envelope.error.message}`, `Code: ${envelope.error.code}`];

    if (envelope.error.fix !== undefined) {
      lines.push(`Fix: ${envelope.error.fix}`);
    }

    process.stderr.write(`${lines.join('\n')}\n`);
    return;
  }

  process.stdout.write(`${renderData(envelope.data)}\n`);
}

export function renderData(data: unknown): string {
  if (data === null || data === undefined) {
    return '';
  }

  if (typeof data === 'string') {
    return data;
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  return JSON.stringify(data, null, 2);
}

export interface TableColumn<T> {
  header: string;
  value: (row: T) => string;
}

export function renderTable<T>(rows: T[], columns: TableColumn<T>[]): string {
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...rows.map((row) => column.value(row).length)),
  );

  const header = columns
    .map((column, index) => column.header.padEnd(widths[index] ?? 0))
    .join('  ')
    .trimEnd();

  const body = rows.map((row) =>
    columns
      .map((column, index) => column.value(row).padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd(),
  );

  return [header, ...body].join('\n');
}

export function renderNextSteps(steps: string[]): string[] {
  if (steps.length === 0) {
    return [];
  }

  if (steps.length === 1) {
    return ['', `Next step: ${steps[0]}`];
  }

  return ['', 'Next steps:', ...steps.map((step) => `  ${step}`)];
}

export function reportError(error: unknown, options: OutputOptions): number {
  const lipaError = toLipaError(error);
  const envelope: ErrorEnvelope = {
    ok: false,
    error: { code: lipaError.code, message: lipaError.message },
  };

  if (lipaError.fix !== undefined) {
    envelope.error.fix = lipaError.fix;
  }

  if (lipaError.details !== undefined) {
    envelope.error.details = lipaError.details;
  }

  emit(envelope, options);
  return lipaError.exitCode;
}

export function resolveOutputOptions(values: Record<string, FlagValue>): OutputOptions {
  const forced = values.json === true;
  const isTty = process.stdout.isTTY === true;

  return { json: forced || !isTty, color: isTty && process.env.NO_COLOR === undefined };
}
