"""비파괴 operation list → export plan(entry 목록, 아래→위)."""

import re


def build_export_plan(included_ids, operations):
    entries = [{"entryId": i, "sourceIds": [i], "name": None} for i in included_ids]
    by_id = {e["entryId"]: e for e in entries}
    merge_counter = 0

    def do_merge(entry_ids, name):
        nonlocal merge_counter
        # included_ids가 "무엇이 내보내지는가"의 기준이다. 체크를 푼 레이어는
        # 산출물에 없으므로, 그것을 가리키던 병합은 잘못된 것이 아니라 남은
        # 것들끼리의 병합으로 성립한다(src/lib/opsReducer.ts와 같은 규칙 —
        # 두 쪽이 어긋나면 UI에서는 되는데 내보내기만 실패한다).
        group = [by_id[i] for i in entry_ids if i in by_id]

        # 병합 항목 id는 결과와 무관하게 소비한다 — 이 병합을 가리키는 뒤쪽
        # 작업(예: 병합 결과의 이름변경)의 id가 어긋나지 않도록.
        merge_counter -= 1

        if not group:
            return
        if len(group) == 1:
            only = group[0]
            del by_id[only["entryId"]]
            only["entryId"] = merge_counter
            only["name"] = name
            by_id[merge_counter] = only
            return

        group_sorted = sorted(group, key=entries.index)
        top_index = entries.index(group_sorted[-1])
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
                e = by_id.pop(lid, None)
                if e is not None:
                    entries.remove(e)
        elif kind == "rename":
            e = by_id.get(op["layerId"])
            if e is not None:
                e["name"] = op["name"]
        elif kind == "merge":
            do_merge(op["layerIds"], op["name"])
        elif kind == "flatten":
            do_merge([e["entryId"] for e in entries], op["name"])
        elif kind == "reorder":
            e = by_id.get(op["layerId"])
            above_id = op.get("aboveId")
            if e is None:
                continue
            if above_id is None:
                entries.remove(e)
                entries.insert(0, e)
                continue
            above = by_id.get(above_id)
            # 기준이던 항목이 사라졌으면 "그 위로"가 성립하지 않는다. 원래 자리에 둔다.
            if above is None:
                continue
            entries.remove(e)
            entries.insert(entries.index(above) + 1, e)
        else:
            raise ValueError(f"unknown op: {kind!r}")
    return entries


def _path_prefix_name(path):
    parts = [p for p in path if not p.startswith("*") and not re.fullmatch(r"group \d+", p, re.IGNORECASE)]
    out = []
    for p in parts:
        if not out or out[-1].lower() != p.lower():
            out.append(p)
    return "_".join(out)


def finalize_names(entries, nodes_by_id, naming):
    if naming not in ("pathPrefix", "original"):
        raise ValueError(f"unknown naming rule: {naming!r}")
    used_finals = set()
    for e in entries:
        if e["name"] is not None:
            base = e["name"]
        else:
            path = nodes_by_id[e["sourceIds"][-1]]["path"]
            base = path[-1] if naming == "original" else _path_prefix_name(path)
        final = base
        counter = 2
        while final in used_finals:
            final = f"{base}_{counter}"
            counter += 1
        used_finals.add(final)
        e["finalName"] = final
    return entries
