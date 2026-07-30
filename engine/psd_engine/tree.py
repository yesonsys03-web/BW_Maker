"""psd-tools PSDImage → 직렬화 가능한 레이어 트리(JSON) + id 인덱스."""


def build_tree(psd):
    nodes_by_id = {}
    layers_by_id = {}

    def walk(layers, path):
        children = []
        for layer in layers:
            node_id = len(nodes_by_id)
            # Check if mask has actual dimensions (non-zero size)
            has_mask = layer.mask is not None and (layer.mask.width > 0 or layer.mask.height > 0)
            node = {
                "id": node_id,
                "name": layer.name,
                "kind": "group" if layer.is_group() else layer.kind,
                "visible": bool(layer.visible),
                "blendMode": layer.blend_mode.name.lower(),
                "opacity": int(layer.opacity),
                "bbox": list(layer.bbox),
                "hasMask": has_mask,
                "path": path + [layer.name],
            }
            nodes_by_id[node_id] = node
            layers_by_id[node_id] = layer
            if layer.is_group():
                node["children"] = walk(layer, node["path"])
            children.append(node)
        return children

    tree = walk(psd, [])
    return {"tree": tree, "nodes_by_id": nodes_by_id, "layers_by_id": layers_by_id}
