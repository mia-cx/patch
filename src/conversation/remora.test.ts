import { ChannelType, type Message } from "discord.js";
import { describe, expect, it } from "vitest";
import { evidenceCapabilities } from "../../test/fixtures/evidence.js";
import type { Config } from "../config.js";
import { validateObservationBatch } from "../llm/evidence.js";
import { buildRemoraRequest } from "./remora.js";

const GUILD = "1559060271404945512";
const CHANNEL = "1561529690953490442";
const TRIAL_DM = "1511518474655236270";
const MIA = "209048057441026049";

const config = {
  remoraDmEnabled: true,
  remoraReadBanks: [],
  discordTrialDmChannelId: TRIAL_DM,
  discordTrialGuild: { guildId: GUILD, channelIds: [CHANNEL] },
} as unknown as Config;

const MEMBERS = "1559060271404945599";

/** A message whose channel each listed role can view; `type` picks a thread kind. */
function message(
  place: { guildId: string | null; channelId: string },
  visibleTo: readonly string[] = [GUILD],
  type: ChannelType = ChannelType.GuildText,
) {
  const view = {
    permissionsFor: (role: { id: string }) => ({
      has: () => visibleTo.includes(role.id),
    }),
  };
  const thread =
    type === ChannelType.PublicThread || type === ChannelType.PrivateThread;
  const roles = new Map([GUILD, MEMBERS].map((id) => [id, { id }]));
  return {
    id: "1570576607872024600",
    content: "my sister noor moved to lisbon",
    editedTimestamp: null,
    author: { id: MIA },
    channel: place.guildId
      ? { type, isThread: () => thread, ...(thread ? { parent: view } : view) }
      : { type: ChannelType.DM },
    guild: place.guildId
      ? { id: GUILD, roles: { cache: roles, everyone: roles.get(GUILD) } }
      : null,
    ...place,
  } as unknown as Message;
}

describe("layered memory banks", () => {
  // Proves a server message is written to its channel, its server and its speaker, but reads only shared layers.
  it("writes a channel message to every layer and never reads a user bank in public", () => {
    const request = buildRemoraRequest(
      config,
      message({ guildId: GUILD, channelId: CHANNEL }),
    );
    expect(request).toMatchObject({
      read_banks: [`discord:channel:${CHANNEL}`, `discord:guild:${GUILD}`],
      write_bank: `discord:channel:${CHANNEL}`,
      also_banks: [
        `discord:guild:${GUILD}`,
        {
          bank: `discord:user:${MIA}`,
          actor: {
            bank: `discord:channel:${CHANNEL}`,
            role: "human",
            id: `discord:user:${MIA}`,
          },
        },
      ],
    });
    expect(
      request?.read_banks.some((bank) => bank.startsWith("discord:user:")),
    ).toBe(false);
  });

  // Proves only channels the server's members can see feed the server bank; private places keep channel and speaker layers.
  it("keeps private channels and private threads out of the server bank", () => {
    const place = { guildId: GUILD, channelId: CHANNEL };
    const layers = (request: ReturnType<typeof buildRemoraRequest>) =>
      request?.also_banks?.map((bank) =>
        typeof bank === "string" ? bank : bank.bank,
      );
    const user = `discord:user:${MIA}`;
    const guild = `discord:guild:${GUILD}`;
    expect(layers(buildRemoraRequest(config, message(place, [])))).toEqual([
      user,
    ]);
    expect(
      layers(
        buildRemoraRequest(
          config,
          message(place, [GUILD], ChannelType.PrivateThread),
        ),
      ),
    ).toEqual([user]);
    expect(
      layers(
        buildRemoraRequest(
          config,
          message(place, [GUILD], ChannelType.PublicThread),
        ),
      ),
    ).toEqual([guild, user]);
    // With a members role, a channel hidden from @everyone but open to members is public.
    expect(
      layers(buildRemoraRequest(config, message(place, [MEMBERS]), MEMBERS)),
    ).toEqual([guild, user]);
    expect(
      layers(buildRemoraRequest(config, message(place, [GUILD]), MEMBERS)),
    ).toEqual([user]);
  });

  // Proves a DM uses the person's own bank, and only the trial DM also reads its earlier per-channel bank.
  it("reads and writes the user's bank in a DM, plus the trial DM's earlier bank", () => {
    const trial = buildRemoraRequest(
      config,
      message({ guildId: null, channelId: TRIAL_DM }),
    );
    expect(trial).toMatchObject({
      read_banks: [`discord:user:${MIA}`, `discord:dm:${TRIAL_DM}`],
      write_bank: `discord:user:${MIA}`,
    });
    expect(trial?.also_banks).toBeUndefined();
    const open = buildRemoraRequest(
      {
        ...config,
        discordTrialDmChannelId: "",
        discordTrialGuild: undefined,
      } as Config,
      message({ guildId: null, channelId: "1000000000000000001" }),
    );
    expect(open?.read_banks).toEqual([`discord:user:${MIA}`]);
  });

  // Proves layers need the backend's capability and a speaker layer's actor must belong to the batch's bank.
  it("validates observation layers against the negotiated limit", () => {
    const bank = `discord:channel:${CHANNEL}`;
    const batch = (also_banks: unknown) => ({
      bank,
      id: "batch",
      revision: 0,
      inputs: [],
      also_banks,
    });
    const layered = { ...evidenceCapabilities.limits, max_also_banks: 4 };
    const speaker = {
      bank: `discord:user:${MIA}`,
      actor: { bank, role: "human", id: `discord:user:${MIA}` },
    };
    expect(() =>
      validateObservationBatch(
        batch([`discord:guild:${GUILD}`, speaker]),
        [],
        layered,
      ),
    ).not.toThrow();
    expect(() =>
      validateObservationBatch(
        batch([`discord:guild:${GUILD}`]),
        [],
        evidenceCapabilities.limits,
      ),
    ).toThrow("Invalid observation layers");
    for (const layers of [
      [bank],
      [`discord:guild:${GUILD}`, `discord:guild:${GUILD}`],
      [{ ...speaker, actor: { ...speaker.actor, bank: "elsewhere" } }],
    ])
      expect(() =>
        validateObservationBatch(batch(layers), [], layered),
      ).toThrow("Invalid observation layers");
  });
});
