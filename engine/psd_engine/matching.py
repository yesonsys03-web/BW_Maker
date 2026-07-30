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


def preset_operations(tree, matched_ids, preset):
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
    raise ValueError(f"unknown merge mode: {mode!r}")
