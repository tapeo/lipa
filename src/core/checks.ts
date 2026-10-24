export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string | undefined;
  skipped?: boolean | undefined;
}
