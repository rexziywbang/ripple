export type SendResult =
  | { ok: true; providerMessageId: string; threadId: string; simulated: boolean; sentAt: number }
  | { ok: false; kind: "transient" | "permanent" | "uncertain"; error: string };

export type EmailAdapter = {
  provider: "gmail";
  mode: "demo" | "live";
  send(args: { idempotencyKey: string; to: { name: string; email: string }[]; subject: string; body: string; threadId?: string | null }): Promise<SendResult>;
  /** Reconciles an uncertain send: returns the provider id if a message with this idempotency key was actually delivered. */
  findSent(idempotencyKey: string): Promise<{ providerMessageId: string; threadId: string } | null>;
};

export type FileWriteResult =
  | { ok: true; revision: string; simulated: boolean }
  | { ok: false; kind: "conflict" | "transient" | "permanent"; error: string; currentRevision?: string };

export type FileAdapter = {
  provider: "dropbox";
  mode: "demo" | "live";
  write(args: { path: string; content: string; expectedRevision: string | null }): Promise<FileWriteResult>;
  read(path: string): Promise<{ content: string; revision: string } | null>;
};

export type InvitationResult = { ok: true; simulated: boolean; recipientCount: number; receiptId: string } | { ok: false; kind: "manual"; instructions: string };

export type InvitationAdapter = {
  provider: "invitations";
  mode: "demo" | "live";
  update(args: { idempotencyKey: string; text: string; recipientCount: number }): Promise<InvitationResult>;
};
