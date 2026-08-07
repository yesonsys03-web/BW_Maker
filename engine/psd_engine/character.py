"""캐릭터 모델 PSD의 구조 해석 — 색 그룹에서 뷰를 찾는다.

에피소드 하나의 캐릭터 폴더 100장을 전수 조사해 정한 규칙이다. 이 규칙으로 83장에서
뷰를 찾고, 찾은 뷰 355개 중 352개(99%)가 라인을 함께 찾는다. 나머지 17장은 군중·
스토리보드·배치 시트라 색 분리가 없다 — 실패가 아니라 대상이 아니다.
"""
from .matching import DEFAULT_EXCLUDE_TOKENS
from .names import has_any_token

#: 색 그룹으로 칠 이름. **전체 일치**여야 한다.
#:
#: 부분 일치는 쓰면 안 된다. 라인과 형제인 그룹 이름을 전수로 뽑으면 `colour palette`가
#: 46장, `color palette`가 36장에 있는데 그건 팔레트 견본이지 색 레이어가 아니다.
#: `colour`로 부분 일치하면 그것들을 색 그룹으로 오인한다.
#:
#: 이 집합은 관측이지 보장이 아니고 이미 두 번 늘어났다(넷 → `fills`를 더해 다섯).
#: 여섯 번째가 나오면 여기에 더하되, 그 전까지는 수동 지정이 메운다.
COLOUR_GROUP_NAMES = frozenset({"colors", "colours", "color", "colour", "fills"})


def _is_line_named(layer):
    return "line" in layer.name.lower()


def _line_leaves(layer):
    """`_pixel_leaves`에서 채색 잎을 뺀 것. **lineIds에만** 쓴다.

    line-named 노드 안의 잎을 전부 라인으로 담던 것이 결함이었다. 납품 폴더에서
    `LINE` 그룹 안에 `colour`가 들어 있는 뷰가 나왔고, 그 잎까지 담으니 라인
    알파가 뷰 박스의 95.6%를 덮었다. 결과는 두 가지로 번진다 — `edges._auto_width`가
    그 알파의 가로 런 중앙값에서 굵기를 유도하므로 획 굵기가 캐릭터 몸통 너비인
    771px로 나오고(전수 스캔에서 339뷰 중 16뷰, 파일 넷), `edges.subtract_lines`는
    같은 알파를 "이미 선이 있다"로 보고 그 95% 안의 색 경계를 지운다.

    내보내기 경로(`matching.match_preset`)는 이런 잎을 `excludeTokens`로 이미
    걸러낸다. 같은 물음("이 잎이 선화인가")에 두 경로가 다른 답을 내고 있었던
    것이 문제이므로, 규칙을 다시 쓰지 않고 그쪽이 쓰는 `has_any_token`을 그대로
    부른다. 토큰 단위라 `colourful line` 같은 진짜 선화는 남는다.

    프리셋의 `excludeTokens` 대신 기본 상수를 쓴다. `rpc.render_preview`는
    프리셋을 받지 않아서, 인자로 흘리면 미리보기와 내보내기가 서로 다른 라인
    집합을 볼 수 있다 — 갈리지 않는 쪽이 낫다. 아티스트가 토큰을 손봤다면 그
    변경은 이 경로에 반영되지 않는다.
    """
    return [leaf for leaf in _pixel_leaves(layer)
            if not has_any_token(leaf.name, DEFAULT_EXCLUDE_TOKENS)]


