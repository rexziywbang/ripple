import type { ProjectState, Proposal } from "../../shared/types";

export type EmailDraftEdit = { proposalId: string; subject: string; body: string; draftToken: string };
export type LocalEmailDraft = { subject: string; body: string; draftToken: string };
export type DraftReview = { proposals: Proposal[]; drafts: EmailDraftEdit[] };
type DraftInput = Omit<EmailDraftEdit, "proposalId">;

export function emailDraftChanged(proposal: Proposal, draft?: LocalEmailDraft) {
  return !!draft && (draft.subject.trim() !== (proposal.subject || "").trim() || draft.body.trim() !== (proposal.body || "").trim());
}

export function captureEmailDrafts(proposals: readonly Proposal[], drafts: Record<string, LocalEmailDraft>): EmailDraftEdit[] {
  return proposals.flatMap(proposal => {
    const draft = drafts[proposal.id];
    if (proposal.kind !== "email" || !emailDraftChanged(proposal, draft)) return [];
    if (!draft.draftToken || draft.draftToken !== proposal.draftToken)
      throw new Error("This draft changed while you were editing. Review the latest draft before approving.");
    const subject = draft.subject.trim();
    const body = draft.body.trim();
    if (!subject || subject.length > 300 || /[\r\n]/.test(subject))
      throw new Error("Enter a subject between 1 and 300 characters on one line.");
    if (!body || body.length > 12000)
      throw new Error("Enter a message between 1 and 12,000 characters.");
    return [{ proposalId: proposal.id, subject, body, draftToken: draft.draftToken }];
  });
}

const payload = (p: Proposal) => JSON.stringify({
  id: p.id, version: p.version, kind: p.kind, groupId: p.groupId,
  recipient: p.recipient, originalRecipient: p.originalRecipient,
  subject: p.subject, body: p.body, dependencies: p.dependencies,
  patch: p.patch, invitationSnapshot: p.invitationSnapshot,
});
const conflict = () => new Error("The plan or one of these drafts changed. Review the latest details before approving.");

/** Save only reviewed text, then bind approval to the same explicit set of work. */
export async function prepareEditedReview(
  projectId: string,
  review: DraftReview,
  io: {
    readState: () => Promise<ProjectState>;
    saveDraft: (proposalId: string, input: DraftInput) => Promise<ProjectState>;
  },
) {
  const expected = new Map(review.proposals.map(p => [p.id, structuredClone(p)]));
  if (!expected.size || expected.size !== review.proposals.length) throw conflict();
  const editIds = new Set<string>();
  for (const edit of review.drafts) {
    const proposal = expected.get(edit.proposalId);
    if (!proposal || proposal.kind !== "email" || editIds.has(edit.proposalId) || proposal.draftToken !== edit.draftToken) throw conflict();
    editIds.add(edit.proposalId);
  }

  function verify(state: ProjectState, justSaved?: EmailDraftEdit) {
    if (state.project.id !== projectId) throw conflict();
    for (const [id, before] of expected) {
      const current = state.proposals.find(p => p.id === id);
      const edited = justSaved?.proposalId === id;
      const desired = edited ? { ...before, subject: justSaved.subject, body: justSaved.body } : before;
      if (!current || current.status !== "pending" || payload(current) !== payload(desired)) throw conflict();
      if (!edited && (current.approvalToken !== before.approvalToken || current.draftToken !== before.draftToken)) throw conflict();
      if (edited && !current.draftToken) throw conflict();
      expected.set(id, structuredClone(current));
    }
  }

  verify(await io.readState());
  for (const edit of review.drafts) {
    const { proposalId, ...input } = edit;
    verify(await io.saveDraft(proposalId, input), edit);
  }
  return {
    proposalIds: [...expected.keys()],
    approvalTokens: Object.fromEntries([...expected.values()].filter(p => p.approvalToken).map(p => [p.id, p.approvalToken!])),
  };
}
