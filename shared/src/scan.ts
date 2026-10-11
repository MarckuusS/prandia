/**
 * Lire une photo d'emballage ou d'etiquette, UN CHAMP A LA FOIS : la date, le
 * prix, la quantite, le nom, la marque, et le tableau nutritionnel.
 *
 * Un champ, une photo, une valeur (decision du 2026-10-11) : "remplir avec une
 * photo" demandait nom, marque et poids d'un coup, alors qu'une photo ne les
 * montre presque jamais ensemble, et la reponse etait lente. Une exception,
 * demandee : le poids lu sur une ETIQUETTE DE BALANCE rend aussi le prix a
 * payer, imprime juste a cote, que l'ecran pose s'il est vide.
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

export const SCAN_KINDS = ['date', 'prix', 'quantite', 'nom', 'marque', 'nutrition'] as const
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
      "Photo d'un emballage alimentaire ou d'une etiquette de magasin. Donne la quantite nette : le nombre d'unites et la contenance d'UNE unite. \"12 x 125 g\" : nombre 12, contenance 125, unite g. \"500 g\" : nombre 1, contenance 500, unite g. \"6 x 33 cl\" : nombre 6, contenance 33, unite cl. Pour une conserve, le poids net total, pas le poids egoutte. Si c'est une etiquette imprimee par une BALANCE de magasin (vrac, boucherie, fromage a la coupe) : nombre 1, contenance = le poids NET (jamais la tare), et prix_balance = le prix a payer en euros (jamais le prix au kilo) ; pour tout autre emballage, prix_balance vaut null. Si rien n'est lisible, tout vaut null.",
    tool: {
      name: 'quantite_lue',
      description: 'Rend la quantite nette, et le prix a payer d’une etiquette de balance.',
      input_schema: {
        type: 'object',
        properties: {
          nombre: { ...nombreOuNul, description: 'Nombre d’unites, 1 pour un produit seul.' },
          contenance: { ...nombreOuNul, description: 'Contenance d’une unite.' },
          unite: { type: ['string', 'null'], enum: ['g', 'kg', 'ml', 'cl', 'l', null] },
          prix_balance: { ...nombreOuNul, description: 'Prix a payer, seulement sur une etiquette de balance.' },
          texte_lu: { ...texteOuNul, description: 'La quantite telle qu’imprimee, ex. "12 x 125 g".' },
        },
        required: ['nombre', 'contenance', 'unite', 'prix_balance', 'texte_lu'],
      },
    },
  },
  nom: {
    question:
      "Photo de l'emballage d'un produit alimentaire. Donne le nom du produit tel qu'on l'ecrirait dans une liste de courses ou une recette, en francais, SANS la marque (ex. \"Thon a l'huile d'olive\", \"Yaourt nature\", \"Lentilles vertes\"). Si aucun nom n'est lisible, nom vaut null.",
    tool: {
      name: 'nom_lu',
      description: 'Rend le nom du produit, sans la marque.',
      input_schema: {
        type: 'object',
        properties: { nom: { ...texteOuNul, description: 'Nom du produit, sans la marque.' } },
        required: ['nom'],
      },
    },
  },
  marque: {
    question:
      "Photo de l'emballage d'un produit alimentaire. Donne la MARQUE du produit (ex. \"Danone\", \"Bonduelle\", \"Carrefour Bio\"), pas le nom du produit. Si aucune marque n'est lisible, marque vaut null.",
    tool: {
      name: 'marque_lue',
      description: 'Rend la marque du produit.',
      input_schema: {
        type: 'object',
        properties: { marque: { ...texteOuNul } },
        required: ['marque'],
      },
    },
  },
  nutrition: {
    question:
      "Photo d'un tableau de valeurs nutritionnelles. Donne les valeurs POUR 100 g (ou 100 ml), jamais par portion. L'energie en kcal, pas en kJ. Si le tableau ne donne que des valeurs par portion, ou si une ligne est illisible, elle vaut null.",
    tool: {
      name: 'nutrition_lue',
      description: 'Rend les valeurs nutritionnelles pour 100 g.',
      input_schema: {
        type: 'object',
        properties: {
          energie_kcal: { ...nombreOuNul },
          matieres_grasses: { ...nombreOuNul },
          acides_gras_satures: { ...nombreOuNul },
          glucides: { ...nombreOuNul },
          sucres: { ...nombreOuNul },
          fibres: { ...nombreOuNul },
          proteines: { ...nombreOuNul },
          sel: { ...nombreOuNul },
        },
        required: [
          'energie_kcal',
          'matieres_grasses',
          'acides_gras_satures',
          'glucides',
          'sucres',
          'fibres',
          'proteines',
          'sel',
        ],
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
      /** Le prix a payer, lu seulement sur une etiquette de BALANCE ; sinon `null`. */
      readonly prixEur: number | null
      readonly texte: string | null
    }
  | { readonly kind: 'nom'; readonly nom: string | null }
  | { readonly kind: 'marque'; readonly marque: string | null }
  | {
      readonly kind: 'nutrition'
      readonly kcal: number | null
      readonly fats: number | null
      readonly saturatedFats: number | null
      readonly carbs: number | null
      readonly sugars: number | null
      readonly fiber: number | null
      readonly proteins: number | null
      readonly salt: number | null
    }

