"""프리셋 규칙 → 매치 레이어 id 목록 / operation list 변환."""
import re

from .names import has_any_token, token_match, tokenize


def include_terms(value):
    """포함 규칙의 검색값을 쉼표로 나눈 목록. 빈 항목은 버린다.

    쉼표가 없으면 항목 하나짜리 목록이라, 이미 저장된 프리셋은 그대로 동작한다.

    **왜 여러 개가 필요한가.** 토크나이저는 소문자 덩어리를 토큰 하나로 보므로
    `lineart`는 `line`과 다른 토큰이고 영영 안 걸린다. 그 규칙 자체는 옳다 —
    부분 문자열로 보면 `LINEAR DODGE`가 걸린다(names.py). 그래서 규칙을 무르는
    대신 어휘를 늘린다. 납품 캐릭터 100장에서 `lineart -`가 83개였고, 그 판들은
    실패하지도 않아서 눈에 안 띄었다 — `divide lines`(823x8px 주석 구분선) 같은
    것이 대신 걸려 "1장"으로 나가고 있었다. BG 26장에서는 0건이라 영향이 없다.
    """
    return [t.strip() for t in str(value).split(",") if t.strip()]


def _name_matches(name, include):
    kind = include["type"]
    if kind == "contains":
        case_sensitive = bool(include.get("caseSensitive"))
        # 부분 문자열이 아니라 토큰으로 본다 — "LINEAR DODGE"의 앞 네 글자가
        # 걸리면 안 된다(psd_engine/names.py). 검색값이 토큰을 만들지 못하면
        # (예: "-") 예전 규칙으로 되돌아간다.
        terms = [t for t in include_terms(include["value"]) if tokenize(t)]
        if terms:
            return any(token_match(name, t, case_sensitive) for t in terms)
        return _legacy_contains(name, include)
    if kind == "regex":
        flags = 0 if include.get("caseSensitive") else re.IGNORECASE
        return re.search(include["value"], name, flags) is not None
    raise ValueError(f"unknown include type: {kind!r}")


def _legacy_contains(name, include):
    """
    토큰 매칭 이전의 부분 문자열 규칙.

    두 곳에서 쓴다. 검색값이 토큰을 못 만들 때의 대체 동작, 그리고 "예전에는
    걸렸는데 이제는 안 걸린다"를 사람에게 알려주는 보고다.
    """
    if include["type"] != "contains":
        return False
    # 여기서도 쉼표 목록을 본다. 안 그러면 `-, line` 같은 값에서 "예전에는
    # 걸렸는데 이제는 안 걸린다" 보고가 통째로 틀린다.
    terms = include_terms(include["value"]) or [include["value"]]
    if include.get("caseSensitive"):
        return any(t in name for t in terms)
    lowered = name.lower()
    return any(t.lower() in lowered for t in terms)


#: 픽셀을 들고 있어도 결과물에 넣지 않는 종류. 라인 PSD 안의 텍스트는 사실상
#: 언제나 작업 메모다 — 실제로 만난 예가 "NOTE FOR LINE: apply penthouse
#: wallpaper to this wall"이다. 포토샵이 텍스트도 래스터화해서 저장하기 때문에
#: 픽셀 유무로는 걸러지지 않으므로 종류로 못박는다.
NON_ART_KINDS = frozenset({"type"})

#: 매칭에서 빠진 이유.
SKIP_TEXT = "text"
SKIP_NO_PIXELS = "noPixels"
#: 이름에 검색어가 부분 문자열로는 들어있지만 토큰으로는 아니다("LINEAR DODGE").
SKIP_NOT_LINE_WORD = "notLineWord"
#: 그룹 이름이 걸려 딸려올 뻔했지만, 그 그룹 안에 자기 이름으로 걸리는 leaf가
#: 이미 있어서 뺐다.
SKIP_GROUP_HAS_OWN_LINE = "groupHasOwnLine"

#: 이름에 제외 토큰이 들어있다.
SKIP_EXCLUDED_TOKEN = "excludedToken"

#: 합성 모드가 normal이 아니다. 라인 아트는 normal로 그린다 — 실파일 25개의
#: 진짜 라인 645장이 전부 normal이었고, normal이 아닌 11장은 전부 오탐이었다.
SKIP_BLEND_MODE = "blendMode"

