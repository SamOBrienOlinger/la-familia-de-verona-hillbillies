# La Familia de Verona Hillbillies

## Egelka family tree

An interactive family album built around the original descendant charts. Choose a name in the diagram to open a profile and its photograph, then return to the same place in the tree.

The project builds on Bill’s family-tree research and the charts and photograph supplied by the family.

## Open it locally

Download or clone [this repository](https://github.com/SamOBrienOlinger/la-familia-de-verona-hillbillies), then open [`dist/index.html`](dist/index.html) in a browser. Keep the `dist` folder together so its scripts, styles, diagrams and photographs remain available.

The site uses HTML, CSS and JavaScript with local assets. Viewing it requires no package installation, build step or backend.

## Explore the family

- Switch between **Renee’s branch** and the **Whole family** chart.
- Select any of the **22 cards in Renee’s chart** or **56 cards in Bernard’s chart** to open a profile. These are source-chart cards; some relatives appear in both charts.
- Open the shared photograph from either Jenna’s or Cromwell’s card. Camera markers identify profiles with a photograph; other profiles display “No photo added yet.”
- Search by name, including recorded search aliases such as “Jenna Olinger” and “Cromwell.”
- Use **Diagram** or **Names** view. Small screens initially show the searchable names list, with the diagram available from the same controls.
- Zoom, fit the complete diagram to its window, or drag and scroll to explore. **Find on the tree** locates the person whose profile is open.
- Use the keyboard to navigate controls and open profiles. The dialog supports Escape, a close button and focus restoration. Motion responds to the browser’s reduced-motion preference.

This version is a static photo viewer. Relatives cannot upload photographs or edit records directly through the site; a repository maintainer adds those updates.

## Original records and chart fidelity

The diagrams preserve the original PDF artwork, with clickable areas positioned over each person’s card. The two source charts are retained separately:

| Source | Original PDF |
|---|---|
| Renee Egelka – Descendant Chart | [Open PDF](dist/assets/renee-descendant-chart.pdf) |
| Bernard Egelka – Descendant Chart | [Open PDF](dist/assets/bernard-descendant-chart.pdf) |

Each profile follows its selected source chart. Differences in names, dates and other details remain visible in their respective records for family confirmation. Search aliases help people find a relative while preserving the displayed source name. Profile dates use written month names for readability; the diagrams retain their original notation.

## The Jenna and Cromwell photograph

[`dist/assets/jenna-and-cromwell.png`](dist/assets/jenna-and-cromwell.png) is the exact supplied photograph. One `jenna-cromwell` photo group shares that asset across these four source profiles:

| Chart | Profile ID |
|---|---|
| Renee | `renee-jenna-michelle-kole` |
| Renee | `renee-david-cromwell-crom-johnson` |
| Bernard | `bernard-jenna-kole` |
| Bernard | `bernard-cromwell-johnson` |

The decorative [`family-tree-illustration.png`](dist/assets/family-tree-illustration.png) is generated artwork. It does not depict real relatives.

## Add another photograph

1. Place the photograph in `dist/assets/` with a simple filename.
2. Add an entry to `photoGroups` in [`dist/family-data.js`](dist/family-data.js). For example:

   ```js
   "family-portrait": {
     "src": "assets/family-portrait.jpg",
     "caption": "Names of the people in this photograph",
     "alt": "A brief description identifying the people shown",
     "names": ["First person", "Second person"]
   }
   ```

3. Set `"photoGroup": "family-portrait"` on every relevant person record, including their entries in both charts when applicable. The same group can belong to one person or several people pictured together.
4. Optionally add a `photoLabel` to a person record for a shorter button label within the photograph panel. The full source name is used when this is omitted.
5. Open the site and check the image, caption and matching cards. Commit the updated data and photograph together.

Profiles awaiting a photograph retain `"photoGroup": null`.

## Project files

| Path | Purpose |
|---|---|
| `dist/index.html` | Page structure and profile dialog |
| `dist/styles.css` | Layout, responsive styles and interaction states |
| `dist/app.js` | Search, chart controls, profiles and photograph interactions |
| `dist/family-data.js` | Source profiles, chart coordinates, aliases and photograph mappings |
| `dist/assets/` | Original PDFs, SVG diagrams, supplied photograph and decorative artwork |
| `scripts/extract-family-charts.py` | Regenerates SVG charts and profile data from the supplied PDF charts using Python and PyMuPDF |

The extraction script is a maintenance tool, not a requirement for viewing or deploying the site. Regeneration rewrites `family-data.js`; incorporate new photograph mappings and other data customisations into the script before regenerating, or reapply them afterwards.

## GitHub Pages

The intended GitHub Actions deployment publishes the contents of `dist` to GitHub Pages without a build step.

In the repository, open **Settings → Pages → Build and deployment → Source** and select **GitHub Actions** if that source is not already enabled. Use the repository’s Pages workflow to deploy, and check its result under **Actions**. GitHub Pages provides the site address after configuration and a successful deployment.
