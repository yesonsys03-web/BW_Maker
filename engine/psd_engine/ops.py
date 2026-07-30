"""비파괴 operation list → export plan(entry 목록, 아래→위)."""


def build_export_plan(included_ids, operations):
    entries = [{"entryId": i, "sourceIds": [i], "name": None} for i in included_ids]
    by_id = {e["entryId"]: e for e in entries}
    merge_counter = 0

    def require(entry_id):
        if entry_id not in by_id:
            raise KeyError(f"unknown entry id: {entry_id}")
        return by_id[entry_id]

    def do_merge(entry_ids, name):
        nonlocal merge_counter
        group = [require(i) for i in entry_ids]
        if len(group) < 2:
            raise ValueError("merge needs at least 2 layers")
        group_sorted = sorted(group, key=entries.index)
        top_index = entries.index(group_sorted[-1])
        merge_counter -= 1
        merged = {
            "entryId": merge_counter,
            "sourceIds": [sid for e in group_sorted for sid in e["sourceIds"]],
            "name": name,
        }
        entries.insert(top_index + 1, merged)
        for e in group:
            entries.remove(e)
            del by_id[e["entryId"]]
        by_id[merged["entryId"]] = merged

    for op in operations:
        kind = op["op"]
        if kind == "exclude":
            for lid in op["layerIds"]:
                e = require(lid)
                entries.remove(e)
                del by_id[lid]
        elif kind == "rename":
            require(op["layerId"])["name"] = op["name"]
        elif kind == "merge":
            do_merge(op["layerIds"], op["name"])
        elif kind == "flatten":
            do_merge([e["entryId"] for e in entries], op["name"])
        elif kind == "reorder":
            e = require(op["layerId"])
            entries.remove(e)
            above = op.get("aboveId")
            if above is None:
                entries.insert(0, e)
            else:
                entries.insert(entries.index(require(above)) + 1, e)
        else:
            raise ValueError(f"unknown op: {kind!r}")
    return entries


def _path_prefix_name(path):
    parts = [p for p in path if not p.startswith("*") and not p.lower().startswith("group ")]
    out = []
    for p in parts:
        if not out or out[-1].lower() != p.lower():
            out.append(p)
    return "_".join(out)


def finalize_names(entries, nodes_by_id, naming):
    if naming not in ("pathPrefix", "original"):
        raise ValueError(f"unknown naming rule: {naming!r}")
    used = {}
    for e in entries:
        if e["name"] is not None:
            base = e["name"]
        else:
            path = nodes_by_id[e["sourceIds"][-1]]["path"]
            base = path[-1] if naming == "original" else _path_prefix_name(path)
        count = used.get(base, 0) + 1
        used[base] = count
        e["finalName"] = base if count == 1 else f"{base}_{count}"
    return entries
