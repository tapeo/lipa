import type { CommandSpec } from '@/cli/command.ts';
import { buildCommand } from '@/cli/commands/build.ts';
import { doctorCommand } from '@/cli/commands/doctor.ts';
import { inspectCommand } from '@/cli/commands/inspect.ts';
import { prepareCommand } from '@/cli/commands/prepare.ts';
import { runCommand } from '@/cli/commands/run.ts';
import { sdkCommand } from '@/cli/commands/sdk.ts';
import { setupCommand } from '@/cli/commands/setup.ts';
import { signingCommand } from '@/cli/commands/signing.ts';
import { updateCommand } from '@/cli/commands/update.ts';

export function allCommands(): CommandSpec[] {
  return [
    setupCommand,
    sdkCommand,
    signingCommand,
    prepareCommand,
    buildCommand,
    inspectCommand,
    doctorCommand,
    runCommand,
    updateCommand,
  ];
}
