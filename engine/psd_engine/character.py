"""캐릭터 모델 PSD의 구조 해석 — 색 그룹에서 뷰를 찾는다.

에피소드 하나의 캐릭터 폴더 100장을 전수 조사해 정한 규칙이다. 이 규칙으로 83장에서
뷰를 찾고, 찾은 뷰 355개 중 352개(99%)가 라인을 함께 찾는다. 나머지 17장은 군중·
스토리보드·배치 시트라 색 분리가 없다 — 실패가 아니라 대상이 아니다.
"""

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


def _pixel_leaves(layer):
    """그룹이면 그릴 수 있는 잎까지 펼치고, 잎이면 자기 자신."""
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
                    for l in _pixel_leaves(sib) if id(l) in ids
                ]
                if colour_ids:
                    views.append({"name": name, "colourIds": colour_ids,
                                  "lineIds": line_ids})
            walk(child, child.name)

    walk(psd, "(root)")
    return views
