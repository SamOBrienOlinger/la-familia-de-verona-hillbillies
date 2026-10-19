#!/usr/bin/env python3
"""Build the map graph from the supplied charts' explicit relationship strokes.

The companion family-data.js preserves each chart's names and facts. This file
adds only graph topology and chart-relative generations; it does not merge the
two sources or infer biological relationships, missing people, or missing dates.

The source chart format connects partners with a bottom-to-left stroke and a
couple's children from the second partner's right edge to each child's left
edge. Every relationship endpoint must match exactly one existing card. A
couple-to-child stroke is represented as two parent edges for navigation, and
also as one family group so the UI can render a single shared connector.

Run from the repository root:
    python3 scripts/extract-family-graph.py

Requires PyMuPDF (fitz), also used by extract-family-charts.py. The default
inputs are the unchanged PDF copies in dist/assets and dist/family-data.js.
Use --source-dir /path/to/uploads to read the originally named upload files.
"""

import argparse
from collections import defaultdict, deque
import hashlib
import json
from pathlib import Path

import fitz


ROOT = Path(__file__).resolve().parents[1]
TOLERANCE = 0.025  # PDF points; family-data.js coordinates are rounded to 0.001.
EXPECTED = {
    "renee": {"people": 22, "partners": 8, "childLinks": 13, "generations": 4},
    "bernard": {"people": 56, "partners": 19, "childLinks": 36, "generations": 5},
}


def require(condition, message):
    """Keep integrity checks enabled even when Python is invoked with -O."""
    if not condition:
        raise ValueError(message)


def near(first, second):
    return abs(first - second) <= TOLERANCE


def load_family_data(path):
    source = path.read_text(encoding="utf-8")
    marker = "window.FAMILY_DATA = "
    require(marker in source, f"{path}: missing FAMILY_DATA assignment")
    value = source.split(marker, 1)[1].strip()
    return json.loads(value[:-1] if value.endswith(";") else value)


def point_values(point):
    return [round(point.x, 3), round(point.y, 3)]


def matching_side(people, point, side):
    return [
        person for person in people
        if near(point.x, person["x"] + (person["w"] if side == "right" else 0))
        and near(point.y, person["y"] + person["h"] / 2)
    ]


def unique_match(matches, context):
    require(len(matches) == 1, f"{context}: expected one card, got {len(matches)}")
    return matches[0]


def source_path(chart_id, source_dir):
    candidates = [
        source_dir / f"{chart_id}-descendant-chart.pdf",
        source_dir / f"{chart_id.title()} Egelka – Descendant Chart.pdf",
    ]
    return next((path for path in candidates if path.is_file()), candidates[0])


