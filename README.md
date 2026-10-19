# La Familia de Verona Hillbillies

## Family Map — `family-map-explorer`

Explore the Egelka family with the familiar gestures of a map: search for a person, drag between generations, zoom into a family group, and open a name to see its photograph, video, and recorded connections.

This branch introduces the **Family Map** app. It builds on Bill’s research and the original family charts, photographs, and video supplied by the family.

**[Browse this branch](https://github.com/SamOBrienOlinger/la-familia-de-verona-hillbillies/tree/family-map-explorer)** · **[Download this branch as a ZIP](https://github.com/SamOBrienOlinger/la-familia-de-verona-hillbillies/archive/refs/heads/family-map-explorer.zip)**

## Try the app

Download this branch, extract the ZIP, and open **[`dist/index.html`](dist/index.html)** in a current browser. Keep the `dist` directory together. All scripts, styles, family records, and media are local files, so viewing the app requires no package installation, build step, backend, map service, or API key.

For a local HTTP preview, run this from the repository root:

```sh
python3 -m http.server 8000 --directory dist
```

Then open `http://localhost:8000`. This also gives copied profile links an HTTP address; a `file:` link is specific to the computer where the files were opened.

If you already have a clone:

```sh
git fetch origin
git switch --track origin/family-map-explorer
```

If the branch already exists locally, use `git switch family-map-explorer`.

## What you can do

| Map feature | Family Map behavior |
|---|---|
| Search | Find names and known aliases, including “Bill Stewart,” “Jenna Olinger,” and “Dan Kole.” Accents and common apostrophe/hyphen variations are handled. |
| Move and zoom | Drag with a mouse or finger, scroll or pinch to zoom, use the zoom controls, or fit the whole family in view. |
| Select a marker | Open a person’s profile with source details, a photograph or video when supplied, and links to parents, partners, children, and siblings. |
| Generation shortcuts | Focus one generation and show its people in the sidebar. Generation columns follow the selected source chart. |
| Find connection | Choose two people and highlight their shortest recorded path through parent, child, and partner links. Each step describes its direction. |
| Memories | Browse the supplied photo/video groups and filter the people who have media. |
| Display options | Show or hide generation bands, birth-year labels, and partner connections. Parent arms remain visible when they are needed to connect children. |
| Overview | Use the desktop minimap to move to another part of the family. Its highlighted rectangle follows the visible map area. |
| Profile links | Copy a link to a person. Chart, profile, and connection state can be restored from the URL fragment. |
| Original charts | Open the retained diagram-based interface at [`dist/tree.html`](dist/tree.html), or either source PDF. |

The desktop interface has a floating search/sidebar and map controls. On a phone, profiles and search results open in a collapsible bottom sheet. The sheet leaves a clear map area above it, and collapsing it restores the map toolbar.

Photographs open in a larger dialog without cropping the original image. Video uses native playback controls and never autoplays. Leaving a profile, switching charts, or closing an enlarged video pauses and resets playback.

### Keyboard controls

- **Tab** moves between controls; **Enter** opens a focused person.
- **/** focuses family search. **Enter** in search opens the first matching result.
- With the map focused, **arrow keys** move the view; **Shift + arrow** moves farther.
- **+ / −** zoom; **Home** or **0** fits the whole chart.
- **Escape** closes a dialog or display options, or returns from a profile/connection to exploration.

The app uses native buttons, labelled controls, live status announcements, focus restoration, and native dialogs. Reduced-motion and forced-color preferences have corresponding styles.

## Source records and relationship meaning

The two source charts remain separate:

| Source | People recorded | Generations | Original PDF |
|---|---:|---:|---|
| Renee Egelka – Descendant Chart | 22 | 4 | [Renee’s chart](dist/assets/renee-descendant-chart.pdf) |
| Bernard Egelka – Descendant Chart | 56 | 5 | [Bernard’s chart](dist/assets/bernard-descendant-chart.pdf) |

These are **78 source-chart records, not 78 distinct relatives**. Some people appear in both charts. Names, dates, missing information, and differences between the records remain as supplied. The app does not silently reconcile conflicting records.

The map graph is extracted from the original PDFs’ explicit partner and couple-to-child connector strokes. Each couple-to-child connection becomes two directed parent edges for navigation, while a family group supplies one shared connector for drawing. Generation numbering starts at the root of the selected chart; the same relative may therefore have a different generation number in the other view.

A parent edge means **parentage recorded in the chart**. The source does not distinguish biological, adoptive, or other parentage. Connection paths can include spouses and are not presented as blood relationships or inferred cousin degrees. Bill Stewart is linked to Lois as her partner.

Full, valid dates with four-digit years receive written month names in profiles. Incomplete dates remain unchanged. The app does not turn a two-digit year into a guessed birth year or copy a date from the other chart.

This is a static family explorer. Adding or correcting records and media currently requires a repository update; visitor uploads, accounts, and collaborative editing are outside this branch’s implementation.

## Family photographs and video

The existing assets are reused without modification:

| Memory | Asset | Profile mapping |
|---|---|---|
| Jenna and Cromwell | [`jenna-and-cromwell.png`](dist/assets/jenna-and-cromwell.png) | Both Jenna and Cromwell in each source chart |
| Dan Kole | [`dan-kole.mp4`](dist/assets/dan-kole.mp4), with [`dan-kole-poster.jpg`](dist/assets/dan-kole-poster.jpg) | Susan Olinger’s husband, Dan, in both charts |
| Bill Stewart | [`bill-stewart.jpeg`](dist/assets/bill-stewart.jpeg) | William Probst Stewart in both charts; searchable as Bill Stewart and Uncle Bill |
| Fiachra and Gráinne | [`fiachra-and-grainne.jpeg`](dist/assets/fiachra-and-grainne.jpeg) | Both children’s profiles in Renee’s chart |

The Dan clip was previously remuxed from the supplied MOV to MP4 without recompression or trimming; its full 15.508-second H.264/AAC video and audio are retained. Its poster is an actual frame from the clip.

The decorative `family-tree-illustration.png` remains available to the original interface. It is generated artwork and does not depict real relatives. The map itself is drawn from family data with HTML and SVG.

### Add another memory

1. Add the photograph or browser-compatible video to `dist/assets/`.
2. Add a `mediaGroups` entry in `dist/family-data.js`:

   ```js
   "family-portrait": {
     "type": "image",
     "src": "assets/family-portrait.jpg",
     "caption": "Names of the people in the photograph",
     "alt": "A brief description identifying the people shown",
     "names": ["First person", "Second person"]
   }
   ```

3. For a video, use `"type": "video"` and add an optional `poster` path.
4. Set the matching `mediaGroup` on each relevant person, including entries in both charts where appropriate. Shared photographs use one asset and one group.
5. Optionally set `mediaLabel` to a shorter name for shared-photo buttons. Full source names remain visible on profiles.
6. Update the corresponding mapping in `scripts/extract-family-charts.py` if you intend to regenerate the data, then check the profile and commit the data/assets together.

People awaiting media retain `"mediaGroup": null`.

## Project structure

| File | Responsibility |
|---|---|
| `dist/index.html` | Family Map page structure, controls, help, and enlarged-media dialog |
| `dist/map.css` | Map, sidebar, markers, responsive sheet, and accessibility styles |
| `dist/map.js` | Camera gestures, SVG connections, search, profiles, routes, layers, and URL state |
| `dist/map-core.js` | Pure search, date, graph traversal, relatives, layout, and bounds helpers |
| `dist/family-graph.js` | Extracted relationship graph, chart-relative generations, and provenance |
| `dist/family-data.js` | Original profile facts, aliases, media mappings, and source-card coordinates |
| `dist/tree.html`, `dist/app.js`, `dist/styles.css` | Retained original chart/album interface |
| `dist/assets/` | Original PDFs/SVGs and family media |
| `scripts/extract-family-charts.py` | Regenerates source diagrams and profile data using PyMuPDF |
| `scripts/extract-family-graph.py` | Extracts and validates the original relationship connectors |
| `tests/map-core.test.cjs` | Dependency-free graph, search, date, and layout regression checks |
| `tests/map-dom.test.cjs` | DOM event regression checks, with explicit media/geometry stubs |
| `tests/map-browser.test.cjs` | Chromium checks against a local test server, with desktop/phone screenshots |
| `.github/workflows/family-map-checks.yml` | Branch checks with isolated test dependencies and no publishing step |

### Regenerate the relationship graph

```sh
python3 scripts/extract-family-graph.py
```

This maintenance script requires PyMuPDF (`fitz`); the app does not. It reads the shipped original PDFs and existing profile coordinates, rejects ambiguous or unmatched endpoints, verifies the expected chart structure, and writes `dist/family-graph.js`. Source file hashes and original connector coordinates are retained in the generated data for traceability.

If the source PDFs change, update the chart extraction and expected source counts deliberately before regenerating. Do not infer missing connections to make validation pass.

### Verify the pure logic

```sh
node --check dist/map.js
node tests/map-core.test.cjs
```

The tests check every source record’s connectivity and route edges, Bill/Lois partner semantics, Fiachra/Gráinne’s chart parents and sibling route, invalid and cross-chart endpoints, nonoverlapping 240×82 person cards, accent/alias search, and conservative date handling.

The **Check family map** workflow also runs the app’s DOM interactions and real Chromium desktop/phone checks. Browser tests serve only the checked-out `dist` directory on a temporary local server. Screenshots and test results are saved as a workflow artifact. The isolated test dependencies are Playwright 1.62.1 and linkedom 0.18.13; visitors do not download or need them.

To run those checks yourself on a development computer:

```sh
npm install --prefix .test-tools --no-audit --no-fund playwright@1.62.1 linkedom@0.18.13
node .test-tools/node_modules/playwright/cli.js install chromium
NODE_PATH=./.test-tools/node_modules node tests/map-dom.test.cjs
NODE_PATH=./.test-tools/node_modules node tests/map-browser.test.cjs
```

Linux installations may also need Playwright’s `install --with-deps chromium` command. The DOM harness tests state and event handling with declared stubs; only the browser suite establishes rendered geometry and native browser behavior.

## Branch and publishing

The existing **Publish family tree** workflow publishes `dist` from `main`. Creating or updating `family-map-explorer` does not trigger that push-to-main deployment. The original published site continues to come from `main` until a publishing change is intentionally made.

Review this branch locally before merging or manually publishing it. The existing manual workflow can publish the selected branch to the same Pages site, so it is not an isolated preview environment.
