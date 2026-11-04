/**
 * The "dev-skin" localStorage hook (UserSettings.getDevOnlySkin, read by
 * getPlayerCosmetics like "dev-crown"): a parity-testing tool for territory
 * skins in both renderers, since skins cannot be equipped without the
 * closed API. Inert unless the key is set.
 */
import { PlayerCosmeticsSchema } from "@openfront/shared/WireSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserMe } from "../../../src/client/Api";
import {
  getPlayerCosmetics,
  invalidateCosmetics,
} from "../../../src/client/Cosmetics";
import { UserSettings } from "../../../src/client/UserSettings";

vi.mock("../../../src/client/Api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/client/Api")>()),
  getApiBase: () => "https://api.test",
  getUserMe: vi.fn(),
}));

const catalog = {
  patterns: {},
  flags: {},
  skins: {
    cool: {
      name: "cool",
      url: "https://cdn.test/skins/cool.png",
      product: null,
      rarity: "rare",
    },
  },
};

const DEV_URL = "http://localhost:9000/dev-skin-test.png";

function resetSettings(): void {
  UserSettings.setPlayerId(null);
  localStorage.clear();
  (
    UserSettings as unknown as { cache: Map<string, string | null> }
  ).cache.clear();
}

describe("dev-skin hook", () => {
  beforeEach(() => {
    invalidateCosmetics();
    resetSettings();
    vi.mocked(getUserMe).mockResolvedValue(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => catalog,
      })),
    );
  });

  afterEach(() => {
    invalidateCosmetics();
    resetSettings();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is inert while the key is unset", async () => {
    expect(new UserSettings().getDevOnlySkin()).toBeUndefined();
    const cosmetics = await getPlayerCosmetics();
    expect(cosmetics.skin).toBeUndefined();
  });

  it("equips the URL as a skin, valid on the wire", async () => {
    localStorage.setItem("dev-skin", DEV_URL);
    expect(new UserSettings().getDevOnlySkin()).toBe(DEV_URL);
    const cosmetics = await getPlayerCosmetics();
    expect(cosmetics.skin).toEqual({ name: "dev_skin", url: DEV_URL });
    // The game start / record schema accepts it unchanged.
    expect(PlayerCosmeticsSchema.parse(cosmetics).skin).toEqual({
      name: "dev_skin",
      url: DEV_URL,
    });
  });

  it("works without the cosmetics catalog (offline dev)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem("dev-skin", DEV_URL);
    const cosmetics = await getPlayerCosmetics();
    expect(cosmetics.skin?.url).toBe(DEV_URL);
  });

  it("leaves the pattern hook alone (both can be set; the renderer gives the skin priority)", async () => {
    localStorage.setItem("dev-skin", DEV_URL);
    localStorage.setItem("dev-pattern", "AAAAAA");
    const cosmetics = await getPlayerCosmetics();
    expect(cosmetics.skin?.url).toBe(DEV_URL);
    expect(cosmetics.pattern?.patternData).toBe("AAAAAA");
  });
});
