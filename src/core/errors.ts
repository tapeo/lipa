export const ERROR_CODES = [
  'capability_missing',
  'config_invalid',
  'prebuilt_stale',
  'sdk_mismatch',
  'signing_invalid',
  'ipa_invalid',
  'remote_unreachable',
  'usage',
  'generic',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const EXIT_CODES = {
  ok: 0,
  generic: 1,
  usage: 2,
  capability: 3,
  prebuilt_stale: 4,
  sdk_mismatch: 5,
  signing_invalid: 6,
  ipa_invalid: 7,
  remote_unreachable: 8,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const EXIT_CODE_BY_ERROR: Record<ErrorCode, ExitCode> = {
  capability_missing: EXIT_CODES.capability,
  config_invalid: EXIT_CODES.generic,
  prebuilt_stale: EXIT_CODES.prebuilt_stale,
  sdk_mismatch: EXIT_CODES.sdk_mismatch,
  signing_invalid: EXIT_CODES.signing_invalid,
  ipa_invalid: EXIT_CODES.ipa_invalid,
  remote_unreachable: EXIT_CODES.remote_unreachable,
  usage: EXIT_CODES.usage,
  generic: EXIT_CODES.generic,
};

export interface LipaErrorOptions {
  code: ErrorCode;
  message: string;
  fix?: string | undefined;
  details?: Record<string, unknown> | undefined;
  exitCode?: ExitCode | undefined;
}

export class LipaError extends Error {
  readonly code: ErrorCode;
  readonly fix: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly exitCode: ExitCode;

  constructor(options: LipaErrorOptions) {
    super(options.message);
    this.name = 'LipaError';
    this.code = options.code;
    this.fix = options.fix;
    this.details = options.details;
    this.exitCode = options.exitCode ?? EXIT_CODE_BY_ERROR[options.code];
  }
}

export function toLipaError(error: unknown): LipaError {
  if (error instanceof LipaError) {
    return error;
  }

  if (error instanceof Error) {
    return new LipaError({ code: 'generic', message: error.message });
  }

  return new LipaError({ code: 'generic', message: String(error) });
}
