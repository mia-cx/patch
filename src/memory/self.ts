import { createHash } from "node:crypto";
import { type Client, Team } from "discord.js";
import { Schema } from "effect";
import { EvidenceSourceMetadataSchema } from "./evidence.js";

const Text = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.isMaxLength(256),
);
const Name = Schema.String.check(
  Schema.isPattern(/^\S(?:.*\S)?$/u),
  Schema.isMaxLength(128),
);
const Id = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

/** A team member's statement about Patch, saved in her voice and bound to her self entity. */
export const SelfStatementRequestSchema = Schema.Struct({
  bank: Text,
  request_id: Text,
  source: Schema.Struct({
    id: Text,
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    /** Patch's stable identity (her Discord user ID), never her display name. */
    entity_id: Text,
    label: Name,
    aliases: Schema.Array(Name).check(Schema.isMaxLength(8)),
    text: Schema.String.check(
      Schema.isPattern(/\S/u),
      Schema.makeFilter((text) => Array.from(text).length <= 4096),
    ),
    observed_at: Schema.String.check(Schema.isMaxLength(64)),
  }),
});
export const SelfStatementReceiptSchema = Schema.Struct({
  object: Schema.Literal("remora.memory.assistant"),
  version: Schema.Literal(1),
  bank: Text,
  request_id: Text,
  kind: Schema.Literal("evidence"),
  source: EvidenceSourceMetadataSchema,
  saved_ids: Schema.Array(Id).check(Schema.isMaxLength(1)),
  active_ids: Schema.Array(Id).check(Schema.isMaxLength(1)),
  status: Schema.Literals(["saved", "forgotten"]),
  /** The standalone statements stored about Patch. */
  atoms: Schema.Array(Schema.String),
  /** Atoms that did not name Patch, and so were not kept. */
  context: Schema.Array(Schema.String),
  /** The self entity's identity digest every kept atom is bound to. */
  subject: Digest,
  linked: Schema.Array(Id),
  replayed: Schema.Boolean,
  admission_identity: Schema.Literal(
    createHash("sha256")
      .update(JSON.stringify("operator-assistant-statement-v1"))
      .digest("hex"),
  ),
});
export type SelfStatementRequest = typeof SelfStatementRequestSchema.Type;
export type SelfStatementReceipt = typeof SelfStatementReceiptSchema.Type;

/**
 * Members of the team that owns this Discord application in the Developer Portal.
 * An application owned by one user (no team) has that user as its only member.
 * Fetched each time, so removal from the team takes effect at once.
 */
export async function isApplicationTeamMember(
  client: Pick<Client, "application">,
  userId: string,
): Promise<boolean> {
  const application = await client.application?.fetch();
  const owner = application?.owner;
  if (!owner) return false;
  return owner instanceof Team
    ? owner.members.has(userId)
    : owner.id === userId;
}