/** Rien d'utilisable dans la lecture : l'ecran le dit au lieu de fermer le viseur. */
export function isEmptyScan(r: ScanResult): boolean {
  switch (r.kind) {
    case 'date':
      return r.texte === null
    case 'prix':
      return r.prixEur === null
    case 'quantite':
      return r.contenanceG === null && r.prixEur === null
    case 'nom':
      return r.nom === null
    case 'marque':
      return r.marque === null
    case 'nutrition':
      return [r.kcal, r.fats, r.carbs, r.proteins].every((v) => v === null)
  }
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

  switch (kind) {
    case 'date':
      return { kind, texte: texteBorne(o['texte'], 80) }
    case 'prix':
      return { kind, prixEur: prixBorne(o['prix']), texte: texteBorne(o['texte_lu'], 40) }
    case 'quantite':
      return { kind, ...quantiteBornee(o), prixEur: prixBorne(o['prix_balance']), texte: texteBorne(o['texte_lu'], 40) }
    case 'nom':
      return { kind, nom: texteBorne(o['nom'], 80) }
    case 'marque':
      return { kind, marque: texteBorne(o['marque'], 60) }
    case 'nutrition':
      return nutritionBornee(o)
  }
}

function prixBorne(v: unknown): number | null {
  const prix = nombre(v)
  return prix !== null && prix >= 0.01 && prix <= 500 ? Math.round(prix * 100) / 100 : null
}

/** Une masse dans son unite, en grammes, entre 1 g et 20 kg ; sinon `null`. */
function grammesBornes(valeur: unknown, unite: unknown): number | null {
  const facteur = typeof unite === 'string' ? GRAMMES_PAR_UNITE[unite.toLowerCase()] : undefined
  const v = nombre(valeur)
  if (facteur === undefined || v === null || v <= 0) return null
  const g = v * facteur
  return g >= 1 && g <= 20_000 ? Math.round(g * 10) / 10 : null
}

function quantiteBornee(o: Record<string, unknown>): { nombre: number | null; contenanceG: number | null } {
  const contenanceG = grammesBornes(o['contenance'], o['unite'])
  const brut = nombre(o['nombre'])
  const n = brut === null ? (contenanceG === null ? null : 1) : Math.round(brut)
  return { nombre: n !== null && n >= 1 && n <= 100 ? n : null, contenanceG }
}

/**
 * Le tableau nutritionnel, pour 100 g. Une valeur hors de ce que 100 g peuvent
 * contenir revient vide, et deux incoherences sont rattrapees : des sucres
 * au-dessus des glucides, des acides gras satures au-dessus des lipides. Une
 * sous-ligne lue sur la mauvaise ligne est l'erreur de lecture typique d'un
 * tableau serre.
 */
function nutritionBornee(o: Record<string, unknown>): Extract<ScanResult, { kind: 'nutrition' }> {
  const borne = (cle: string, max: number) => {
    const v = nombre(o[cle])
    return v !== null && v >= 0 && v <= max ? Math.round(v * 10) / 10 : null
  }
  const fats = borne('matieres_grasses', 100)
  const carbs = borne('glucides', 100)
  const saturatedFats = borne('acides_gras_satures', 100)
  const sugars = borne('sucres', 100)
  return {
    kind: 'nutrition',
    kcal: borne('energie_kcal', 900),
    fats,
    saturatedFats: saturatedFats !== null && fats !== null && saturatedFats > fats ? null : saturatedFats,
    carbs,
    sugars: sugars !== null && carbs !== null && sugars > carbs ? null : sugars,
    fiber: borne('fibres', 100),
    proteins: borne('proteines', 100),
    salt: borne('sel', 100),
  }
}
