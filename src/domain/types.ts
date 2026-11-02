export const roles = [
  'analyst',
  'frontend-planner',
  'backend-planner',
  'frontend-implementer',
  'backend-implementer',
  'tester',
  'verifier',
  'review-triager',
] as const;
export type Role = (typeof roles)[number];
export type Status = 'COMPLETED' | 'NEEDS_CLARIFICATION' | 'BLOCKED';
export interface Task {
  id: string;
  title: string;
  description: string;
  specPath: string;
  areas: ('frontend' | 'backend')[];
  acceptanceCriteria: { id: string; description: string }[];
}
export interface Command {
  command: string;
  args: string[];
}
export interface Config {
  projectRoot: string;
  runner: Command;
  runnerMode: 'cli' | 'protocol';
  timeoutMs: number;
  maxOutputBytes: number;
  maxInputBytes?: number;
  runnerInput?: 'stdin' | 'argv';
  maxIterations: number;
  maxReworkRetries?: number;
  knowledgeRoot: string;
  git: { enabled: boolean; baseRef: string; publish: boolean };
  checks: (Command & { name: string })[];
  setup?: Command[];
  openspec?: { validator: Command };
  integrations: { bitbucket?: Command; taskTracker?: Command };
}
export interface AgentResult {
  status: Status;
  summary: string;
  artifacts: string[];
  questions: { id: string; question: string; context: string; blocks: string }[];
  acceptance: { id: string; passed: boolean; evidence: string }[];
  verification?: Verification;
  reviewDecision?: {
    action: 'FIX_IMPLEMENTATION' | 'FIX_PLAN' | 'REPLY' | 'CLARIFY';
    response: string;
    evidence: string;
  };
}
export type VerificationPhase = 'plan' | 'implementation';
export interface Finding {
  id: string;
  description: string;
  evidence: string;
  criteria: string[];
  tasks: string[];
}
export interface Verification {
  phase: VerificationPhase;
  verdict: 'APPROVED' | 'REWORK_PLAN' | 'REWORK_IMPLEMENTATION';
  findings: Finding[];
}
export interface Rework {
  phase: VerificationPhase;
  attempt: number;
  findings: Finding[];
}
export interface VerificationState {
  retries: Record<VerificationPhase, number>;
  planApproval?: string;
  implementationApproval?: { plan: string; workspace: string };
}
export interface AgentRequest {
  role: Role;
  task: Task;
  specification: string;
  instructions: string;
  context: { role: Role; result: AgentResult; contents: { path: string; content: string }[] }[];
  clarificationHistory: { questions: AgentResult['questions']; answer: string }[];
  artifactDirectory: string;
  workdir: string;
  openspec: OpenSpecContext;
  verification?: { phase: VerificationPhase; attempt: number };
  rework?: Rework;
  prReview?: { thread: ReviewThread; sourceCommit: string };
  checks?: { name: string; exitCode: number; log: string; output: string }[];
}
export interface Document {
  path: string;
  content: string;
}
export interface OpenSpecChange {
  name: string;
  directory: string;
}
export interface OpenSpecContext extends OpenSpecChange {
  draftDirectory: string;
  files: Document[];
  baselineSpecs: Document[];
}
export interface RunState {
  version: 1;
  id: string;
  task: Task;
  config: Config;
  status: Status | 'RUNNING' | 'WAITING_REVIEW' | 'CANCELLED';
  nextRole?: Role | 'developer';
  iteration: number;
  workdir: string;
  branch?: string;
  results: SavedRoleResult[];
  clarificationHistory: AgentRequest['clarificationHistory'];
  checks: { name: string; exitCode: number; log: string }[];
  summary: string;
  commit?: string;
  pullRequestUrl?: string;
  integrationErrors: string[];
  openspec?: OpenSpecChange;
  verification?: VerificationState;
  rework?: Rework;
  escalation?: { to: 'developer'; phase: VerificationPhase; reason: string; artifact: string };
  deliveryPending?: boolean;
  review?: ReviewState;
  preparation?: { ready: boolean; nextSetup: number; attempts: Record<string, number> };
  checkpoint?: WorkflowCheckpoint;
  interrupted?: boolean;
}

export interface SavedRoleResult {
  role: Role;
  result: AgentResult;
  phase?: VerificationPhase;
  attempt?: number;
  artifactDirectory?: string;
  artifactManifest?: { path: string; sha256: string }[];
}

export interface WorkflowCheckpoint {
  stage:
    | 'analysis'
    | 'planning'
    | 'plan-checks'
    | 'plan-review'
    | 'rework'
    | 'implementation'
    | 'testing'
    | 'implementation-checks'
    | 'implementation-review'
    | 'delivery'
    | 'done';
  index: number;
  attempts: Record<string, number>;
  resultIndex?: number;
  checkStart?: number;
  active?: { role: Role; phase?: VerificationPhase; readOnlyFingerprint?: string };
  workspace?: string;
  head?: string;
  prReview?: AgentRequest['prReview'];
}

export interface ReviewThread {
  id: string;
  resolved: boolean;
  path?: string;
  line?: number;
  comments: { id: string; author: string; body: string; own: boolean }[];
}
export interface PullRequestSnapshot {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  sourceCommit: string;
  threads: ReviewThread[];
}
export interface ReviewRecord {
  threadId: string;
  fingerprint: string;
  attempts: number;
  stage: 'fixing' | 'reply' | 'done' | 'superseded';
  sourceCommit?: string;
  response?: string;
  replyKey?: string;
  repair?: {
    iteration: number;
    phase: VerificationPhase;
    finding: Finding;
    prReview: NonNullable<AgentRequest['prReview']>;
  };
}
export interface ReviewState {
  expectedHead: string;
  records: ReviewRecord[];
  lastCheckedAt?: string;
}
