import { expect, test } from "vitest";
import { openFailureReport } from "./openReport";

const fail = (name: string, message: string, traceback = "") => ({
  path: `/cuts/${name}`,
  name,
  message,
  traceback,
});

test("nothing failed, nothing to say", () => {
  expect(openFailureReport([])).toBeNull();
});

test("one card names every file that would not open, with its reason", () => {
  const report = openFailureReport([
    fail("a.psd", "unsupported color mode: ColorMode.CMYK (RGB only)"),
    fail("b.psd", "damaged section"),
  ]);

  expect(report?.title).toBe("열지 못한 파일 2개");
  expect(report?.message).toBe(
    ["a.psd — unsupported color mode: ColorMode.CMYK (RGB only)", "b.psd — damaged section"].join("\n")
  );
});

test("the paths ride along in the order the body names them", () => {
  const report = openFailureReport([fail("a.psd", "x"), fail("b.psd", "y")]);
  expect(report?.paths).toEqual(["/cuts/a.psd", "/cuts/b.psd"]);
});

test("tracebacks are kept, each under the file it came from", () => {
  // 카드 하나로 묶어도 진짜 크래시를 조사할 근거는 남아야 한다. ErrorPanel이
  // traceback을 접히는 영역에 그리므로 본문을 밀어내지 않는다.
  const report = openFailureReport([fail("a.psd", "boom", "Traceback...\n  line 1"), fail("b.psd", "bang", "T2")]);

  expect(report?.traceback).toBe("a.psd\nTraceback...\n  line 1\n\nb.psd\nT2");
});

test("a failure with no traceback contributes nothing to that section", () => {
  const report = openFailureReport([fail("a.psd", "boom"), fail("b.psd", "bang", "T2")]);
  expect(report?.traceback).toBe("b.psd\nT2");
});

test("no tracebacks at all leaves the section empty rather than blank-padded", () => {
  expect(openFailureReport([fail("a.psd", "boom")])?.traceback).toBe("");
});
