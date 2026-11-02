import { parseCommand } from './arguments.ts';
import { executeCommand } from './commands.ts';

try {
  await executeCommand(parseCommand(process.argv.slice(2)));
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
