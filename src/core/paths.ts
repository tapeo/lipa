import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  home: string;
  tools: string;
  bin: string;
  signing: string;
  cache: string;
  work: string;
  symbols: string;
  state: string;
}

export function paths(): Paths {
  const home = process.env.LIPA_HOME ?? join(homedir(), '.lipa');

  return {
    home,
    tools: join(home, 'tools'),
    bin: join(home, 'bin'),
    signing: join(home, 'signing'),
    cache: join(home, 'cache'),
    work: join(home, 'work'),
    symbols: join(home, 'symbols'),
    state: join(home, 'state.json'),
  };
}

export function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return path;
}
