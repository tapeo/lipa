import { existsSync } from 'node:fs';

import { LipaError } from '@/core/errors.ts';

export interface RunOptions {
  cwd?: string;
  stdin?: Blob;
  stdout?: 'pipe' | 'inherit';
  stderr?: 'pipe' | 'inherit';
  env?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const child = Bun.spawn(argv, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: options.stdin ?? 'ignore',
    stdout: options.stdout ?? 'pipe',
    stderr: options.stderr ?? 'pipe',
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export async function runOrFail(argv: string[], options: RunOptions = {}): Promise<string> {
  const result = await run(argv, options);

  if (result.exitCode !== 0) {
    throw new LipaError({
      code: 'generic',
      message: `${argv[0]} exited with ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
    });
  }

  return result.stdout;
}

export function requireCommand(name: string, hint?: string): void {
  if (Bun.which(name) === null) {
    throw new LipaError({
      code: 'capability_missing',
      message: `Missing ${name}`,
      fix: hint ?? `Install ${name} and run lipa doctor.`,
    });
  }
}

export function requirePath(path: string, what: string, fix?: string): void {
  if (!existsSync(path)) {
    throw new LipaError({
      code: 'capability_missing',
      message: `Missing ${what}: ${path}`,
      fix: fix ?? 'Run lipa setup.',
    });
  }
}

export async function commandVersion(argv: string[]): Promise<string | undefined> {
  try {
    const result = await run(argv);

    if (result.exitCode !== 0) {
      return undefined;
    }

    return result.stdout.trim().split('\n')[0];
  } catch {
    return undefined;
  }
}
