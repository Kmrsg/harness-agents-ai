/** Compatibility entrypoint: configuration is now initialized in the current repo. */
import { initializeSettings } from '../src/config/settings.ts';
if (process.argv.length > 2)
  throw new Error(
    'Repository paths are no longer accepted. Run agent-harness init from the target repository.',
  );
process.stdout.write(JSON.stringify(await initializeSettings(), null, 2) + '\n');
