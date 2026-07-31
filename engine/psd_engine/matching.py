"""프리셋 규칙 → 매치 레이어 id 목록 / operation list 변환."""
import re


def _name_matches(name, include):
    kind = include["type"]
    if kind == "contains":
        if include.get("caseSensitive"):
            return include["value"] in name
        return include["value"].lower() in name.lower()
    if kind == "regex":
        flags = 0 if include.get("caseSensitive") else re.IGNORECASE
        return re.search(include["value"], name, flags) is not None
    raise ValueError(f"unknown include type: {kind!r}")


def match_preset(tree, preset):
    matched = []
    prefixes = tuple(preset.get("excludeGroupPrefixes", []))

    def walk(nodes, inside_matched_group):
        for node in nodes:
            if node["kind"] == "group":
                if prefixes and node["name"].startswith(prefixes):
                    continue
                hit = preset.get("matchGroups", True) and _name_matches(
                    node["name"], preset["include"]
                )
                walk(node["children"], inside_matched_group or hit)
                continue
            if not (_name_matches(node["name"], preset["include"]) or inside_matched_group):
                continue
            if not node["visible"] and not preset.get("includeHidden", True):
                continue
            if node["kind"] != "pixel":
                raise ValueError(
                    f"matched non-pixel layer {'/'.join(node['path'])!r} "
                    f"(kind={node['kind']}) — not supported in v1"
                )
            matched.append(node["id"])

    walk(tree, False)
    return matched


#: 역할 접미사의 기본값. 요소 이름에서 이 접미사를 떼어내 "같은 요소"를 알아낸다
#: (CHAIR1_UL, CHAIR1_OL → CHAIR1). 어디에도 걸리지 않는 레이어는 BG로 묶인다.
DEFAULT_ROLE_TOKENS = ["UL", "OL_UL", "OL"]

#: 그룹 이름과 역할 토큰 사이에 쓰이는 구분자. `CHAIR2_UL`, `CHAIR2-UL`, `CHAIR2 UL`.
_ROLE_SEPARATORS = ("_", "-", " ")


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
        return auto_merge_operations(tree, matched_ids, preset.get("roleTokens"))
    raise ValueError(f"unknown merge mode: {mode!r}")


def auto_merge_operations(tree, matched_ids, role_tokens=None):
    """
    같은 요소의 라인들을 한 장으로 묶는 연산 목록.

    `CHAIR1_UL / LINE`과 `CHAIR1_OL / LINE`은 한 요소(CHAIR1)의 앞뒤 파트이므로
    `CHAIR1` 한 장이 된다. 역할 접미사가 없는 레이어는 전부 `BG` 한 장으로.

    소스에서는 요소들이 뒤섞여 쌓여 있고 BG 요소(TABLE, LAMP)가 OL 요소보다 위에
    오기도 한다. 문서 순서를 그대로 쓰면 BG가 위로 올라가므로, 병합 뒤 reorder로
    "맨 아래 BG, 그 위에 요소들(문서 순서)"을 못박는다.

    레이어 패널의 버튼과 프리셋의 요소별 병합이 같은 함수를 쓴다 — 규칙이 두
    군데로 갈라지면 화면과 배치 실행 결과가 달라진다.
    """
    tokens = [t for t in (role_tokens or DEFAULT_ROLE_TOKENS) if t and t.strip()]
    longest_first = sorted(tokens, key=len, reverse=True)

    matched_set = set(matched_ids)
    background = []
    elements = {}          # 요소 이름 -> [leaf id] (문서 순서, 등장 순 유지)

    def walk(nodes):
        for node in nodes:
            if node["kind"] == "group":
                walk(node["children"])
            elif node["id"] in matched_set:
                name = element_of(node["path"], longest_first)
                if name is None:
                    background.append(node["id"])
                else:
                    elements.setdefault(name, []).append(node["id"])

    walk(tree)

    operations = []
    merged_ids = []
    for name, layer_ids in [("BG", background)] + list(elements.items()):
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
