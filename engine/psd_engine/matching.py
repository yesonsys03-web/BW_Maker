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


#: 역할 토큰의 기본값. 목록 순서가 곧 쌓는 순서다(아래→위). BG는 토큰이 아니라
#: "아무 역할도 못 찾은 나머지"이며 항상 맨 아래에 깔린다.
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


def _role_of(path, tokens_longest_first):
    """
    레이어의 역할. 자기 이름부터 가까운 조상 그룹 순으로 올라가며 처음 만나는
    토큰을 쓴다(`*ART / CHAIR2_UL / LINE` → UL). 못 찾으면 None = BG.
    """
    for name in reversed(path):
        role = _match_role(name, tokens_longest_first)
        if role is not None:
            return role
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
    if mode == "byRole":
        return _by_role_operations(tree, matched_ids, preset, source_stem)
    raise ValueError(f"unknown merge mode: {mode!r}")


def _by_role_operations(tree, matched_ids, preset, source_stem):
    """
    애니메이션 BG의 역할(BG / UL / OL / OL_UL …)별로 한 장씩 병합한다.

    소스에서는 CHAIR2_UL, CHAIR2_OL, TABLE 같은 요소들이 서로 뒤섞여 쌓여 있어서
    (실제 파일에서 BG 요소가 OL 요소보다 위에 오기도 한다) 문서 순서를 그대로
    쓰면 원하는 스택이 나오지 않는다. 그래서 병합한 뒤 reorder로 순서를 못박는다:
    맨 아래 BG, 그 위로 preset의 roleTokens 순서.
    """
    tokens = [t for t in (preset.get("roleTokens") or DEFAULT_ROLE_TOKENS) if t and t.strip()]
    longest_first = sorted(tokens, key=len, reverse=True)

    matched_set = set(matched_ids)
    buckets = {token: [] for token in tokens}
    background = []

    def walk(nodes):
        for node in nodes:
            if node["kind"] == "group":
                walk(node["children"])
            elif node["id"] in matched_set:
                role = _role_of(node["path"], longest_first)
                (buckets[role] if role is not None else background).append(node["id"])

    walk(tree)

    def final_name(role):
        return f"{source_stem}_{role}" if source_stem else role

    operations = []
    merged_ids = []
    for role, layer_ids in [("BG", background)] + [(t, buckets[t]) for t in tokens]:
        if not layer_ids:
            continue
        operations.append({"op": "merge", "layerIds": layer_ids, "name": final_name(role)})
        # 병합 항목 id는 merge 연산 순서대로 -1, -2, ... 로 붙는다
        # (build_export_plan / buildEntries 양쪽 동일).
        merged_ids.append(-len(merged_ids) - 1)

    above = None
    for entry_id in merged_ids:
        operations.append({"op": "reorder", "layerId": entry_id, "aboveId": above})
        above = entry_id

    return operations
