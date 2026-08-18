/** 도움말 데모의 프로젝트 파일 I/O — 디스크에 아무것도 쓰지 않는다. */
export async function saveProjectTo(_path: string, _data: unknown): Promise<void> {}
export async function loadProjectFrom(_path: string): Promise<never> {
  throw new Error("데모에서는 프로젝트 열기를 쓰지 않는다");
}
