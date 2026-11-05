/**
 * `three_*` URL parsing and the anti-aliasing plan: AA must not depend on
 * bloom (brief 1.4), the low mode keeps a cheap AA, and the default "high"
 * pipeline stays exactly what it was (bloom + 4× MSAA on the post target
 * below 1.5× pixel ratio).
 */
import { describe, expect, it } from "vitest";
import {
  defaultThreeSettings,
  MSAA_MAX_PIXEL_RATIO,
  planAntialias,
  readThreeSettingsFromUrl,
} from "../../../src/client/render/three/ThreeSettings";

describe("readThreeSettingsFromUrl", () => {
  it("defaults to high quality, bloom, MSAA and no perf tool", () => {
    const s = readThreeSettingsFromUrl("");
    expect(s).toEqual(defaultThreeSettings());
    expect(s.quality).toBe("high");
    expect(s.bloom).toBe(true);
    expect(s.antialias).toBe("msaa");
    expect(s.msaaSamples).toBe(4);
    expect(s.perf).toBe(false);
  });

  it("low quality drops bloom and detail but keeps anti-aliasing", () => {
    const s = readThreeSettingsFromUrl("?three_quality=low");
    expect(s.quality).toBe("low");
    expect(s.bloom).toBe(false);
    expect(s.targetVertices).toBe(150_000);
    expect(s.pixelRatioCap).toBe(1.5);
    expect(s.antialias).toBe("msaa");
  });

  it("lot-4 prototypes are off by default and enabled one by one", () => {
    expect(readThreeSettingsFromUrl("").prototypes).toEqual({
      wakes: false,
      front: false,
      night: false,
    });
    expect(
      readThreeSettingsFromUrl("?three_wakes=1&three_night=true").prototypes,
    ).toEqual({ wakes: true, front: false, night: true });
    expect(readThreeSettingsFromUrl("?three_front=1").prototypes.front).toBe(
      true,
    );
    expect(readThreeSettingsFromUrl("?three_front=0").prototypes.front).toBe(
      false,
    );
  });

  it("parses three_aa", () => {
    const aa = (v: string) =>
      readThreeSettingsFromUrl(`?three_aa=${v}`).antialias;
    expect(aa("fxaa")).toBe("fxaa");
    expect(aa("FXAA")).toBe("fxaa");
    expect(aa("off")).toBe("off");
    expect(aa("0")).toBe("off");
    expect(aa("1")).toBe("msaa");
    expect(aa("msaa")).toBe("msaa");
    expect(aa("smaa")).toBe("msaa"); // unknown: default
  });

  it("parses three_perf, three_bloom and three_tilt", () => {
    expect(readThreeSettingsFromUrl("?three_perf=1").perf).toBe(true);
    expect(readThreeSettingsFromUrl("?three_perf=true").perf).toBe(true);
    expect(readThreeSettingsFromUrl("?three_perf=0").perf).toBe(false);
    expect(readThreeSettingsFromUrl("?three_bloom=0").bloom).toBe(false);
    expect(
      readThreeSettingsFromUrl("?three_quality=low&three_bloom=1").bloom,
    ).toBe(true);
    expect(readThreeSettingsFromUrl("?three_tilt=99").maxTiltDeg).toBe(75);
    expect(readThreeSettingsFromUrl("?three_tilt=-5").maxTiltDeg).toBe(0);
    expect(readThreeSettingsFromUrl("?three_tilt=abc").maxTiltDeg).toBe(50);
  });
});

describe("planAntialias", () => {
  const plan = (search: string, pixelRatio: number) => {
    const s = readThreeSettingsFromUrl(search);
    return planAntialias(s, Math.min(pixelRatio, s.pixelRatioCap));
  };

  it("keeps the default high pipeline: bloom composer with 4× MSAA target", () => {
    expect(plan("", 1)).toEqual({
      contextMsaa: false,
      targetSamples: 4,
      fxaa: false,
      composer: true,
    });
    // At 1.5× and above the resolution smooths edges: no MSAA, as before.
    expect(plan("", MSAA_MAX_PIXEL_RATIO)).toEqual({
      contextMsaa: false,
      targetSamples: 0,
      fxaa: false,
      composer: true,
    });
  });

  it("keeps MSAA without bloom, on the canvas, with no composer", () => {
    expect(plan("?three_bloom=0", 1)).toEqual({
      contextMsaa: true,
      targetSamples: 0,
      fxaa: false,
      composer: false,
    });
    expect(plan("?three_quality=low", 1)).toEqual({
      contextMsaa: true,
      targetSamples: 0,
      fxaa: false,
      composer: false,
    });
    expect(plan("?three_quality=low", 1.25).contextMsaa).toBe(true);
    // Low caps the backing store at 1.5×: high-DPI screens need no MSAA.
    expect(plan("?three_quality=low", 2).contextMsaa).toBe(false);
  });

  it("runs FXAA through the composer, with or without bloom", () => {
    expect(plan("?three_aa=fxaa", 1)).toEqual({
      contextMsaa: false,
      targetSamples: 0,
      fxaa: true,
      composer: true,
    });
    expect(plan("?three_quality=low&three_aa=fxaa", 2)).toEqual({
      contextMsaa: false,
      targetSamples: 0,
      fxaa: true,
      composer: true,
    });
  });

  it("turns everything off with three_aa=off", () => {
    expect(plan("?three_aa=off", 1)).toEqual({
      contextMsaa: false,
      targetSamples: 0,
      fxaa: false,
      composer: true,
    });
    expect(plan("?three_aa=off&three_bloom=0", 1)).toEqual({
      contextMsaa: false,
      targetSamples: 0,
      fxaa: false,
      composer: false,
    });
  });
});
