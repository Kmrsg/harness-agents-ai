export const usage = `Usage (Node.js >=22):
  agent-harness init
  agent-harness list
  agent-harness run <task.json> [--config <settings.json>] [--watch]
  agent-harness continue <run-id-or-directory>
  agent-harness resume <run-id-or-directory> <answers.md>
  agent-harness resume <run-id-or-directory> --answer "text"
  agent-harness status <run-id-or-directory>
  agent-harness events <run-id-or-directory>
  agent-harness retry-delivery <run-id-or-directory>
  agent-harness watch <run-id-or-directory> [--loop]
  agent-harness demo
  agent-harness demo-review

The target is the Git repository containing the current directory.
Settings: <repo>/harness.config.json, optional; projectRoot is not a setting.
Exit codes: 0 COMPLETED/WAITING_REVIEW, 2 NEEDS_CLARIFICATION, 3 BLOCKED, 4 CANCELLED, 1 invalid invocation.`;

export type CliCommand =
  | { action: 'help' | 'init' | 'list' | 'demo' | 'demo-review' }
  | { action: 'status' | 'events' | 'retry-delivery' | 'continue'; run: string }
  | { action: 'run'; taskFile: string; configFile?: string; watch: boolean }
  | { action: 'resume'; run: string; answer: { text: string } | { file: string } }
  | { action: 'watch'; run: string; loop: boolean };

/** Parse syntax only: no repository, filesystem or model access. */
export function parseCommand(argv: string[]): CliCommand {
  const [action, ...args] = argv;
  if (!action || action === '--help' || action === '-h') return { action: 'help' };
  switch (action) {
    case 'init':
    case 'list':
    case 'demo':
    case 'demo-review':
      if (!args.length) return { action };
      break;
    case 'events':
    case 'status':
    case 'retry-delivery':
    case 'continue':
      if (args.length === 1) return { action, run: args[0] };
      break;
    case 'run': {
      const watch = args.at(-1) === '--watch';
      if (watch) args.pop();
      if (args.length === 1 || (args.length === 3 && args[1] === '--config')) {
        return { action, taskFile: args[0], configFile: args[2], watch };
      }
      break;
    }
    case 'resume':
      if (args.length === 2 && args[1] !== '--answer')
        return { action, run: args[0], answer: { file: args[1] } };
      if (args.length === 3 && args[1] === '--answer')
        return { action, run: args[0], answer: { text: args[2] } };
      break;
    case 'watch':
      if (args.length === 1 || (args.length === 2 && args[1] === '--loop')) {
        return { action, run: args[0], loop: args[1] === '--loop' };
      }
      break;
  }
  throw new Error(usage);
}
