import type { CommandSpec } from '@/cli/command.ts';
import { renderTable } from '@/cli/output.ts';
import { stringValue } from '@/cli/parser.ts';
import { LipaError } from '@/core/errors.ts';
import { importSigning } from '@/core/signing.ts';

export const signingCommand: CommandSpec = {
  name: 'signing',
  summary: 'Signing identity and provisioning profile',
  usage: 'lipa signing import ...',
  actions: [
    {
      name: 'import',
      summary: 'Import a distribution certificate, its key and a profile',
      usage:
        'lipa signing import --cert <pem> --key <pem> --profile <.mobileprovision> [--team <id>]',
      flags: [
        { name: 'cert', value: 'path', description: 'Distribution certificate in PEM' },
        { name: 'key', value: 'path', description: 'Private key in PEM, mode 600' },
        { name: 'profile', value: 'path', description: 'App Store provisioning profile' },
        { name: 'team', value: 'id', description: 'Check the team of the profile' },
      ],
      examples: [
        'lipa signing import --cert cert.pem --key key.pem --profile App_AppStore.mobileprovision',
      ],
      async run({ args }) {
        const cert = stringValue(args.values, 'cert');
        const key = stringValue(args.values, 'key');
        const profile = stringValue(args.values, 'profile');

        if (cert === undefined || key === undefined || profile === undefined) {
          throw new LipaError({
            code: 'usage',
            message: 'Missing --cert, --key or --profile',
            fix: 'lipa signing import --cert cert.pem --key key.pem --profile App.mobileprovision',
          });
        }

        const result = await importSigning({
          cert,
          key,
          profile,
          team: stringValue(args.values, 'team'),
        });

        return {
          data: result,
          text: [
            `Imported the identity for ${result.team}`,
            renderTable(
              [
                { name: 'Bundle id', value: result.bundleId },
                { name: 'Profile', value: result.profile },
                { name: 'Certificate', value: result.cert },
                { name: 'Expires', value: result.expires.slice(0, 10) },
              ],
              [
                { header: 'Item', value: (row) => row.name },
                { header: 'Value', value: (row) => row.value },
              ],
            ),
          ].join('\n'),
        };
      },
    },
  ],
};
