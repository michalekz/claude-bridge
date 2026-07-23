import { type StateDoc, saveState } from "../state.ts";

/**
 * Every mutation to `state.peers` funnels through here — the daemon is
 * the single writer, so batching + `saveState` centralized in one place
 * makes the audit trail easier to trust.
 */
export async function applyStateChange(
  state: StateDoc,
  mutate: (draft: StateDoc) => void,
): Promise<void> {
  mutate(state);
  await saveState(state);
}
