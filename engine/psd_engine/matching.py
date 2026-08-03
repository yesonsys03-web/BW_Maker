"""프리셋 규칙 → 매치 레이어 id 목록 / operation list 변환."""
import re

from .names import token_match, tokenize


def _name_matches(name, include):
    kind = include["type"]
    if kind == "contains":
        value = include["value"]
        case_sensitive = bool(include.get("caseSensitive"))
        # 부분 문자열이 아니라 토큰으로 본다 — "LINEAR DODGE"의 앞 네 글자가
        # 걸리면 안 된다(psd_engine/names.py). 검색값이 토큰을 만들지 못하면
        # (예: "-") 예전 규칙으로 되돌아간다.
        if tokenize(value):
            return token_match(name, value, case_sensitive)
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
    if include.get("caseSensitive"):
        return include["value"] in name
    return include["value"].lower() in name.lower()


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


def _has_own_match(nodes, include, prefixes):
    """
    하위 트리에 자기 이름으로 걸리는 leaf가 있는가.

    이것이 있으면 그룹의 일괄 포함은 더할 것이 없다 — 그 leaf들이 알아서
    걸린다. 없을 때만 그룹 이름이 유일한 단서다.
    """
    for node in nodes:
        if node["kind"] == "group":
            if prefixes and node["name"].startswith(prefixes):
                continue
            if _has_own_match(node["children"], include, prefixes):
                return True
        elif _name_matches(node["name"], include):
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
    """
    matched = []
    skipped = []
    prefixes = tuple(preset.get("excludeGroupPrefixes", []))

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
                    node["children"], preset["include"], prefixes
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
            if not node["visible"] and not preset.get("includeHidden", True):
                continue
            reason = None
            if node["kind"] in NON_ART_KINDS:
                reason = SKIP_TEXT
            # hasPixels가 없는 트리는 이 필드가 생기기 전의 것이다. 그때의 유일한
            # 통과 조건이 kind == "pixel"이었으므로 그대로 유지한다.
            elif not node.get("hasPixels", node["kind"] == "pixel"):
                reason = SKIP_NO_PIXELS
            if reason:
                _skip(node, reason)
                continue
            matched.append(node["id"])

    walk(tree, False, False)
    return matched, skipped


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
