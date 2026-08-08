import { expect, test } from "vitest";
import { batchOutcome, describeVerification } from "./verifyReport";
import type { Verification } from "./types";

const layer = (name: string, over: Partial<Verification["layers"][0]> = {}) => ({
  name,
  nameOk: true,
  pixelChecked: true,
  pixelOk: true as boolean | null,
  ...over,
});

const base: Verification = {
  ok: true,
  canvasOk: true,
  layerCountOk: true,
  expectedLayers: 2,
  actualLayers: 2,
  layers: [layer("BG"), layer("MG")],
};

test("a verification that passed has nothing to explain", () => {
  expect(describeVerification(base)).toBeNull();
});

test("a canvas mismatch is named first — it makes every layer suspect", () => {
  const v = { ...base, ok: false, canvasOk: false };
  expect(describeVerification(v)).toBe("캔버스 크기가 원본과 다릅니다");
});

test("a layer-count mismatch says both numbers", () => {
  const v = { ...base, ok: false, layerCountOk: false, expectedLayers: 21, actualLayers: 19 };
  expect(describeVerification(v)).toBe("레이어 수가 다릅니다 — 기대 21장, 실제 19장");
});

test("layers whose pixels differ are listed by name", () => {
  const v = {
    ...base,
    ok: false,
    layers: [layer("BG"), layer("MG", { pixelOk: false }), layer("FG", { pixelOk: false })],
  };
  expect(describeVerification(v)).toBe("픽셀이 원본과 다른 레이어 2개: MG, FG");
});

test("a wrong name is its own kind of mismatch", () => {
  const v = { ...base, ok: false, layers: [layer("BG"), layer("MG", { nameOk: false })] };
  expect(describeVerification(v)).toBe("이름이 다르게 쓰인 레이어 1개: MG");
});

test("a long list of layers is cut short rather than filling the row", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const v = { ...base, ok: false, layers: names.map((n) => layer(n, { pixelOk: false })) };
  expect(describeVerification(v)).toBe("픽셀이 원본과 다른 레이어 7개: a, b, c, d, e 외 2개");
});

test("every kind that failed is reported, not just the first", () => {
  const v: Verification = {
    ok: false,
    canvasOk: false,
    layerCountOk: false,
    expectedLayers: 3,
    actualLayers: 2,
    layers: [layer("BG", { pixelOk: false })],
  };
  expect(describeVerification(v)).toBe(
    ["캔버스 크기가 원본과 다릅니다", "레이어 수가 다릅니다 — 기대 3장, 실제 2장", "픽셀이 원본과 다른 레이어 1개: BG"].join(
      "\n"
    )
  );
});

test("a layer that was never pixel-checked is not called a mismatch", () => {
  // 소스가 둘 이상인 병합 항목은 픽셀 검사를 건너뛴다(pixelOk는 null). 검사하지
  // 않은 것을 틀렸다고 적으면 병합이 있는 파일마다 없는 문제가 보고된다.
  const v = { ...base, ok: false, layers: [layer("merged", { pixelChecked: false, pixelOk: null })] };
  expect(describeVerification(v)).toBeNull();
});

// --- 세 갈래로 나누기 ---
// 예전에는 "썼는데 검증이 어긋났다"와 "아예 못 썼다"가 똑같이 실패였다.

test("a clean run is a success", () => {
  expect(batchOutcome({ ok: true, outputPath: "/out.psd" })).toBe("ok");
});

test("an exception means nothing was written", () => {
  expect(batchOutcome({ ok: false, error: { message: "boom", traceback: "" } })).toBe("failed");
});

test("no exception but not ok means it was written and did not match", () => {
  // 검증 불일치는 예외가 아니라 결과값이라 error가 없다. 산출물은 디스크에 있다.
  expect(batchOutcome({ ok: false, outputPath: "/out.psd" })).toBe("check");
});
