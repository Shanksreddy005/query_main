// A stopped run is not a failed run, and the wording has to stay aligned with the reason text the
// engine throws ('Query cancelled by user'). One owner for both halves of that decision.
export const CANCELLED_RUN_NOTICE = 'Query cancelled. Nothing in the workspace changed.';

export function isUserCancellation(message: string): boolean {
  return /cancell?ed by user/i.test(message);
}
