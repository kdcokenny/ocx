---
name: frontend-philosophy
description: Visual & UI philosophy (The 5 Pillars of Intentional UI). Understand deeply to avoid "AI slop" and create distinctive, memorable interfaces.
---

# Frontend Design Philosophy: The 5 Pillars of Intentional UI

**Role:** Design Director for all **Visual & Aesthetic decisions** — applies to styling, layout, colors, typography, animations, and UI composition.

**Philosophy:** Distinctive, memorable, intentional design — avoiding generic "AI slop" aesthetics through bold, characterful choices that create immediate emotional impact.

## The 5 Pillars

### 1. Typography with Character
- **Concept:** Fonts set the entire tone. Generic fonts create generic, forgettable interfaces.
- **Rule:** Avoid Inter, Roboto, Arial, and system-ui defaults. Choose distinctive, characterful typefaces.
- **Practice:** Pair dramatic display fonts with refined, readable body fonts.

### 2. Committed Color & Theme
- **Concept:** Timid palettes lack impact and feel algorithmically generated.
- **Rule:** Use bold, dominant colors with sharp accent contrasts. Avoid evenly-distributed rainbow gradients.
- **Practice:** Establish CSS variable systems early. Break away from the "purple gradient on white" AI cliché.

### 3. Purposeful Motion
- **Concept:** Animation should delight, not distract. Scattered micro-interactions create noise.
- **Rule:** One well-orchestrated animation beats a dozen minor transitions. Focus on high-impact moments.
- **Practice:** Use CSS animations for HTML, Motion library for React. Prioritize staggered reveals and surprsing hover states.

### 4. Brave Spatial Composition
- **Concept:** Predictable layouts are forgettable. Safe spacing feels automated.
- **Rule:** Either generous negative space OR controlled density — not the middle ground.
- **Practice:** Embrace asymmetry, overlap, diagonal flow, and grid-breaking elements.

### 5. Atmosphere & Depth
- **Concept:** Flat solid backgrounds lack presence and feel unfinished.
- **Rule:** Layer visual richness through gradient meshes, noise textures, geometric patterns, and transparencies.
- **Practice:** Add dramatic shadows, decorative borders, grain overlays.

---

## Adherence Checklist
Before completing your task, verify:
- [ ] **Typography:** Did you avoid generic system fonts?
- [ ] **Color:** Are the color choices bold and intentional?
- [ ] **Motion:** Is there a primary, high-impact animation?
- [ ] **Space:** Does the layout feel designed rather than templated?
- [ ] **Depth:** Is there visual richness (textures, gradients, layering)?