#: 이름에 line이 있어도 라인 아트가 아닌 것을 걸러내는 토큰. 실제 파일에서
#: `line col`, `LINE_COL`, `Line Colour`, `Wall_Line_Col`이 18장 나왔다.
#: 프리셋이 덮어쓸 수 있다 — 네 규칙 중 이것만 어휘에 의존하기 때문이다.
#: src/lib/presets.ts의 DEFAULT_EXCLUDE_TOKENS와 같은 값이어야 한다.
#:
#: `height`는 키 기준선을 뺀다(`CHARACTER HEIGHT LINE` 등). 이름에 line이 들어 있어
#: include 규칙에 걸리지만 선화가 아니라 참고선이다. 아티스트가 2026-08-10에 지목했다.
#:
#: **구가 아니라 단일 토큰이어야 한다.** `has_any_token`은 이름의 토큰 하나하나를
#: 비교하므로 "height line"처럼 두 낱말을 넣으면 영영 안 걸린다.
#:
#: 넣기 전에 두 폴더를 전수로 셌다 — `EXTRA REFS`를 BG에서만 확인하고 캐릭터
#: 프리셋에 넣었다가 한 장의 진짜 선화 후보를 빼먹은 적이 있어서다:
#:
#:     캐릭터 100장  include('line') 잎 1012개 중 height 토큰 120개 (79장)
#:                   전부 HEIGHT LINE 변형(HEIGHT LINE 49 / CHARACTER ~ 37 /
#:                   CHARLIE ~ 31 / 공백·Copy 변형 3). **오탐 0.**
#:     BG 26장       0개
#:
#: 지금 실제로 내보내지던 것은 36장 72잎이다. 오버레이는 영향 없다 — 키 기준선이
#: 뷰 바깥에 있어 `character._line_leaves`가 애초에 보지 않는다(전수 0건).
DEFAULT_EXCLUDE_TOKENS = ["col", "colour", "color", "height"]


def _leaf_skip_reason(node, exclude_tokens):
    """
    후보로 잡힌 leaf를 그래도 빼야 하는 이유. 뺄 이유가 없으면 None.

    빠지는 게이트가 여기 한 곳에만 있어야 한다 — 규칙 ②가 "이 leaf는 알아서
    걸린다"고 판단하는 근거와 실제로 걸러내는 자리가 갈라지면, 판단은 살아남는다고
    보는데 실제로는 빠지는 leaf가 생긴다(_exports_itself).
    """
    if node["kind"] in NON_ART_KINDS:
        return SKIP_TEXT
    # hasPixels가 없는 트리는 이 필드가 생기기 전의 것이다. 그때의 유일한
    # 통과 조건이 kind == "pixel"이었으므로 그대로 유지한다.
    if not node.get("hasPixels", node["kind"] == "pixel"):
        return SKIP_NO_PIXELS
    if has_any_token(node["name"], exclude_tokens):
        return SKIP_EXCLUDED_TOKEN
    # blendMode가 없는 트리는 이 필드가 생기기 전의 것이다. 그때는 모두
    # 통과했으므로 normal로 본다.
    if node.get("blendMode", "normal") != "normal":
        return SKIP_BLEND_MODE
    return None


def _hidden(node, preset):
    """
    숨겨서 뺄 레이어인가. 위의 사유들과 달리 이것은 skip 기록을 남기지 않는다 —
    사용자가 프리셋에서 직접 끈 것이라 알려줄 이유가 없다. 그래서 따로 둔다.
    """
    return not node["visible"] and not preset.get("includeHidden", True)


def _exports_itself(node, preset, exclude_tokens):
    """
    이 leaf가 그룹 이름의 도움 없이 혼자서 결과물에 들어가는가.

    이름이 걸리는지만 봐서는 안 된다. 뒤의 게이트에서 빠질 leaf를 근거로 그룹의
    일괄 포함을 끄면, 단서 없는 형제들까지 함께 사라져 그 그룹에서 아무것도
    안 나온다. walk의 leaf 판정과 같은 게이트를 같은 순서로 묻는다.
    """
    return (_name_matches(node["name"], preset["include"])
            and not _hidden(node, preset)
            and _leaf_skip_reason(node, exclude_tokens) is None)


def _has_own_match(nodes, preset, prefixes, exclude_tokens):
    """
    하위 트리에 혼자 힘으로 결과물에 들어가는 leaf가 있는가.

    이것이 있으면 그룹의 일괄 포함은 더할 것이 없다 — 그 leaf들이 알아서
    걸린다. 없을 때만 그룹 이름이 유일한 단서다.
    """
    for node in nodes:
        if node["kind"] == "group":
            if prefixes and node["name"].startswith(prefixes):
                continue
            if _has_own_match(node["children"], preset, prefixes, exclude_tokens):
                return True
        elif _exports_itself(node, preset, exclude_tokens):
            return True
    return False


