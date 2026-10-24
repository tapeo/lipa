import type { BuildSpec } from '@/core/spec.ts';

export function utcBuildNumber(now: Date): string {
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
}

export function resolveBuildNumber(
  explicit: string | undefined,
  spec: Pick<BuildSpec, 'currentProjectVersion'>,
  now: Date,
): string {
  if (explicit !== undefined) {
    return explicit;
  }

  if (spec.currentProjectVersion !== undefined) {
    return spec.currentProjectVersion;
  }

  return utcBuildNumber(now);
}
