#!/usr/bin/env python3
"""Convert the two supplied PDF charts without reconciling their family records.

The SVGs retain the original PDF artwork. Hit areas come from its exact card
fill rectangles; names and detail lines come from the text within each card.
Usage: python3 scripts/extract-family-charts.py --source-dir /path/to/uploads
"""

import argparse
import json
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

import fitz


CHARTS = [
    {
        "id": "renee",
        "label": "Renee’s branch",
        "sourceTitle": "Renee Egelka – Descendant Chart",
        "filename": "Renee Egelka – Descendant Chart.pdf",
        "expected": 22,
    },
    {
        "id": "bernard",
        "label": "Bernard’s descendants",
        "sourceTitle": "Bernard Egelka – Descendant Chart",
        "filename": "Bernard Egelka – Descendant Chart.pdf",
        "expected": 56,
    },
]

PHOTO_NAMES = {
    "Jenna Michelle Kole": ["Jenna", "Jenna Kole", "Jenna Olinger"],
    "Jenna Kole": ["Jenna", "Jenna Michelle Kole", "Jenna Olinger"],
    "David Cromwell (Crom) Johnson": [
        "Cromwell", "Crom", "Cromwell Johnson", "David Cromwell Johnson"
    ],
    "Cromwell Johnson": [
        "Cromwell", "Crom", "David Cromwell Johnson", "David Cromwell (Crom) Johnson"
    ],
}

VIDEO_NAMES = {
    "Daniel Joseph Kole": ["Dan Kole", "Daniel Kole", "Dan Joseph Kole"],
    "Daniel Kole": ["Dan Kole", "Daniel Joseph Kole", "Dan Joseph Kole"],
}


def slug(value):
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")


def text_rows(spans):
    """Group horizontally aligned PDF spans into their original text rows."""
    rows = []
    for span in sorted(spans, key=lambda s: (s["origin"][1], s["bbox"][0])):
        if not rows or abs(rows[-1][0] - span["origin"][1]) > 0.5:
            rows.append((span["origin"][1], [span]))
        else:
            rows[-1][1].append(span)
    return [
        " ".join(s["text"].strip() for s in sorted(row, key=lambda s: s["bbox"][0]))
        for _, row in rows
    ]


def heading_text(spans):
    rows = text_rows(spans)
    name = ""
    for row in rows:
        # A hyphen at the end of Ruth's wrapped surname is part of that surname.
        separator = "" if not name or name.endswith("-") else " "
        name += separator + row
    return name


def extract_chart(spec, source_dir, output_dir):
    with fitz.open(source_dir / spec["filename"]) as document:
        assert len(document) == 1, "Each original chart is a single page."
        page = document[0]
        spans = [
            span
            for block in page.get_text("dict")["blocks"] if block["type"] == 0
            for line in block["lines"]
            for span in line["spans"]
        ]
        cards = sorted(
            [
                drawing["rect"]
                for drawing in page.get_drawings()
                if drawing["fill"] is not None
                and abs(drawing["rect"].width - 250) < 0.1
                and drawing["rect"].height >= 30
            ],
            key=lambda rect: (round(rect.x0, 2), rect.y0),
        )
        assert len(cards) == spec["expected"], (spec["id"], "unexpected card count")

        assignments = [0] * len(spans)
        people = []
        for card in cards:
            card_spans = []
            padded = card + (-0.1, -0.1, 0.1, 0.1)
            for index, span in enumerate(spans):
                if padded.contains(fitz.Rect(span["bbox"])):
                    assignments[index] += 1
                    card_spans.append(span)

            headings = [span for span in card_spans if span["size"] > 12]
            details = [span for span in card_spans if span["size"] <= 12]
            assert headings, (spec["id"], "card has no heading", card)
            name = heading_text(headings)
            has_photo = name in PHOTO_NAMES
            has_video = name in VIDEO_NAMES
            people.append({
                "id": spec["id"] + "-" + slug(name),
                "name": name,
                "aliases": PHOTO_NAMES.get(name, VIDEO_NAMES.get(name, [])),
                "x": round(card.x0, 3),
                "y": round(card.y0, 3),
                "w": round(card.width, 3),
                "h": round(card.height, 3),
                "lines": text_rows(details),
                "mediaGroup": "jenna-cromwell" if has_photo else ("dan-kole" if has_video else None),
                "mediaLabel": ("Jenna" if name.startswith("Jenna") else "Cromwell") if has_photo else ("Dan" if has_video else None),
            })

        assert all(count == 1 for count in assignments), "Every text span must belong to one card."
        assert len({person["id"] for person in people}) == len(people), "Duplicate person IDs."
        assert sum(person["mediaGroup"] == "jenna-cromwell" for person in people) == 2
        assert sum(person["mediaGroup"] == "dan-kole" for person in people) == 1
        for card in cards:
            assert page.rect.contains(card), "Card lies outside the original page."
        for i, first in enumerate(cards):
            for second in cards[i + 1:]:
                assert (first & second).is_empty, "Clickable card bodies must not overlap."

        svg = page.get_svg_image(text_as_path=True)
        xml = ET.fromstring(svg)
        assert xml.attrib["viewBox"].split() == [
            "0", "0", f"{page.rect.width:g}", f"{page.rect.height:g}"
        ]
        for element in xml.iter():
            for key, value in element.attrib.items():
                if key.endswith("href"):
                    assert value.startswith(("#", "data:")), "SVG must be self-contained."

        asset_name = spec["id"] + "-tree.svg"
        (output_dir / "assets" / asset_name).write_text(svg, encoding="utf-8")
        chart = {
            "id": spec["id"],
            "label": spec["label"],
            "sourceTitle": spec["sourceTitle"],
            "image": "assets/" + asset_name,
            "width": page.rect.width,
            "height": page.rect.height,
            "people": people,
        }
        report = {
            "id": spec["id"],
            "cards": len(people),
            "textSpansAssignedExactlyOnce": len(spans),
            "coordinateBounds": [
                round(min(card.x0 for card in cards), 3),
                round(min(card.y0 for card in cards), 3),
                round(max(card.x1 for card in cards), 3),
                round(max(card.y1 for card in cards), 3),
            ],
            "pageSize": [page.rect.width, page.rect.height],
            "mediaCards": [person["name"] for person in people if person["mediaGroup"]],
            "svgBytes": len(svg.encode("utf-8")),
        }
        return chart, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "dist")
    args = parser.parse_args()
    (args.output_dir / "assets").mkdir(parents=True, exist_ok=True)

    charts, reports = [], []
    for spec in CHARTS:
        chart, report = extract_chart(spec, args.source_dir, args.output_dir)
        charts.append(chart)
        reports.append(report)
    data = {
        "charts": charts,
        "mediaGroups": {
            "jenna-cromwell": {
                "type": "image",
                "src": "assets/jenna-and-cromwell.png",
                "caption": "Jenna and Cromwell",
                "alt": "Jenna and Cromwell together",
                "names": ["Jenna", "Cromwell"],
            },
            "dan-kole": {
                "type": "video",
                "src": "assets/dan-kole.mp4",
                "poster": "assets/dan-kole-poster.jpg",
                "caption": "Dan Kole",
                "alt": "Family video for Dan Kole",
                "names": ["Dan"],
            },
        },
    }
    (args.output_dir / "family-data.js").write_text(
        "// Extracted from the original PDF charts. Conflicting source records remain separate.\n"
        + "window.FAMILY_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(json.dumps(reports, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