def match_preset(tree, preset):
    """
    규칙에 걸린 레이어 id와, 걸렸지만 그릴 수 없어 뺀 레이어들을 돌려준다.

    예전에는 픽셀 레이어가 아니면 예외를 던졌다. 그런데 실제 작업 파일에는 이름에
    line이 들어간 메모 텍스트와, 진짜 라인인 스마트오브젝트가 흔히 섞여 있다.
    그것 하나 때문에 파일 전체가 실패하면 아무것도 못 뽑는다.

    그래서 종류가 아니라 "그릴 픽셀이 있는가"로 가른다 — 스마트오브젝트와 셰이프는
    래스터화된 채널을 함께 저장하므로 픽셀 레이어와 똑같이 렌더된다. 다만 텍스트는
    픽셀이 있어도 뺀다(NON_ART_KINDS). 뺀 것은 조용히 버리지 않고 함께 돌려준다.

    다만 noPixels만은 두 가지를 더 묻고 알린다. 이 사유는 "이름은 LINE인데 결과에
    없다"를 알리려고 있는 것인데, 실파일 24개에서 47장이 나왔고 열어보니 대부분
    알릴 것이 아니었다(자세한 근거는 tests/test_matching.py의 같은 절).

      - 자기 이름이 걸린 것만 알린다. 그룹 이름에 딸려온 자식(`LINE KEY BOARD`의
        `bell`, `KEYS`)은 라인으로 지목된 적이 없다.
      - 같은 그룹에서 라인이 하나라도 나왔으면 알리지 않는다. 그 자리의 그림은
        결과물에 들어갔다 — 복제 템플릿의 안 쓰는 슬롯(`secondary_line`)이 이렇다.

    남는 것은 "그 자리에서 라인이 한 장도 안 나왔다"뿐이고, 그것만이 파일을 열어볼
    이유가 된다. 47 → 11장이 되고 납품 폴더 25개는 4 → 4장으로 그대로다.
    """
    matched = []
    skipped = []
    #: 결과에 라인이 하나라도 들어간 그룹의 경로. 두 번째 물음의 답이다. 그룹이
    #: 무엇을 냈는지는 walk가 끝나야 알 수 있으므로 판정은 뒤로 미룬다.
    producing_parents = set()
    prefixes = tuple(preset.get("excludeGroupPrefixes", []))
    exclude_tokens = preset.get("excludeTokens", DEFAULT_EXCLUDE_TOKENS)

    def _skip(node, reason):
        skipped.append({
            "id": node["id"],
            "path": "/".join(node["path"]),
            "kind": node["kind"],
            "reason": reason,
        })

    def walk(nodes, inside_matched_group, inside_suppressed):
        for node in nodes:
            if node["kind"] == "group":
                if prefixes and node["name"].startswith(prefixes):
                    continue
                hit = preset.get("matchGroups", True) and _name_matches(
                    node["name"], preset["include"]
                )
                # 걸린 그룹이라도 안에 진짜 라인이 있으면 일괄 포함을 끈다.
                blanket = hit and not _has_own_match(
                    node["children"], preset, prefixes, exclude_tokens
                )
                walk(node["children"],
                     inside_matched_group or blanket,
                     inside_suppressed or (hit and not blanket))
                continue
            self_hit = _name_matches(node["name"], preset["include"])
            if not (self_hit or inside_matched_group):
                if inside_suppressed:
                    _skip(node, SKIP_GROUP_HAS_OWN_LINE)
                # 예전 규칙으로는 걸렸을 이름이라면 왜 빠졌는지 남긴다. 이름이
                # LINE인데 결과에 없으면 사람이 이유를 알 방법이 없다.
                elif _legacy_contains(node["name"], preset["include"]):
                    _skip(node, SKIP_NOT_LINE_WORD)
                continue
            if _hidden(node, preset):
                continue
            reason = _leaf_skip_reason(node, exclude_tokens)
            if reason:
                if reason == SKIP_NO_PIXELS:
                    if not self_hit:
                        continue
                    _skip(node, reason)
                    # 뒤에서 걸러내기 위한 자리 표시. 돌려주기 전에 지운다.
                    skipped[-1]["_parent"] = "/".join(node["path"][:-1])
                    continue
                _skip(node, reason)
                continue
            matched.append(node["id"])
            producing_parents.add("/".join(node["path"][:-1]))

    walk(tree, False, False)

    def _worth_reporting(entry):
        # _parent가 없으면 noPixels가 아니다 — 그 사유들은 그대로 둔다.
        parent = entry.pop("_parent", None)
        return parent is None or parent not in producing_parents

    return matched, [s for s in skipped if _worth_reporting(s)]


