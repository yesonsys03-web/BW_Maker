"""src/lib/layerNames.test.ts가 이 파일과 글자 그대로 짝을 이루는 거울이다.

두 언어의 정규식 엔진이 갈라지는 지점을 잡아내는 것이 이 테스트 쌍의 유일한
역할이다 — 표본을 한쪽에 추가하면 반드시 다른 쪽에도 추가한다.
"""
from psd_engine.names import has_any_token, token_match, tokenize


def test_splits_on_separators_case_boundaries_and_digits():
    assert tokenize("Wall_Line") == ["Wall", "Line"]
    assert tokenize("CurtainsLine") == ["Curtains", "Line"]
    assert tokenize("line2") == ["line", "2"]
    assert tokenize("CHAIR1_LINE") == ["CHAIR", "1", "LINE"]
    assert tokenize("Layer 866 (LINEAR DODGE)") == ["Layer", "866", "LINEAR", "DODGE"]
    assert tokenize("TopWindowArches_line") == ["Top", "Window", "Arches", "line"]
    assert tokenize("GRAIN_OVERLAY copy") == ["GRAIN", "OVERLAY", "copy"]
    assert tokenize("*ART") == ["ART"]


def test_a_name_with_no_ascii_letters_has_no_tokens():
    # 한글만 있는 이름. 호출자는 이 경우 부분 문자열로 되돌아간다.
    assert tokenize("라인") == []


# 실제 납품 파일에서 온 이름들이다(설계 문서 2절).
def test_line_matches_as_a_word_not_as_a_substring():
    for name in ["line", "LINE", "LINES", "lines", "hidden line", "line ol",
                 "Wall_Line", "Ring_Line", "CurtainsLine", "line2",
                 "TopWindowArches_line", "Wall_OL_Line", "BROKEN WALL LINE"]:
        assert token_match(name, "line"), name

    for name in ["Layer 866 (LINEAR DODGE)", "Linear Light", "Linear dodge 75% ",
                 "kline col", "OUTLINE"]:
        assert not token_match(name, "line"), name


def test_case_sensitive_mode_still_accepts_the_plural():
    # 'LINE'을 대소문자까지 지켜 찾더라도 'LINES'가 빠지면 규칙이 쓸모없다.
    assert token_match("LINES", "LINE", case_sensitive=True)
    assert not token_match("lines", "LINE", case_sensitive=True)


def test_a_multi_token_value_must_appear_consecutively():
    assert token_match("BROKEN WALL LINE", "wall line")
    assert not token_match("WALL fill LINE", "wall line")


def test_has_any_token_finds_the_colour_vocabulary():
    colour = ["col", "colour", "color"]
    for name in ["line col", "LINE_COL", "Line Colour", "line colour", "Wall_Line_Col",
                 "Wall_Cols"]:  # 복수형 허용이 has_any_token에도 걸리는지 확인한다
        assert has_any_token(name, colour), name
    for name in ["COUCH LINE", "line", "Bookcase_Line"]:
        assert not has_any_token(name, colour), name
