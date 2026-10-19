# La Familia de Verona Hillbillies

## Egelka family tree

**[Open the live family tree](https://samobrienolinger.github.io/la-familia-de-verona-hillbillies/)**

An interactive family album built around the original descendant charts. Choose a name in the diagram to open a profile and its photograph or video, then return to the same place in the tree.

The project builds on Bill’s family-tree research and the charts, photograph and video supplied by the family.

## Open it locally

Download or clone [this repository](https://github.com/SamOBrienOlinger/la-familia-de-verona-hillbillies), then open [`dist/index.html`](dist/index.html) in a browser. Keep the `dist` folder together so its scripts, styles, diagrams and photographs remain available.

The site uses HTML, CSS and JavaScript with local assets. Viewing it requires no package installation, build step or backend.

## Explore the family

- Switch between **Renee’s branch** and the **Whole family** chart.
- Select any of the **22 cards in Renee’s chart** or **56 cards in Bernard’s chart** to open a profile. These are source-chart cards; some relatives appear in both charts.
- Open the shared photograph from either Jenna’s or Cromwell’s card. Open Dan Kole’s video from his card, with native playback, sound and fullscreen controls.
- Camera and play markers identify profiles with a photograph or video; other profiles display “No photo or video added yet.”
- Search by name, including aliases such as “Jenna Olinger,” “Cromwell” and “Dan Kole.”
- Use **Diagram** or **Names** view. Small screens initially show the searchable names list, with the diagram available from the same controls.
- Zoom, fit the complete diagram to its window, or drag and scroll to explore. **Find on the tree** locates the person whose profile is open.
- Use the keyboard to navigate controls and open profiles. The dialog supports Escape, a close button and focus restoration. Motion responds to the browser’s reduced-motion preference.

This version is a static family album. Relatives cannot upload files or edit records directly through the site; a repository maintainer adds those updates.

## Original records and chart fidelity

The diagrams preserve the original PDF artwork, with clickable areas positioned over each person’s card. The two source charts are retained separately:

| Source | Original PDF |
|---|---|
| Renee Egelka – Descendant Chart | [Open PDF](dist/assets/renee-descendant-chart.pdf) |
| Bernard Egelka – Descendant Chart | [Open PDF](dist/assets/bernard-descendant-chart.pdf) |

Each profile follows its selected source chart. Differences in names, dates and other details remain visible in their respective records for family confirmation. Search aliases help people find a relative while preserving the displayed source name. Profile dates use written month names for readability; the diagrams retain their original notation.

## The Jenna and Cromwell photograph

[`dist/assets/jenna-and-cromwell.png`](dist/assets/jenna-and-cromwell.png) is the exact supplied photograph. One `jenna-cromwell` media group shares that asset across these four source profiles:

| Chart | Profile ID |
|---|---|
| Renee | `renee-jenna-michelle-kole` |
| Renee | `renee-david-cromwell-crom-johnson` |
| Bernard | `bernard-jenna-kole` |
| Bernard | `bernard-cromwell-johnson` |

The decorative [`family-tree-illustration.png`](dist/assets/family-tree-illustration.png) is generated artwork. It does not depict real relatives.

## Dan Kole’s video

The family identified the supplied clip for Susan Olinger’s husband Dan Kole. [`dist/assets/dan-kole.mp4`](dist/assets/dan-kole.mp4) links to `renee-daniel-joseph-kole` and `bernard-daniel-kole` through the `dan-kole` media group.

The original MOV was remuxed to MP4 without recompression or trimming. The full 15.508-second video and audio file is preserved, with H.264 video, AAC audio and faststart for browser playback. [`dan-kole-poster.jpg`](dist/assets/dan-kole-poster.jpg) is a real frame from that clip.

Playback starts only when the visitor presses Play. Closing the profile or changing to another person pauses and resets the player.

## Add another photograph or video

1. Place the photograph or browser-compatible video in `dist/assets/` with a simple filename.
2. Add an entry to `mediaGroups` in [`dist/family-data.js`](dist/family-data.js). For example:

   ```js
   "family-portrait": {
     "type": "image",
     "src": "assets/family-portrait.jpg",
     "caption": "Names of the people in this photograph",
     "alt": "A brief description identifying the people shown",
     "names": ["First person", "Second person"]
   }
   ```

3. For a video, use `"type": "video"`, point `src` to the video and add an optional `poster` image path. The existing `dan-kole` group is a complete example.
4. Set `"mediaGroup": "family-portrait"` on every relevant person record, including their entries in both charts when applicable. One group can be shared by several people.
5. Optionally add a `mediaLabel` to a person record for a shorter button label within the media panel. The full source name is used when this is omitted.
6. Open the site and check the photograph or video, caption and matching cards. Commit the updated data and assets together.

Profiles awaiting a photograph or video retain `"mediaGroup": null`.

## Project files

| Path | Purpose |
|---|---|
| `dist/index.html` | Page structure and profile dialog |
| `dist/styles.css` | Layout, responsive styles and interaction states |
| `dist/app.js` | Search, chart controls, profiles, photographs and video playback |
| `dist/family-data.js` | Source profiles, chart coordinates, aliases and media mappings |
| `dist/assets/` | Original PDFs, SVG diagrams, supplied family media and decorative artwork |
| `scripts/extract-family-charts.py` | Regenerates SVG charts and profile data from the supplied PDF charts using Python and PyMuPDF |

The extraction script is a maintenance tool, not a requirement for viewing or deploying the site. Regeneration rewrites `family-data.js`; incorporate new media mappings and other data customisations into the script before regenerating, or reapply them afterwards.

## GitHub Pages

GitHub Pages is enabled for this repository. The **Publish family tree** GitHub Actions workflow publishes the contents of `dist` whenever changes are pushed to `main`, without a build step. It can also be run manually from the Actions tab.

If you copy the project into another repository, select **Settings → Pages → Build and deployment → Source → GitHub Actions** once, then run the workflow. The site uses relative asset URLs so it can be hosted beneath a repository path.
