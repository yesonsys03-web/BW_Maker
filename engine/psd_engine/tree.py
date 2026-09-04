"""psd-tools PSDImage → 직렬화 가능한 레이어 트리(JSON) + id 인덱스."""


def build_tree(psd):
    nodes_by_id = {}
    layers_by_id = {}

    def walk(layers, path):
        children = []
        for layer in layers:
            node_id = len(nodes_by_id)
            node = {
                "id": node_id,
                "name": layer.name,
                "kind": "group" if layer.is_group() else layer.kind,
                "visible": bool(layer.visible),
                "blendMode": layer.blend_mode.name.lower(),
                "opacity": int(layer.opacity),
                "bbox": list(layer.bbox),
                "hasMask": layer.mask is not None,
                # 실제로 그려진 채널을 들고 있는지. 종류만으로는 알 수 없다 —
                # 스마트오브젝트·셰이프는 래스터화된 픽셀을 함께 저장하지만
                # (그래서 render.py의 extract_rgba가 픽셀 레이어와 똑같이 읽는다),
                # 조정 레이어는 그렇지 않다. 그리는 대상으로 삼아도 되는지는
                # 이 값으로 판단한다.
                "hasPixels": False if layer.is_group() else bool(layer.has_pixels()),
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
