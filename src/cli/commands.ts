import { readEvents } from '../infrastructure/events.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { start, resume } from '../workflow/lifecycle.ts';
import { retryDelivery } from '../workflow/delivery.ts';
import { continueRun } from '../workflow/continuation.ts';
import { listRuns } from './runs.ts';
import { readTask } from '../domain/validation.ts';
import { repositoryRoot, loadConfig, initializeSettings } from '../config/settings.ts';
import { watchRun } from './watch.ts';
import { writeRunResult } from './output.ts';
import { usage } from './arguments.ts';
import type { CliCommand } from './arguments.ts';

async function runDirectory(value: string): Promise<string> {
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\'))
    return path.resolve(value);
  return path.join(await repositoryRoot(), '.harness', 'runs', value);
}

export async function executeCommand(command: CliCommand): Promise<void> {
  switch (command.action) {
    case 'help':
      process.stdout.write(usage + '\n');
      return;
    case 'demo':
      await import('../../scripts/demo.ts');
      return;
    case 'demo-review':
      await import('../../scripts/demo-review.ts');
      return;
    case 'init':
      process.stdout.write(JSON.stringify(await initializeSettings(), null, 2) + '\n');
      return;
    case 'events':
      process.stdout.write(
        JSON.stringify(await readEvents(await runDirectory(command.run)), null, 2) + '\n',
      );
      return;
    case 'list':
      process.stdout.write(JSON.stringify(await listRuns(await repositoryRoot()), null, 2) + '\n');
      return;
    case 'continue': {
      const directory = await runDirectory(command.run);
      writeRunResult(directory, await continueRun(directory));
      return;
    }
    case 'status':
      process.stdout.write(
        await readFile(path.join(await runDirectory(command.run), 'state.json'), 'utf8'),
      );
      return;
    case 'run': {
      const root = await repositoryRoot();
      const config = await loadConfig(root, command.configFile);
      const task = readTask(JSON.parse(await readFile(path.resolve(command.taskFile), 'utf8')));
      const result = await start(task, config);
      if (command.watch && result.state.status === 'WAITING_REVIEW') {
        process.stderr.write(`PR published. Run directory: ${result.directory}\n`);
        result.state = await watchRun(result.directory, true);
      }
      writeRunResult(result.directory, result.state);
      return;
    }
    case 'resume': {
      const directory = await runDirectory(command.run);
      const answer =
        'text' in command.answer
          ? command.answer.text
          : await readFile(path.resolve(command.answer.file), 'utf8');
      writeRunResult(directory, await resume(directory, answer));
      return;
    }
    case 'watch': {
      const directory = await runDirectory(command.run);
      writeRunResult(directory, await watchRun(directory, command.loop));
      return;
    }
    case 'retry-delivery': {
      const directory = await runDirectory(command.run);
      writeRunResult(directory, await retryDelivery(directory));
    }
  }
}
