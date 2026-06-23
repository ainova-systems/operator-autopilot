import { describe, it, expect, vi } from "vitest";
import { TelegramChannel } from "./telegram.js";
import type { TelegramConfig } from "./telegram.js";

function makeConfig(overrides?: Partial<TelegramConfig>): TelegramConfig {
  return {
    botToken: "123:ABC",
    allowedChatIds: [100, 200],
    ...overrides,
  };
}

function makeFetch(responses: Array<{ ok: boolean; json: () => Promise<unknown> }>) {
  let idx = 0;
  return vi.fn().mockImplementation(async () => {
    const resp = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return resp;
  });
}

const OK_SEND = { ok: true, json: async () => ({ ok: true, result: {} }) };
const OK_UPDATES = (updates: unknown[]) => ({
  ok: true,
  json: async () => ({ ok: true, result: updates }),
});

// ── Construction security ────────────────────────────────────────────

describe("TelegramChannel — security", () => {
  it("throws on empty allowedChatIds", () => {
    expect(() => new TelegramChannel(makeConfig({ allowedChatIds: [] }))).toThrow("allowedChatIds must not be empty");
  });

  it("accepts non-empty allowedChatIds", () => {
    expect(() => new TelegramChannel(makeConfig())).not.toThrow();
  });
});

// ── Outbound ─────────────────────────────────────────────────────────