def _pixel_leaves(layer):
    """그룹이면 그릴 수 있는 잎까지 펼치고, 잎이면 자기 자신.

    보이지 않는 레이어는 건너뛴다. 꺼진 대체 색상(예: 꺼진 `hair red (alt)`)은
    포토샵에서 안 보이고 내보내기에도 안 들어가지만, 이 검사가 없으면
    `colourIds`에 끼어 들어가 base 위에 그대로 합성돼 그 실루엣이 색 경계로
    오인된다(edges.overlay_for_view). 반대 방향도 있다 — 숨은 라인 잎이
    `lineIds`에 끼면 edges._paste_alpha가 그 알파를 그대로 붙여, 실제로는 선이
    없는 자리를 "선이 있다"고 오판하고 이 기능이 그려야 할 바로 그 경계를 지운다.

    `.visible`은 레이어 **자신의** 플래그일 뿐 조상은 보지 않지만, 여기서는
    재귀마다 이 검사를 하므로 숨은 조상을 만나면 그 아래로 내려가지 않고
    그대로 멈춘다 — 결과적으로 조상 전체를 본 것과 같아진다. `render.py`의
    기존 BG 경로(render_thumbnails)도 같은 이유로 `.visible`을 쓴다.
    """
    if not layer.visible:
        return []
    if not layer.is_group():
        return [layer] if layer.width > 0 and layer.height > 0 else []
    out = []
    for child in layer:
        out += _pixel_leaves(child)
    return out


def find_views(session):
    """
    (뷰 이름, 색 레이어 id, 라인 레이어 id) 목록. 문서 순서대로.

    뷰는 색 그룹의 **부모**다. 라인은 그 부모 아래에서 이름에 line이 든 형제인데,
    **잎일 수도 그룹일 수도 있다** — 실폴더에서 `lines`가 그룹 이름으로만 130회
    나오고, 잎만 찾던 첫 규칙은 100장 중 22장밖에 걸리지 못했다.
    """
    psd = session["psd"]
    ids = {id(layer): lid for lid, layer in session["layers_by_id"].items()}
    views = []

    def walk(node, name):
        for child in node:
            if not child.is_group():
                continue
            if child.name.strip().lower() in COLOUR_GROUP_NAMES:
                colour_ids = [ids[id(l)] for l in _pixel_leaves(child) if id(l) in ids]
                line_ids = [
                    ids[id(l)]
                    for sib in node if sib is not child and _is_line_named(sib)
                    for l in _line_leaves(sib) if id(l) in ids
                ]
                if colour_ids:
                    views.append({"name": name, "colourIds": colour_ids,
                                  "lineIds": line_ids})
            # 무조건 재귀한다 — 색 그룹 이름을 가진 그룹 **안에** 또 색 그룹 이름을
            # 가진 그룹이 중첩되면(예: COLORS 안의 FILLS 그룹) 가짜 뷰가 하나 더
            # 나온다는 뜻이다. 그 뷰의 colourIds는 바깥 뷰가 이미 센 것의
            # 부분집합이고 lineIds는 대개 비어 있다. 전수 조사 100장에는 없던
            # 모양이라 여기서 고치지 않는다 — 수동 지정(manual_views)이 대비책이다.
            # 회귀 테스트: test_character.py의
            # test_a_colour_group_nested_inside_a_colour_group_does_not_make_a_second_view
            # (xfail, strict=True) — 다음에 여섯 번째 색 그룹 이름을 추가하다 이걸
            # 고치고 싶어지면 그 테스트가 먼저 알려준다.
            walk(child, child.name)

    walk(psd, "(root)")
    return views


def _parent_map(psd):
    """id(자식) -> 부모 노드. `manual_views`가 고른 잎에서 부모(P)와 그 부모(V)를
    거슬러 올라가려면 트리를 한 번 훑어 이 지도를 만들어야 한다 — psd-tools
    레이어에는 부모 참조가 없다.

    `find_views`와 같은 `session["psd"]`를 그대로 훑으므로 여기서 얻는 레이어
    객체는 `session["layers_by_id"]`가 들고 있는 것과 `id()`가 같다(둘 다
    `tree.build_tree`가 만든 같은 psd-tools 트리를 본다)."""
    parent_of = {}

    def walk(node):
        for child in node:
            parent_of[id(child)] = node
            if child.is_group():
                walk(child)

    walk(psd)
    return parent_of