def extract_chart(chart, pdf_path):
    chart_id = chart["id"]
    expected = EXPECTED[chart_id]
    people = chart["people"]
    by_id = {person["id"]: person for person in people}
    require(len(by_id) == len(people) == expected["people"], f"{chart_id}: unexpected people")

    partners = []
    child_links = []
    with fitz.open(pdf_path) as document:
        require(len(document) == 1, f"{chart_id}: source chart must contain one page")
        page = document[0]
        require(near(page.rect.width, chart["width"]) and near(page.rect.height, chart["height"]),
                f"{chart_id}: source page dimensions differ from family-data.js")
        drawings = page.get_drawings()
        cards = [
            drawing["rect"] for drawing in drawings
            if drawing["fill"] is not None
            and near(drawing["rect"].width, 250)
            and drawing["rect"].height >= 30
        ]
        require(len(cards) == len(people), f"{chart_id}: PDF card count differs from data")
        for person in people:
            matches = [card for card in cards if all((
                near(card.x0, person["x"]), near(card.y0, person["y"]),
                near(card.width, person["w"]), near(card.height, person["h"]),
            ))]
            require(len(matches) == 1, f"{person['id']}: no unique matching PDF card")

        for drawing in drawings:
            # Black one-point strokes are the original relationship connectors.
            # Card outlines are grey half-point rounded paths; shadows are fills.
            if (drawing["fill"] is not None or not near(drawing["width"], 1)
                    or drawing["color"] != (0.0, 0.0, 0.0)):
                continue
            for item in drawing["items"]:
                require(item[0] == "l", f"{chart_id}: unexpected relationship curve")
                _, start, end = item
                target = unique_match(matching_side(people, end, "left"),
                                      f"{chart_id}: connector end {end}")
                source = matching_side(people, start, "right")
                evidence = point_values(start) + point_values(end)
                if source:
                    parent = unique_match(source, f"{chart_id}: parent endpoint {start}")
                    require(target["x"] > parent["x"] + parent["w"],
                            f"{chart_id}: child must be in the following column")
                    child_links.append({"source": parent["id"], "target": target["id"],
                                        "pdfLine": evidence})
                else:
                    partner = unique_match([
                        person for person in people
                        if near(start.y, person["y"] + person["h"])
                        and person["x"] < start.x < person["x"] + person["w"]
                    ], f"{chart_id}: partner endpoint {start}")
                    require(near(target["x"] - partner["x"], 50),
                            f"{chart_id}: unexpected partner column offset")
                    partners.append({"source": partner["id"], "target": target["id"],
                                     "pdfLine": evidence})

    require(len(partners) == expected["partners"], f"{chart_id}: unexpected partner count")
    require(len(child_links) == expected["childLinks"], f"{chart_id}: unexpected child count")
    require(len(partners) + len(child_links) == len(people) - 1,
            f"{chart_id}: the original chart is not a complete tree")

    adjacency = defaultdict(list)
    couple_for_person = {}
    families = []
    edges = []
    for pair in sorted(partners, key=lambda pair: (by_id[pair["source"]]["x"],
                                                  by_id[pair["source"]]["y"])):
        first, second = pair["source"], pair["target"]
        require(first not in couple_for_person and second not in couple_for_person,
                f"{chart_id}: multiple partners require explicit family resolution")
        family_id = first + "-family"
        family = {"id": family_id, "parents": [first, second], "children": []}
        families.append(family)
        couple_for_person[first] = family
        couple_for_person[second] = family
        edges.append({"id": first + "--partner--" + second,
                      "source": first, "target": second, "type": "partner",
                      "familyId": family_id, "pdfLine": pair["pdfLine"]})
        adjacency[first].append((second, 0))
        adjacency[second].append((first, 0))

    child_family = {}
    for link in sorted(child_links, key=lambda link: (by_id[link["target"]]["x"],
                                                    by_id[link["target"]]["y"])):
        source, child = link["source"], link["target"]
        require(source in couple_for_person, f"{chart_id}: unpaired parent endpoint")
        family = couple_for_person[source]
        require(child not in child_family, f"{chart_id}: child linked to more than one couple")
        child_family[child] = family["id"]
        family["children"].append(child)
        for parent in family["parents"]:
            edges.append({"id": parent + "--parent--" + child,
                          "source": parent, "target": child, "type": "parent",
                          "familyId": family["id"], "pdfLine": link["pdfLine"]})
            adjacency[parent].append((child, 1))
            adjacency[child].append((parent, -1))

    root = min(people, key=lambda person: (person["x"], person["y"]))
    generation_for = {root["id"]: 1}
    queue = deque([root["id"]])
    while queue:
        current = queue.popleft()
        for neighbour, offset in adjacency[current]:
            value = generation_for[current] + offset
            if neighbour in generation_for:
                require(generation_for[neighbour] == value,
                        f"{chart_id}: contradictory generation for {neighbour}")
            else:
                generation_for[neighbour] = value
                queue.append(neighbour)
    require(set(generation_for) == set(by_id), f"{chart_id}: disconnected people")
    require(min(generation_for.values()) == 1
            and max(generation_for.values()) == expected["generations"],
            f"{chart_id}: unexpected generation count")
    require(len({edge["id"] for edge in edges}) == len(edges), f"{chart_id}: duplicate edges")

    nodes = [{"id": person["id"],
              "x": round(person["x"] + person["w"] / 2, 3),
              "y": round(person["y"] + person["h"] / 2, 3),
              "generation": generation_for[person["id"]]}
             for person in people]
    generations = []
    for number in range(1, expected["generations"] + 1):
        members = [node for node in nodes if node["generation"] == number]
        generations.append({"index": number, "label": f"Generation {number}",
                            "x": min(node["x"] for node in members), "count": len(members)})
        # An independent coordinate check catches accidental direction reversal.
        base_x = min(person["x"] for person in people) + (number - 1) * 400
        require(all(near(by_id[node["id"]]["x"], base_x)
                    or near(by_id[node["id"]]["x"], base_x + 50) for node in members),
                f"{chart_id}: graph generations do not match the source columns")

    graph = {"id": chart_id, "label": chart["label"], "rootId": root["id"],
             "width": chart["width"], "height": chart["height"],
             "generations": generations, "nodes": nodes,
             "edges": edges, "families": families,
             "source": {"title": chart["sourceTitle"],
                        "file": f"assets/{chart_id}-descendant-chart.pdf",
                        "sha256": hashlib.sha256(pdf_path.read_bytes()).hexdigest()}}
    report = {"chart": chart_id, "people": len(nodes), "generations": len(generations),
              "partnerEdges": len(partners), "sourceChildLinks": len(child_links),
              "parentEdges": len(child_links) * 2, "ambiguousEndpoints": 0,
              "everyPersonConnected": True}
    return graph, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ROOT / "dist/assets")
    parser.add_argument("--data-file", type=Path, default=ROOT / "dist/family-data.js")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/family-graph.js")
    args = parser.parse_args()
    data = load_family_data(args.data_file)
    graphs, reports = {}, []
    for chart in data["charts"]:
        graph, report = extract_chart(chart, source_path(chart["id"], args.source_dir))
        graphs[chart["id"]] = graph
        reports.append(report)
    output = {
        "version": 1,
        "provenance": {
            "method": "Explicit relationship strokes in the supplied PDF charts",
            "generationMeaning": "Chart-relative generations, beginning with its root couple",
            "parentMeaning": "Parent-child links shown by each source chart; no biological relationship inferred",
            "coordinates": "Original PDF card centers in points",
            "sourceChartsKeptSeparate": True,
        },
        "charts": graphs,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "// Generated by scripts/extract-family-graph.py from the unchanged source PDFs.\n"
        + "window.FAMILY_GRAPH = " + json.dumps(output, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(json.dumps(reports, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
