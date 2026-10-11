/**
 * Lire une photo d'emballage ou d'etiquette : la date, le prix, la quantite.
 *
 * Le serveur envoie la photo a un modele de vision (Claude Haiku) avec UNE
 * question et UN outil dont le schema force la forme de la reponse. Ce module,
 * pur, tient les questions, les schemas et surtout la VERIFICATION de ce qui
 * revient : un modele peut repondre "12" pour un prix ou 125 000 g pour un
 * pot. Rien de ce qu'il rend n'atteint un champ sans passer ici, et rien
 * n'atteint la base sans un toucher de l'utilisateur.
 *
 * POURQUOI UN MODELE ET PAS LA LECTURE DE L'IPHONE. Celle d'Apple est cachee
 * dans un sous-menu depuis iOS 17, n'existe pas sur Android, et ne sait que
 * coller du texte : elle ne dit pas lequel des trois prix d'une etiquette est
 * celui de l'article. Un moteur embarque (Tesseract) lit mal les dates en
 * points. Le cout, a 500 photos par mois, reste sous le dixieme de centime
 * par photo, couvert par les credits API inclus dans l'abonnement.
 */

export const SCAN_KINDS = ['date', 'prix', 'quantite'] as const
export type ScanKind = (typeof SCAN_KINDS)[number]

export const isScanKind = (valeur: unknown): valeur is ScanKind =>
  typeof valeur === 'string' && (SCAN_KINDS as readonly string[]).includes(valeur)

/** L'outil que le modele DOIT appeler : sa reponse a la forme du schema. */
export interface ScanTool {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

const texteOuNul = { type: ['string', 'null'] }
const nombreOuNul = { type: ['number', 'null'] }

/** La question posee au modele, et l'outil par lequel il repond. */
export const SCAN_QUESTIONS: Readonly<Record<ScanKind, { readonly question: string; readonly tool: ScanTool }>> = {
  date: {
    question:
      "Photo d'un emballage alimentaire. Recopie la date de peremption imprimee : la DLC (a consommer jusqu'au) ou la DDM (a consommer de preference avant). Recopie-la exactement comme imprimee, chiffres et separateurs compris (30.06.2028, 14/10/26, 03/2027, 14 OCT 2026), sans numero de lot ni heure. S'il y a plusieurs dates, prends celle de peremption. Si aucune n'est lisible, texte vaut null.",
    tool: {
      name: 'date_lue',
      description: 'Rend la date de peremption telle qu’imprimee.',
      input_schema: {
        type: 'object',
        properties: { texte: { ...texteOuNul, description: 'La date telle qu’imprimee, ou null.' } },
        required: ['texte'],
      },
    },
  },
  prix: {
    question:
      "Photo d'une etiquette de prix en magasin, ou d'un emballage. Donne le prix de vente de l'ARTICLE en euros, celui qu'on paie a la caisse : jamais le prix au kilo ni au litre. En cas de promotion affichee, le prix promotionnel. Si aucun prix n'est lisible, prix vaut null.",
    tool: {
      name: 'prix_lu',
      description: 'Rend le prix de l’article.',
      input_schema: {
        type: 'object',
        properties: {
          prix: { ...nombreOuNul, description: 'Prix de l’article en euros, ex. 2.49, ou null.' },
          texte_lu: { ...texteOuNul, description: 'Le prix tel qu’imprime, ex. "2,49 €".' },
        },
        required: ['prix', 'texte_lu'],
      },
    },
  },
  quantite: {
    question:
      "Photo d'un emballage alimentaire. Donne la quantite nette : le nombre d'unites et la contenance d'UNE unite. \"12 x 125 g\" : nombre 12, contenance 125, unite g. \"500 g\" : nombre 1, contenance 500, unite g. \"6 x 33 cl\" : nombre 6, contenance 33, unite cl. Pour une conserve, le poids net total, pas le poids egoutte. Si rien n'est lisible, tout vaut null.",
    tool: {
      name: 'quantite_lue',
      description: 'Rend la quantite nette de l’emballage.',
      input_schema: {
        type: 'object',
        properties: {
          nombre: { ...nombreOuNul, description: 'Nombre d’unites, 1 pour un produit seul.' },
          contenance: { ...nombreOuNul, description: 'Contenance d’une unite.' },
          unite: { type: ['string', 'null'], enum: ['g', 'kg', 'ml', 'cl', 'l', null] },
          texte_lu: { ...texteOuNul, description: 'La quantite telle qu’imprimee, ex. "12 x 125 g".' },
        },
        required: ['nombre', 'contenance', 'unite', 'texte_lu'],
      },
    },
  },
}

export type ScanResult =
  | { readonly kind: 'date'; readonly texte: string | null }
  | { readonly kind: 'prix'; readonly prixEur: number | null; readonly texte: string | null }
  | {
      readonly kind: 'quantite'
      readonly nombre: number | null
      readonly contenanceG: number | null
      readonly texte: string | null
    }

const GRAMMES_PAR_UNITE: Readonly<Record<string, number>> = { g: 1, kg: 1000, ml: 1, cl: 10, l: 1000 }

const texteBorne = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null

const nombre = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * Ce que le modele a rendu, verifie et ramene aux unites de Prandia.
 *
 * Les bornes ecartent l'absurde sans juger le plausible : un prix entre un
 * centime et 500 EUR, une unite de 1 g a 20 kg, au plus 100 unites. Hors de
 * ces bornes, le champ revient VIDE plutot que faux : un champ vide se voit,
 * un chiffre faux se valide d'un pouce.
 */
export function interpretScan(kind: ScanKind, entree: unknown): ScanResult {
  const o = (entree !== null && typeof entree === 'object' ? entree : {}) as Record<string, unknown>

  if (kind === 'date') return { kind, texte: texteBorne(o['texte'], 80) }

  if (kind === 'prix') {
    const prix = nombre(o['prix'])
    const ok = prix !== null && prix >= 0.01 && prix <= 500
    return { kind, prixEur: ok ? Math.round(prix * 100) / 100 : null, texte: texteBorne(o['texte_lu'], 40) }
  }

  const facteur = typeof o['unite'] === 'string' ? GRAMMES_PAR_UNITE[o['unite'].toLowerCase()] : undefined
  const contenance = nombre(o['contenance'])
  const contenanceG =
    facteur !== undefined && contenance !== null && contenance > 0 && contenance * facteur <= 20_000
      ? Math.round(contenance * facteur * 10) / 10
      : null
  const brut = nombre(o['nombre'])
  const n = brut === null ? (contenanceG === null ? null : 1) : Math.round(brut)
  return {
    kind,
    nombre: n !== null && n >= 1 && n <= 100 ? n : null,
    contenanceG,
    texte: texteBorne(o['texte_lu'], 40),
  }
}