def _nearest_line_ancestor(parent_of, layer):
    """
    고른 잎에서 위로 올라가며 `_is_line_named` 자식을 가진 첫 조상을 뷰로 찾는다.

    **뷰란 "라인 노드를 자식으로 가진 조상"이다.** `find_views`에서 "색 그룹의
    부모"가 뷰가 되는 것도 같은 조건이다 — 그 부모가 색 그룹과 형제로
    line-named 노드를 두고 있기 때문이다. 이것은 수동을 위한 별도 규칙이 아니라
    같은 조건을 잎에서 거슬러 올라가며 찾는 것뿐이다 — 3단(잎→색그룹→뷰),
    2단(잎→뷰, 색 그룹이 아예 없는 파일), 더 깊은 중첩까지 조건문 없이 이
    한 함수로 덮인다. 그런 조상이 끝내 없으면 `None` — 그 지정은 뷰가 없는
    것이다.
    """
    node = parent_of.get(id(layer))
    while node is not None:
        if any(_is_line_named(c) for c in node):
            return node
        node = parent_of.get(id(node))
    return None


def manual_views(session, colour_ids, included_ids):
    """
    아티스트가 레이어 트리에서 직접 짚은 색 레이어(잎)로 뷰를 만든다.
    `find_views`와 **같은 모양**을 돌려주고 같은 `overlay_for_view`를 탄다 —
    경계 계산은 색 레이어 목록과 라인 목록만 받을 뿐 누가 골랐는지 묻지 않는다.

    뷰는 `_nearest_line_ancestor`로 찾는다 — 고른 잎에서 올라가며 line-named
    자식을 가진 첫 조상이 뷰다. 여러 잎이 같은 뷰 아래 있으면(서로 다른 중간
    그룹 아래여도) 한 뷰로 묶인다 — 뷰 하나에 오버레이 한 장이라는 설계(5절)
    때문이다. 그 조상을 못 찾은 잎은 조용히 빠진다.

    라인은 자동과 똑같이 뷰 바로 아래에서 이름에 line이 든 노드를 펼쳐 쓰되,
    `included_ids`(내보내기에 이미 포함된 라인)와 교집합만 남긴다 — 체크하지
    않은 라인 위에 획을 얹을 자리가 없다(edges.attach_overlays가 그런 뷰를
    건너뛰는 것과 같은 이유).

    `colour_ids`가 비면 `[]`를 돌려준다. `batch.py`는 아티스트가 짚을 수 없으므로
    이 함수를 빈 목록으로 불러 자동 검출만 돌게 한다.
    """
    if not colour_ids:
        return []

    layers_by_id = session["layers_by_id"]
    ids = {id(layer): lid for lid, layer in layers_by_id.items()}
    parent_of = _parent_map(session["psd"])
    included = set(included_ids)

    # V(id(view_node)) -> {"name", "colourIds", "_node"}. 문서 순서를 지키려고
    # 처음 등장한 순서를 order에 따로 적어 둔다(dict는 조회용).
    order = []
    grouped = {}
    for lid in colour_ids:
        layer = layers_by_id.get(lid)
        if layer is None:
            continue
        view_node = _nearest_line_ancestor(parent_of, layer)
        if view_node is None:
            continue
        key = id(view_node)
        if key not in grouped:
            name = "(root)" if view_node is session["psd"] else view_node.name
            grouped[key] = {"name": name, "colourIds": [], "_node": view_node}
            order.append(key)
        grouped[key]["colourIds"].append(lid)

    views = []
    for key in order:
        v = grouped[key]
        view_node = v["_node"]
        line_ids = [
            ids[id(l)]
            for sib in view_node if _is_line_named(sib)
            for l in _line_leaves(sib) if id(l) in ids
        ]
        line_ids = [lid for lid in line_ids if lid in included]
        views.append({"name": v["name"], "colourIds": v["colourIds"], "lineIds": line_ids})
    return views
