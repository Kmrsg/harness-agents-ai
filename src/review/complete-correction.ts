import { reply } from './replies.ts';
import { saveState } from '../workflow/state.ts';
import type { RunState } from '../domain/types.ts';

/** Finalize an approved fix after normal or retried delivery using a persisted reply key. */
export async function completeCorrection(directory: string, state: RunState): Promise<void> {
  const record = state.review?.records.find((item) => item.stage === 'fixing');
  if (!record || state.status !== 'WAITING_REVIEW') return;
  record.stage = 'reply';
  record.response = `Изменения по замечанию проверены и отправлены в коммите ${state.commit}.\n\n${record.response ?? 'См. отчёты тестировщика и верификатора.'}\n\nОбязательные проверки и верификатор пройдены.`;
  record.sourceCommit = state.review!.expectedHead;
  record.replyKey = `${state.id}:review:${record.fingerprint}:${record.sourceCommit}`;
  await saveState(directory, state);
  try {
    await reply(directory, state, record);
  } catch (error) {
    state.integrationErrors.push(String(error));
  }
}
