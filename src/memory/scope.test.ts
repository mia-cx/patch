import { ChannelType, PermissionsBitField } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { memoryPermissionFailure, resolveMemoryBank } from "./scope.js";

const { ViewChannel, ReadMessageHistory, ManageMessages, ManageGuild } =
  PermissionsBitField.Flags;
const readable = [ViewChannel, ReadMessageHistory];

describe("Discord memory scopes", () => {
  // Proves shared inspection and deletion follow the caller's actual Discord permissions.
  it.each([
    ["channel", "read", readable, true],
    ["server", "read", readable, true],
    ["channel", "read", [ReadMessageHistory], false],
    ["channel", "forget", readable, false],
    ["server", "forget", [...readable, ManageMessages], false],
    ["channel", "forget", [...readable, ManageMessages], true],
    ["server", "forget", [...readable, ManageGuild], true],
  ] as const)("checks %s %s", (scope, operation, permissions, allowed) => {
    const failure = memoryPermissionFailure(scope, operation, {
      guildId: "server",
      memberPermissions: new PermissionsBitField([...permissions]),
    });
    expect(failure === undefined).toBe(allowed);
  });

  // Proves personal scope in a server resolves the invoking user's DM, never that server/channel.
  it("resolves the invoking user's personal bank in any context", async () => {
    const createDM = vi.fn(async () => ({ id: "own-dm" }));
    const bank = await resolveMemoryBank("personal", {
      guildId: "server",
      channelId: "public-channel",
      channel: { type: ChannelType.GuildText },
      user: { createDM },
    });
    expect(bank.bank).toBe("discord:dm:own-dm");
    expect(bank.channelId).toBe("own-dm");
    expect(createDM).toHaveBeenCalledOnce();
  });

  // Proves a DM inspection needs no new Discord request and shared banks cannot be chosen there.
  it("uses the current DM and refuses shared scopes outside a guild", async () => {
    const createDM = vi.fn(async () => ({ id: "unused" }));
    const interaction = {
      guildId: null,
      channelId: "own-dm",
      channel: { type: ChannelType.DM },
      user: { createDM },
    };
    expect((await resolveMemoryBank("personal", interaction)).bank).toBe(
      "discord:dm:own-dm",
    );
    await expect(resolveMemoryBank("server", interaction)).rejects.toThrow();
    expect(createDM).not.toHaveBeenCalled();
  });

  // Proves shared bank IDs come from the current signed interaction rather than arbitrary user input.
  it("derives channel and server banks from their Discord IDs", async () => {
    const interaction = {
      guildId: "server",
      channelId: "channel",
      channel: { type: ChannelType.GuildText },
      user: { createDM: vi.fn(async () => ({ id: "unused" })) },
    };
    expect((await resolveMemoryBank("channel", interaction)).bank).toBe(
      "discord:channel:channel",
    );
    expect((await resolveMemoryBank("server", interaction)).bank).toBe(
      "discord:guild:server",
    );
  });
});