describe("TelegramChannel — send", () => {
  it("sends to all allowed chats", async () => {
    const fetchFn = makeFetch([OK_SEND, OK_SEND]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    await channel.send({
      event: "pipeline.completed", projectId: "p1",
      title: "Done", body: "Research complete", severity: "info",
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    // Check both chat IDs were targeted
    const body1 = JSON.parse(fetchFn.mock.calls[0][1].body);
    const body2 = JSON.parse(fetchFn.mock.calls[1][1].body);
    expect(body1.chat_id).toBe(100);
    expect(body2.chat_id).toBe(200);
    expect(body1.parse_mode).toBe("Markdown");
  });

  it("formats message with severity icon", async () => {
    const fetchFn = makeFetch([OK_SEND]);
    const channel = new TelegramChannel(makeConfig({ allowedChatIds: [100] }), fetchFn);

    await channel.send({
      event: "e", projectId: "p", title: "Error", body: "Failed", severity: "error",
    });

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.text).toContain("🔴");
  });

  it("formats warning severity with yellow icon", async () => {
    const fetchFn = makeFetch([OK_SEND]);
    const channel = new TelegramChannel(makeConfig({ allowedChatIds: [100] }), fetchFn);

    await channel.send({
      event: "e", projectId: "p", title: "Warn", body: "Slow", severity: "warning",
    });

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.text).toContain("🟡");
  });

  it("throws on API error", async () => {
    const fetchFn = makeFetch([{ ok: false, json: async () => ({}) }]);
    const channel = new TelegramChannel(makeConfig({ allowedChatIds: [100] }), fetchFn);

    await expect(channel.send({
      event: "e", projectId: "p", title: "T", body: "B", severity: "info",
    })).rejects.toThrow("Telegram API sendMessage failed");
  });
});

// ── Inbound — polling ────────────────────────────────────────────────

describe("TelegramChannel — poll", () => {
  it("parses commands from updates", async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 100 }, from: { id: 42, username: "admin" }, text: "/status" } },
      { update_id: 2, message: { chat: { id: 100 }, from: { id: 42 }, text: "just text" } },
      { update_id: 3, message: { chat: { id: 100 }, from: { id: 42, username: "admin" }, text: "/research sample" } },
    ];
    const fetchFn = makeFetch([OK_UPDATES(updates)]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    const commands = await channel.poll();

    expect(commands).toHaveLength(2);
    expect(commands[0].command).toBe("status");
    expect(commands[0].sender).toBe("admin");
    expect(commands[0].source).toBe("telegram");
    expect(commands[1].command).toBe("research");
    expect(commands[1].args).toEqual(["sample"]);
  });

  it("rejects messages from unauthorized chat IDs", async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 999 }, from: { id: 1 }, text: "/status" } },
    ];
    const fetchFn = makeFetch([OK_UPDATES(updates)]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    const commands = await channel.poll();
    expect(commands).toHaveLength(0);
  });

  it("allows messages from authorized chats only", async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 100 }, from: { id: 1, username: "ok" }, text: "/pause" } },
      { update_id: 2, message: { chat: { id: 999 }, from: { id: 2, username: "hacker" }, text: "/pause" } },
      { update_id: 3, message: { chat: { id: 200 }, from: { id: 3, username: "ok2" }, text: "/resume" } },
    ];
    const fetchFn = makeFetch([OK_UPDATES(updates)]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    const commands = await channel.poll();
    expect(commands).toHaveLength(2);
    expect(commands[0].sender).toBe("ok");
    expect(commands[1].sender).toBe("ok2");
  });

  it("uses user ID when username is missing", async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 100 }, from: { id: 42 }, text: "/status" } },
    ];
    const fetchFn = makeFetch([OK_UPDATES(updates)]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    const commands = await channel.poll();
    expect(commands).toHaveLength(1);
    expect(commands[0].sender).toBe("42");
  });

  it("uses 'unknown' when from is missing", async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 100 }, text: "/status" } },
    ];
    const fetchFn = makeFetch([OK_UPDATES(updates)]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    const commands = await channel.poll();
    expect(commands).toHaveLength(1);
    expect(commands[0].sender).toBe("unknown");
  });

  it("handles empty result from getUpdates", async () => {
    const fetchFn = makeFetch([{ ok: true, json: async () => ({ ok: true }) }]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    const commands = await channel.poll();
    expect(commands).toHaveLength(0);
  });

  it("handles updates without text", async () => {
    const updates = [
      { update_id: 1, message: { chat: { id: 100 }, from: { id: 1 } } },
      { update_id: 2 }, // no message at all
    ];
    const fetchFn = makeFetch([OK_UPDATES(updates)]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    const commands = await channel.poll();
    expect(commands).toHaveLength(0);
  });

  it("tracks last update_id for offset", async () => {
    const fetchFn = makeFetch([
      OK_UPDATES([{ update_id: 5, message: { chat: { id: 100 }, from: { id: 1 }, text: "/status" } }]),
      OK_UPDATES([]),
    ]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    await channel.poll(); // first call
    await channel.poll(); // second call should use offset

    const secondCallBody = JSON.parse(fetchFn.mock.calls[1][1].body);
    expect(secondCallBody.offset).toBe(6); // lastUpdateId + 1
  });

  it("returns empty on API error", async () => {
    const fetchFn = makeFetch([{ ok: false, json: async () => ({}) }]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    await expect(channel.poll()).rejects.toThrow("Telegram API");
  });
});

// ── Inbound — webhook ────────────────────────────────────────────────

describe("TelegramChannel — webhook", () => {
  it("processes valid webhook update from allowed chat", () => {
    const channel = new TelegramChannel(makeConfig());
    const cmd = channel.processWebhookUpdate({
      update_id: 1,
      message: { chat: { id: 100 }, from: { id: 42, username: "admin" }, text: "/retry T1" },
    });

    expect(cmd).not.toBeNull();
    expect(cmd!.command).toBe("retry");
    expect(cmd!.args).toEqual(["T1"]);
    expect(cmd!.sender).toBe("admin");
  });

  it("rejects webhook update from unauthorized chat", () => {
    const channel = new TelegramChannel(makeConfig());
    const cmd = channel.processWebhookUpdate({
      update_id: 1,
      message: { chat: { id: 999 }, from: { id: 1 }, text: "/status" },
    });

    expect(cmd).toBeNull();
  });

  it("falls back to user ID in webhook when no username", () => {
    const channel = new TelegramChannel(makeConfig());
    const cmd = channel.processWebhookUpdate({
      update_id: 1,
      message: { chat: { id: 100 }, from: { id: 77 }, text: "/status" },
    });

    expect(cmd).not.toBeNull();
    expect(cmd!.sender).toBe("77");
  });

  it("returns null for non-command messages", () => {
    const channel = new TelegramChannel(makeConfig());
    const cmd = channel.processWebhookUpdate({
      update_id: 1,
      message: { chat: { id: 100 }, from: { id: 1 }, text: "hello" },
    });

    expect(cmd).toBeNull();
  });

  it("returns null for updates without message", () => {
    const channel = new TelegramChannel(makeConfig());
    const cmd = channel.processWebhookUpdate({ update_id: 1 });
    expect(cmd).toBeNull();
  });
});

// ── Webhook setup ────────────────────────────────────────────────────

describe("TelegramChannel — webhook management", () => {
  it("sets up webhook via API", async () => {
    const fetchFn = makeFetch([OK_SEND]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    await channel.setupWebhook("https://example.com/tg-webhook");

    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.url).toBe("https://example.com/tg-webhook");
  });

  it("removes webhook via API", async () => {
    const fetchFn = makeFetch([OK_SEND]);
    const channel = new TelegramChannel(makeConfig(), fetchFn);

    await channel.removeWebhook();

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("deleteWebhook"),
      expect.anything(),
    );
  });
});
