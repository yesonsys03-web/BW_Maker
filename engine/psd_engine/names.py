"""레이어 이름을 토큰으로 쪼개고 비교한다.

`contains "line"`을 부분 문자열로 보면 "LINEAR DODGE"의 앞 네 글자가 걸린다.
그렇다고 `\\blines?\\b` 같은 정규식으로 바꾸면 정규식의 `\\b`가 `_`에서 끊기지
않아 `Wall_Line`, `Ring_Line` 같은 진짜 라인 43장이 같이 날아간다. 그래서
직접 토큰을 나눈다.

src/lib/layerNames.ts가 같은 규칙의 거울이다 — 프리셋을 적용하기 전 "라인만"
패널이 엔진과 다른 답을 내면 안 된다. 한쪽을 고치면 다른 쪽도 고쳐야 한다.
"""
import re

#: 토큰 하나. 숫자 덩어리 / 연속 대문자(뒤에 소문자가 오지 않는 것) /
#: 대문자로 시작하는 낱말 / 소문자 덩어리. 그 사이의 `_`, `-`, 공백, 괄호는
#: 자연히 구분자가 된다.
#:
#: lookbehind를 쓰지 않는 것이 중요하다 — 거울인 layerNames.ts가 시스템
#: 웹뷰에서 도는데 lookbehind는 Safari 16.4부터다.
_TOKEN = re.compile(r"[0-9]+|[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+")


def tokenize(name):
    """이름의 토큰 목록. ASCII 영숫자가 없으면 빈 목록이다."""
    return _TOKEN.findall(name)


def _token_eq(token, want, case_sensitive):
    if not case_sensitive:
        token, want = token.lower(), want.lower()
    if token == want:
        return True
    # 복수형 s를 받아준다 — 'line'으로 찾을 때 'LINES'(103장)가 빠지면 안 된다.
    # 대소문자를 지키는 모드에서도 S/s 둘 다 받는다.
    return len(token) == len(want) + 1 and token[:-1] == want and token[-1] in ("s", "S")


def token_match(name, value, case_sensitive=False):
    """
    이름의 토큰 열에 검색값의 토큰 열이 연속으로 나타나는가.

    검색값이 토큰을 하나도 만들지 못하면(예: "-") False다. 그 경우 부분 문자열로
    되돌아갈지는 호출자가 정한다 — 여기서 정하면 되돌아가는 규칙이 숨는다.
    """
    want = tokenize(value)
    if not want:
        return False
    have = tokenize(name)
    span = len(want)
    for i in range(len(have) - span + 1):
        if all(_token_eq(have[i + j], want[j], case_sensitive) for j in range(span)):
            return True
    return False


def has_any_token(name, wanted, case_sensitive=False):
    """이름의 토큰 중 하나라도 wanted에 있는가."""
    have = tokenize(name)
    return any(
        _token_eq(token, w, case_sensitive)
        for token in have
        for w in wanted
        if w and w.strip()
    )
