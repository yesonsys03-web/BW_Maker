"""출력 경로의 길이 한계. 윈도우의 MAX_PATH를 걷어내고, 남는 한계는 미리 막는다."""
import os

#: 파일 이름 한 조각의 한계. 윈도우·macOS·리눅스 공통이고, `\\?\` 접두사로도
#: 풀리지 않는다. 긴 한글 레이어 이름이 stem에 덧붙는 분할 내보내기가 실제로
#: 먼저 닿는 한계가 이것이다.
MAX_COMPONENT = 255

#: `\\?\` 접두사를 붙인 뒤의 윈도우 전체 경로 한계.
WINDOWS_MAX_EXTENDED_PATH = 32767


def long_path(path):
    """
    윈도우의 260자 MAX_PATH를 걷어낸 경로. 파일을 실제로 여는 자리에서만 쓴다.

    `\\\\?\\`는 경로 파싱을 통째로 건너뛰므로 절대경로여야 하고 구분자가 전부
    역슬래시여야 한다 — `/`나 `..`가 남아 있으면 실패한다. `os.path.abspath`가
    윈도우에서 둘 다 해준다.

    **반환값·진행 이벤트·에러 메시지에 담기는 경로에는 쓰지 않는다.** 그 문자열은
    UI에 그대로 보이고 프런트의 덮어쓰기 검사와도 대조되므로, 접두사가 새어
    나가면 사용자에게 `\\\\?\\C:\\...`가 보이고 두 경로가 갈라진다.
    """
    text = str(path)
    if os.name != "nt":
        return text
    if text.startswith("\\\\?\\"):
        return text
    full = os.path.abspath(text)
    if full.startswith("\\\\"):          # UNC: \\server\share → \\?\UNC\server\share
        return "\\\\?\\UNC\\" + full[2:]
    return "\\\\?\\" + full


def ensure_writable_path(path):
    """
    쓰기 전에 경로가 파일 시스템 한계를 넘지 않는지 본다. 넘으면 무엇을 줄여야
    하는지 담은 ValueError를 낸다.

    `long_path`가 윈도우의 260자를 걷어내므로 여기서 볼 것은 그것이 아니라,
    접두사로도 풀리지 않는 두 가지다.
    """
    text = str(path)
    name = os.path.basename(text)
    if len(name) > MAX_COMPONENT:
        raise ValueError(
            f"파일 이름이 너무 깁니다 ({len(name)}자, 한계 {MAX_COMPONENT}자): {name}\n"
            "출력 파일명 접미사를 줄이거나, 레이어마다 파일 따로 내보내기를 끄십시오."
        )
    if os.name == "nt":
        full = os.path.abspath(text)
        if len(full) > WINDOWS_MAX_EXTENDED_PATH:
            raise ValueError(
                f"경로가 너무 깁니다 ({len(full)}자, 한계 "
                f"{WINDOWS_MAX_EXTENDED_PATH}자): {text}\n"
                "더 짧은 출력 폴더를 고르십시오."
            )