#: 역할 접미사의 기본값. 요소 이름에서 이 접미사를 떼어내 "같은 요소"를 알아낸다
#: (CHAIR1_UL, CHAIR1_OL → CHAIR1). 어디에도 걸리지 않는 레이어는 BG로 묶인다.
DEFAULT_ROLE_TOKENS = ["UL", "OL_UL", "OL"]

#: 그룹 이름과 역할 토큰 사이에 쓰이는 구분자. `CHAIR2_UL`, `CHAIR2-UL`, `CHAIR2 UL`.
_ROLE_SEPARATORS = ("_", "-", " ")

#: 깊이 평면 토큰. 애니메이션 BG의 표준 납품 단위이고, 그룹 이름 앞에 붙는다
#: (`MG L BUILDING`, `FG R`). 아래→위 순서이며 아무 데도 안 걸리면 BG로 간다.
DEFAULT_PLANE_TOKENS = ["BG", "MG", "FG"]

#: 자동 병합이 "무엇을 한 덩어리로 볼지" 고르는 기준. 실제 파일마다 명명 규칙이
#: 달라서 하나로 고정할 수 없다 — 같은 컷에서도 규칙에 따라 결과가 2장/8장/3장으로
#: 갈린다. 그래서 고르게 두고, UI가 규칙별 결과 장수를 미리 보여준다.
MERGE_RULES = ("role", "group", "plane")


def _match_role(name, tokens_longest_first):
    """
    이름이 역할 토큰으로 끝나면 그 토큰을 돌려준다.

    "포함"이 아니라 "접미사"로 보는 것이 중요하다 — `WALL_OLD`나 `BOULDER`가
    OL/UL로 오인되면 안 된다. 토큰은 긴 것부터 검사해야 `CHAIR_OL_UL`이 `UL`로
    잘리지 않는다.
    """
    upper = name.strip().upper()
    for token in tokens_longest_first:
        t = token.strip().upper()
        if not t:
            continue
        if upper == t:
            return token
        if any(upper.endswith(sep + t) for sep in _ROLE_SEPARATORS):
            return token
    return None


def element_of(path, tokens_longest_first):
    """
    레이어가 속한 "요소" 이름. 자기 이름부터 가까운 조상 그룹 순으로 올라가며
    역할 접미사가 붙은 첫 이름을 찾아 그 접미사를 떼어낸다
    (`*ART / CHAIR1_UL / LINE` → `CHAIR1`). 못 찾으면 None = BG.

    같은 요소의 UL/OL이 한 이름으로 모이게 하는 것이 목적이다.
    """
    for name in reversed(path):
        role = _match_role(name, tokens_longest_first)
        if role is None:
            continue
        stripped = name.strip()
        base = stripped[: len(stripped) - len(role)]
        return base.rstrip("".join(_ROLE_SEPARATORS)) or stripped
    return None


def preset_operations(tree, matched_ids, preset, source_stem=None):
    mode = preset.get("merge", "none")
    if mode == "none":
        return []
    if mode == "all":
        if len(matched_ids) < 2:
            return []
        return [{"op": "merge", "layerIds": list(matched_ids), "name": "merged"}]
    if mode == "perGroup":
        matched_set = set(matched_ids)
        groups = {}  # parent id -> (parent name, [leaf ids])

        def walk(nodes, parent):
            for node in nodes:
                if node["kind"] == "group":
                    walk(node["children"], node)
                elif node["id"] in matched_set:
                    key = parent["id"] if parent else -1
                    name = parent["name"] if parent else "root"
                    groups.setdefault(key, (name, []))[1].append(node["id"])

        walk(tree, None)
        return [
            {"op": "merge", "layerIds": ids, "name": name}
            for name, ids in groups.values()
            if len(ids) >= 2
        ]
    if mode == "byElement":
        return auto_merge_operations(tree, matched_ids, preset.get("roleTokens"),
                                     rule=preset.get("mergeRule", "role"))
    raise ValueError(f"unknown merge mode: {mode!r}")


def _group_key(path):
    """
    최상위 그룹 바로 아래의 그룹 이름. `*ART / GROUND / ground / line` → `GROUND`.
    세 파일 모두에서 이 단계가 의미 단위였다(GROUND / MG L BUILDING / CHAIR1_UL …).
    """
    ancestors = path[:-1]
    if not ancestors:
        return None
    return ancestors[1] if len(ancestors) > 1 else ancestors[0]


