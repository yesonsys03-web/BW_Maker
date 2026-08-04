import { expect, test } from "vitest";
import { undrawableReport } from "./skippedReport";
import type { SkippedLayer } from "./engine";

function layer(path: string, kind = "pixel"): SkippedLayer {
  return { id: 0, path, kind, reason: "noPixels" };
}

test("nothing to report is nothing to show", () => {
  expect(undrawableReport([])).toBeNull();
});

test("counts places, not layers — two empty lines in one group are one place", () => {
  // 실제 파일에서 나온 모양이다. 같은 그룹 안에 같은 이름의 빈 LINES가 두 장
  // 있었는데, 사람이 열어볼 자리는 그 그룹 하나다.
  const report = undrawableReport([
    {
      name: "a.psd",
      layers: [layer("BGCU/BG/wall 2/trim/TRIM copy 26/LINES"), layer("BGCU/BG/wall 2/trim/TRIM copy 26/LINES")],
    },
  ]);

  expect(report?.title).toBe("라인이 하나도 안 나온 자리 1곳 (파일 1개)");
  expect(report?.message).toBe("a.psd\n  BGCU/BG/wall 2/trim/TRIM copy 26 — LINES (pixel), LINES (pixel)");
});

test("separate groups are separate places", () => {
  const report = undrawableReport([
    {
      name: "a.psd",
      layers: [layer("BGCU/BG/trim/TRIM copy 27/LINES"), layer("BGCU/BG/trim/TRIM copy 28/LINES")],
    },
    { name: "b.psd", layers: [layer("LayOut/BG/Railing/Railing/LINE")] },
  ]);

  expect(report?.title).toBe("라인이 하나도 안 나온 자리 3곳 (파일 2개)");
  expect(report?.message).toBe(
    [
      "a.psd",
      "  BGCU/BG/trim/TRIM copy 27 — LINES (pixel)",
      "  BGCU/BG/trim/TRIM copy 28 — LINES (pixel)",
      "b.psd",
      "  LayOut/BG/Railing/Railing — LINE (pixel)",
    ].join("\n")
  );
});

test("the kind is kept — an adjustment layer never had pixels to begin with", () => {
  const report = undrawableReport([{ name: "a.psd", layers: [layer("LayOut/BG/line curves", "curves")] }]);

  expect(report?.message).toBe("a.psd\n  LayOut/BG — line curves (curves)");
});

test("a layer at the document root has no group to name", () => {
  const report = undrawableReport([{ name: "a.psd", layers: [layer("LINE")] }]);

  expect(report?.message).toBe("a.psd\n  (최상위) — LINE (pixel)");
});
