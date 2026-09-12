export async function open(opts?: { directory?: boolean; multiple?: boolean }) {
  if (opts?.directory) return "/tmp/헬프_예시";
  return ["/tmp/헬프_예시/예시_캐릭터_A.psd", "/tmp/헬프_예시/예시_캐릭터_B.psd",
          "/tmp/헬프_예시/예시_소품.psd"];
}
export async function save(_opts?: unknown) {
  return "/tmp/헬프_예시/내보내기/예시_캐릭터_A_LINE.psd";
}
