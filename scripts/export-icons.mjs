/**
 * Exporte le jeu d'icones en fichiers `.svg` autonomes, plus une galerie HTML.
 *
 * La source de verite reste `web/src/icons/paths/*.ts` : ce script est un
 * ROBINET, jamais une entree. Regenerer ecrase `docs/icones/` sans etat d'ame,
 * et editer un `.svg` exporte n'a donc aucun effet sur l'application.
 *
 * A quoi ca sert :
 *   - relire les deux cents dessins d'un coup d'oeil, ce qu'aucune revue de
 *     `d="M12 9.8c-1.3..."` ne permettra jamais ;
 *   - disposer de fichiers reutilisables hors de l'application (maquettes,
 *     documentation, application de bureau tant qu'elle vit).
 *
 *   node scripts/export-icons.mjs
 */

import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'icones')

/**
 * Charge un module TypeScript sans etape de compilation persistante.
 *
 * esbuild produit le JavaScript en memoire, qu'on importe via une URL `data:`.
 * Le detour evite d'ajouter ts-node au projet pour un script qui tourne trois
 * fois par an, et garantit que ce qui est exporte est bien ce que le bundle de
 * l'application embarque.
 */
async function loadModule(entry) {
  const result = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}

const { ICON_PATHS, ICON_FAMILIES } = await loadModule('web/src/icons/registry.ts')

// ---------------------------------------------------------------------------
// Fichiers .svg
// ---------------------------------------------------------------------------

const svgFile = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>\n`

await rm(OUT, { recursive: true, force: true })
await mkdir(join(OUT, 'svg'), { recursive: true })

for (const [name, inner] of Object.entries(ICON_PATHS)) {
  await writeFile(join(OUT, 'svg', `${name}.svg`), svgFile(inner), 'utf8')
}

// ---------------------------------------------------------------------------
// Galerie
// ---------------------------------------------------------------------------

/**
 * Sprite unique, en tete de document.
 *
 * Chaque icone est rendue cinq fois dans la galerie (une grande, quatre
 * tailles de controle). En repetant son balisage, le fichier pesait 362 ko —
 * pour un fichier versionne et regenerable, c'est du gaspillage pur. Avec un
 * `<symbol>` par icone et des `<use>`, le dessin n'apparait qu'une fois.
 *
 * `currentColor` traverse `<use>` sans probleme tant que le sprite est INLINE
 * dans le document. Ce ne serait pas vrai d'un sprite charge depuis un fichier
 * separe, ou plusieurs moteurs refusent encore l'heritage de la couleur.
 */
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${Object.entries(
  ICON_PATHS,
)
  .map(([name, inner]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`)
  .join('')}</svg>`

// Les attributs communs partent en CSS (`.cell svg`) : repetes sur mille
// balises, ils pesaient a eux seuls la moitie du fichier.
const useTag = (name, size) =>
  `<svg width="${size}" height="${size}"><use href="#i-${name}"/></svg>`

const cell = (name) => `
      <figure class="cell">
        <div class="frame">${useTag(name, 48)}</div>
        <div class="sizes">${[16, 20, 24, 32].map((size) => useTag(name, size)).join('')}</div>
        <figcaption>${name}</figcaption>
      </figure>`

const sections = ICON_FAMILIES.map(
  (family) => `
    <section>
      <h2>${family.title} <span class="count">${family.names.length}</span></h2>
      <div class="grid">${family.names.map(cell).join('')}</div>
    </section>`,
).join('')

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jeu d'icônes — Prandia</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f8fafc; --surface: #fff; --text: #0f172a; --muted: #64748b; --line: #e2e8f0;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f172a; --surface: #1e293b; --text: #f1f5f9; --muted: #94a3b8; --line: #334155; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px; background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
  }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 28px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted);
       margin: 34px 0 12px; display: flex; align-items: center; gap: 8px; }
  .count { font-size: 11px; background: var(--line); color: var(--text);
           padding: 1px 7px; border-radius: 999px; letter-spacing: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .cell { margin: 0; padding: 12px 8px 10px; background: var(--surface);
          border: 1px solid var(--line); border-radius: 10px; text-align: center; }
  .frame { display: grid; place-items: center; height: 68px; }
  .cell svg {
    fill: none; stroke: currentColor; stroke-width: 1.6;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .frame svg { width: 48px; height: 48px; }
  /* Grille de contrôle : la zone utile est le carré 3→21 sur 24. */
  .frame { background:
      linear-gradient(to right, transparent 12.5%, color-mix(in srgb, var(--muted) 14%, transparent) 12.5% 12.6%, transparent 12.6%),
      linear-gradient(to right, transparent 87.5%, color-mix(in srgb, var(--muted) 14%, transparent) 87.5% 87.6%, transparent 87.6%),
      linear-gradient(to bottom, transparent 12.5%, color-mix(in srgb, var(--muted) 14%, transparent) 12.5% 12.6%, transparent 12.6%),
      linear-gradient(to bottom, transparent 87.5%, color-mix(in srgb, var(--muted) 14%, transparent) 87.5% 87.6%, transparent 87.6%);
    background-size: 48px 48px; background-position: center; background-repeat: no-repeat; }
  .sizes { display: flex; align-items: flex-end; justify-content: center; gap: 8px; height: 34px; }
  figcaption { margin-top: 6px; font-size: 11px; color: var(--muted); word-break: break-all; }
</style>
</head>
<body>
  ${sprite}
  <h1>Jeu d'icônes</h1>
  <p class="lead">${Object.keys(ICON_PATHS).length} icônes. Grille 24, trait 1,6, zone utile 3&nbsp;→&nbsp;21 (repères gris).
     Rendu à 16, 20, 24 et 32&nbsp;px sous chaque dessin.</p>
  ${sections}
</body>
</html>
`

await writeFile(join(OUT, 'index.html'), html, 'utf8')

console.log(`${Object.keys(ICON_PATHS).length} icônes exportées dans docs/icones/`)
