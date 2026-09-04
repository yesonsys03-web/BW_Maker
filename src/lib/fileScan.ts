import type { PsdScan } from "./engine";

/**
 * 폴더 스캔 결과 중 목록만 봐서는 알 수 없는 것들을 한 줄로 옮긴다. 파일이
 * 늘어난 건 목록에서 그대로 보이지만, "왜 이것밖에 안 들어왔는지"(상한에
 * 걸렸거나, 못 연 폴더가 있었거나, 이미 있던 파일이었거나)는 여기서 말하지
 * 않으면 어디에도 안 남는다.
 *
 * @param alreadyPresent 스캔 결과 중 이미 파일 목록에 있던 개수.
 * @returns 알릴 것이 없으면 null.
 */
export function describeScan(scan: PsdScan, alreadyPresent: number): string | null {
  const parts: string[] = [];

  if (scan.files.length === 0) {
    parts.push("PSD 파일을 찾지 못했습니다.");
  } else {
    // 상한 값 자체를 여기 적으면 Rust 쪽 MAX_FILES와 어긋날 수 있으므로,
    // 실제로 담은 개수로 말한다.
    if (scan.truncated) parts.push(`파일이 너무 많아 ${scan.files.length}개까지만 담았습니다.`);
    if (alreadyPresent > 0) parts.push(`${alreadyPresent}개는 이미 목록에 있습니다.`);
  }

  if (scan.skippedDirs > 0) parts.push(`열 수 없는 폴더 ${scan.skippedDirs}개는 건너뛰었습니다.`);

  return parts.length > 0 ? parts.join(" ") : null;
}