def _plane_key(path, plane_tokens):
    """
    깊이 평면(BG/MG/FG). 평면은 바깥쪽 그룹 이름 앞에 붙으므로 위에서부터 훑고,
    아무 데도 안 걸리면 BG로 본다.
    """
    for name in path[:-1]:
        head = name.strip().upper()
        for token in plane_tokens:
            t = token.strip().upper()
            if head == t or head.startswith(t + " ") or head.startswith(t + "_") or head.startswith(t + "-"):
                return token
    return None


def _merge_key(path, rule, role_tokens_longest_first, plane_tokens):
    if rule == "role":
        return element_of(path, role_tokens_longest_first)
    if rule == "group":
        return _group_key(path)
    if rule == "plane":
        return _plane_key(path, plane_tokens)
    raise ValueError(f"unknown merge rule: {rule!r}")


def _bucket(tree, matched_ids, rule, role_tokens, plane_tokens):
    """규칙에 따라 leaf id를 덩어리로 나눈다. 키가 없으면(=규칙에 안 걸리면) BG."""
    tokens = [t for t in (role_tokens or DEFAULT_ROLE_TOKENS) if t and t.strip()]
    longest_first = sorted(tokens, key=len, reverse=True)
    matched_set = set(matched_ids)
    background = []
    buckets = {}

    def walk(nodes):
        for node in nodes:
            if node["kind"] == "group":
                walk(node["children"])
            elif node["id"] in matched_set:
                key = _merge_key(node["path"], rule, longest_first, plane_tokens)
                if key is None or key == "BG":
                    background.append(node["id"])
                else:
                    buckets.setdefault(key, []).append(node["id"])

    walk(tree)
    return background, buckets


def auto_merge_preview(tree, matched_ids, role_tokens=None):
    """
    규칙별로 몇 장이 되는지. 어느 규칙이 이 컷에 맞는지는 파일마다 다르므로,
    누르기 전에 결과를 볼 수 있어야 한다. 화면 숫자와 실제 병합이 갈라지지
    않도록 실제 병합과 같은 분류 함수를 쓴다.
    """
    out = {}
    for rule in MERGE_RULES:
        background, buckets = _bucket(tree, matched_ids, rule, role_tokens, DEFAULT_PLANE_TOKENS)
        names = ([("BG", background)] if background else []) + [(k, v) for k, v in buckets.items()]
        out[rule] = {"layerCount": len(names), "names": [n for n, _ in names]}
    return out


def auto_merge_operations(tree, matched_ids, role_tokens=None, rule="role"):
    """
    선택된 라인들을 한 덩어리씩 묶는 연산 목록.

    rule에 따라 무엇을 한 덩어리로 보는지가 달라진다:
      role  — 역할 접미사를 떼어낸 요소 (CHAIR1_UL + CHAIR1_OL → CHAIR1)
      group — 최상위 그룹 바로 아래 그룹 (GROUND, MG L BUILDING …)
      plane — 깊이 평면 접두사 (BG / MG / FG)
    어느 규칙에도 안 걸린 레이어는 BG로 묶여 맨 아래에 깔린다.

    소스에서는 요소들이 뒤섞여 쌓여 있고 BG 요소가 앞쪽 요소보다 위에 오기도
    한다. 문서 순서를 그대로 쓰면 BG가 위로 올라가므로, 병합 뒤 reorder로
    "맨 아래 BG, 그 위에 나머지"를 못박는다.

    레이어 패널의 버튼과 프리셋의 자동 병합이 같은 함수를 쓴다 — 규칙이 두
    군데로 갈라지면 화면과 배치 실행 결과가 달라진다.
    """
    background, buckets = _bucket(tree, matched_ids, rule, role_tokens, DEFAULT_PLANE_TOKENS)

    ordered = ([("BG", background)] if background else []) + list(buckets.items())
    operations = []
    merged_ids = []
    for name, layer_ids in ordered:
        if not layer_ids:
            continue
        operations.append({"op": "merge", "layerIds": layer_ids, "name": name})
        # 병합 항목 id는 merge 연산 순서대로 -1, -2, ... 로 붙는다
        # (build_export_plan / buildEntries 양쪽 동일).
        merged_ids.append(-len(merged_ids) - 1)

    above = None
    for entry_id in merged_ids:
        operations.append({"op": "reorder", "layerId": entry_id, "aboveId": above})
        above = entry_id

    return operations
