// Studio server entry point — launched by `forge.ps1 canvas <Name>`.
//
// Reads its config from CLI args / env, builds the project store against the
// repo root, and starts the HTTP server. Opening the browser is the caller's
// job (forge.ps1) so this stays a headless server.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createProjectStore } from './projectStore.js';
import { startServer, moduleDir } from './httpServer.js';

interface Args {
  projectName: string;
  repoRoot: string;
  port: number;
  distDir: string;
}

function parseArgs(argv: string[]): Args {
  const here = moduleDir(import.meta.url);
  // studio/src/server/main.ts -> studio/ -> ../..
  const studioRoot = path.resolve(here, '..', '..');
  const defaultRepoRoot = path.resolve(studioRoot, '..');
  const defaultDist = path.resolve(studioRoot, 'dist');

  let projectName: string | undefined;
  let repoRoot = process.env.STUDIO_REPO_ROOT ?? defaultRepoRoot;
  let port = Number(process.env.STUDIO_PORT ?? 5174);
  let distDir = process.env.STUDIO_DIST_DIR ?? defaultDist;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--project' && argv[i + 1]) {
      projectName = argv[++i];
    } else if (a === '--repo-root' && argv[i + 1]) {
      repoRoot = path.resolve(argv[++i]!);
    } else if (a === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (a === '--dist' && argv[i + 1]) {
      distDir = path.resolve(argv[++i]!);
    } else if (!a.startsWith('--') && projectName === undefined) {
      projectName = a;
    }
  }
  if (!projectName) {
    throw new Error('studio: --project <Name> is required');
  }
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`studio: invalid --port ${port}`);
  }
  return { projectName, repoRoot, port, distDir };
}

async function main(): Promise<void> {
  const { projectName, repoRoot, port, distDir } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(distDir)) {
    // Fail loud rather than mysteriously serving 404s.
    throw new Error(
      `studio: dist directory not found at ${distDir}. Run 'npm --prefix studio run build' first.`,
    );
  }
  const store = createProjectStore({ repoRoot });
  const server = await startServer({ store, projectName, distDir, port });
  // eslint-disable-next-line no-console
  console.log(`studio: serving project '${projectName}' at ${server.url}`);
  // eslint-disable-next-line no-console
  console.log(`studio: repo root = ${repoRoot}`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('studio: fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
