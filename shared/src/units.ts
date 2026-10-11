/**
 * Table de conversion des unites saisies dans l'interface.
 *
 * Portage fidele de app/domain/units.py. Le stockage reste TOUJOURS en grammes
 * (convention CIQUAL) ; l'unite choisie par l'utilisateur n'est que de
 * l'affichage, restituee au rechargement via `recipe_ingredient.unit`.
 *
 * Les conversions volume -> masse supposent une densite de 1 g/ml (celle de
 * l'eau), SAUF pour les cuilleres quand l'ingredient connait le poids de la
 * sienne (`spoonWeightG`) : une cuillere de farine pese 8 g, une d'huile 13,
 * une de miel 21. Les litres et centilitres gardent 1 g/ml : ils servent aux
 * liquides, ou l'ecart reste de quelques pour cent, alors qu'une cuillere de
 * farine comptee comme de l'eau pesait presque le double.
 */

export interface Unit {
  /** Identifiant machine stable, persiste en base. */
  readonly code: string
  /** Libelle affiche, en francais. */
  readonly label: string
  /** Masse en grammes d'une unite. */
  readonly gramsPerUnit: number
}

/**
 * L'ordre est celui des listes deroulantes. `g` en tete : c'est le defaut et
 * le cas le plus frequent.
 */
export const UNITS: readonly Unit[] = [
  { code: 'g', label: 'g', gramsPerUnit: 1.0 },
  { code: 'kg', label: 'kg', gramsPerUnit: 1000.0 },
  { code: 'mg', label: 'mg', gramsPerUnit: 0.001 },
  { code: 'ml', label: 'ml', gramsPerUnit: 1.0 },
  { code: 'cl', label: 'cl', gramsPerUnit: 10.0 },
  { code: 'dl', label: 'dl', gramsPerUnit: 100.0 },
  { code: 'L', label: 'L', gramsPerUnit: 1000.0 },
  { code: 'c_cafe', label: 'c. à café', gramsPerUnit: 5.0 },
  { code: 'c_soupe', label: 'c. à soupe', gramsPerUnit: 15.0 },
  { code: 'tasse', label: 'tasse', gramsPerUnit: 250.0 },
  { code: 'pincee', label: 'pincée', gramsPerUnit: 1.0 },
] as const

export const UNIT_BY_CODE: ReadonlyMap<string, Unit> = new Map(UNITS.map((u) => [u.code, u]))

export const DEFAULT_UNIT_CODE = 'g'

/** Une cuillere a soupe d'eau : le poids suppose quand l'ingredient n'en dit rien. */
export const CUILLERE_SOUPE_G = 15

/** Les deux unites que le poids d'une cuillere corrige. Une c. a cafe vaut le tiers d'une c. a soupe. */
export const CUILLERES: Readonly<Record<string, number>> = { c_soupe: 1, c_cafe: 1 / 3 }

/** Les grammes d'une unite tabulee, corriges par le poids d'une cuillere s'il est connu. */
function grammesPar(unit: Unit, spoonWeightG: number | null | undefined): number {
  const part = CUILLERES[unit.code]
  if (part !== undefined && spoonWeightG && spoonWeightG > 0) return spoonWeightG * part
  return unit.gramsPerUnit
}

/**
 * Code de l'unite « piece », qui n'est pas dans UNITS : son facteur depend de
 * l'ingredient (`piece_weight_g`) et ne peut donc pas etre tabule.
 */
export const PIECE_UNIT_CODE = '_piece'

/**
 * Code de l'unite "g cuits". Comme la piece, son facteur depend de
 * l'ingredient : son rendement a la cuisson (`cookedWeightPer100gRaw`, 300
 * pour le riz : 100 g crus donnent 300 g cuits).
 *
 * LA MASSE STOCKEE RESTE CRUE. Les valeurs nutritionnelles sont pour 100 g
 * CRUS (CIQUAL), le prix aussi, et la liste de courses achete du cru : saisir
 * "200 g cuits" de riz enregistre 66,7 g, et seule l'unite se souvient de la
 * facon dont on l'a dit. C'est la meme regle que la piece, appliquee a la
 * cuisson.
 */
export const COOKED_UNIT_CODE = '_cuit'

export class UnknownUnitError extends Error {
  constructor(code: string) {
    super(`Unite inconnue : '${code}'`)
    this.name = 'UnknownUnitError'
  }
}

/** Le rendement, ou une erreur : sans lui, des grammes cuits ne se convertissent pas. */
function rendement(cookedPer100gRaw: number | null | undefined): number {
  if (!cookedPer100gRaw || cookedPer100gRaw <= 0) {
    throw new UnknownUnitError(`${COOKED_UNIT_CODE} (rendement à la cuisson inconnu)`)
  }
  return cookedPer100gRaw
}

/**
 * Convertit une valeur saisie dans `unitCode` en grammes.
 *
 * `pieceWeightG` n'est requis que pour l'unite piece, `cookedPer100gRaw`
 * que pour les grammes cuits. `spoonWeightG` corrige les cuilleres ; absent,
 * elles comptent comme de l'eau. Le desktop laissait cette conversion a un
 * composant QML ; la centraliser ici evite la divergence constatee dans
 * l'import de recette par URL, qui traitait une piece comme un gramme
 * (annexe #6 de la spec).
 */
export function toGrams(
  value: number,
  unitCode: string,
  pieceWeightG?: number | null,
  cookedPer100gRaw?: number | null,
  spoonWeightG?: number | null,
): number {
  if (unitCode === PIECE_UNIT_CODE) {
    if (!pieceWeightG || pieceWeightG <= 0) {
      throw new UnknownUnitError(`${PIECE_UNIT_CODE} (poids unitaire inconnu)`)
    }
    return value * pieceWeightG
  }
  if (unitCode === COOKED_UNIT_CODE) return (value * 100) / rendement(cookedPer100gRaw)
  const unit = UNIT_BY_CODE.get(unitCode)
  if (!unit) throw new UnknownUnitError(unitCode)
  return value * grammesPar(unit, spoonWeightG)
}

/**
 * Reconvertit une masse stockee en grammes vers `unitCode`, pour l'affichage.
 * En grammes cuits, c'est exactement `cookedWeightG` (nutrition.ts) : un test
 * garde l'egalite, pour que la fiche et le champ ne lisent pas deux poids.
 */
export function fromGrams(
  grams: number,
  unitCode: string,
  pieceWeightG?: number | null,
  cookedPer100gRaw?: number | null,
  spoonWeightG?: number | null,
): number {
  if (unitCode === PIECE_UNIT_CODE) {
    if (!pieceWeightG || pieceWeightG <= 0) {
      throw new UnknownUnitError(`${PIECE_UNIT_CODE} (poids unitaire inconnu)`)
    }
    return grams / pieceWeightG
  }
  if (unitCode === COOKED_UNIT_CODE) return (grams * rendement(cookedPer100gRaw)) / 100
  const unit = UNIT_BY_CODE.get(unitCode)
  if (!unit) throw new UnknownUnitError(unitCode)
  return grams / grammesPar(unit, spoonWeightG)
}

export function labelFor(unitCode: string, pieceWeightG?: number | null, spoonWeightG?: number | null): string {
  if (unitCode === PIECE_UNIT_CODE) {
    return pieceWeightG ? `pièce (${formatGrams(pieceWeightG)})` : 'pièce'
  }
  if (unitCode === COOKED_UNIT_CODE) return 'g cuits'
  const unit = UNIT_BY_CODE.get(unitCode)
  if (!unit) throw new UnknownUnitError(unitCode)
  // Le poids d'une cuillere se lit dans le menu, comme celui d'une piece :
  // "c. à soupe (8 g)" dit pourquoi deux cuilleres de farine font 16 g.
  if (CUILLERES[unitCode] !== undefined && spoonWeightG && spoonWeightG > 0) {
    return `${unit.label} (${formatGrams(grammesPar(unit, spoonWeightG))})`
  }
  return unit.label
}

export function isKnownUnit(unitCode: string): boolean {
  return unitCode === PIECE_UNIT_CODE || unitCode === COOKED_UNIT_CODE || UNIT_BY_CODE.has(unitCode)
}

/**
 * Formate une masse pour l'affichage : `1,25 kg`, `250 g`, `12,5 g`.
 *
 * La branche des kilos suit la regle du desktop (`ShoppingPage.qml:288`) :
 * deux decimales sous 10 kg, une seule au-dela. Arrondir a une decimale partout
 * faisait lire "1,3 kg" pour 1250 g, soit 50 g d'ecart sur une ligne, ce qui se
 * voit en boucherie et au rayon fruits et legumes. Cette fonction alimente la
 * liste de courses, le texte partage, la session en magasin et le frigo :
 * l'erreur se propageait partout.
 *
 * Les zeros de fin restent supprimes (`minimumFractionDigits: 0`), pour ecrire
 * "1 kg" et non "1,00 kg" comme le faisait le desktop.
 *
 * Sous le kilo, on garde une decimale entre 10 et 100 g la ou le desktop
 * arrondissait a l'entier. Divergence assumee : plus precis, jamais trompeur.
 *
 * L'espace avant l'unite est INSECABLE (U+00A0), ecrit en echappement plutot
 * qu'en litteral : un caractere invisible dans un gabarit ne survit pas au
 * premier editeur distrait.
 */
export function formatGrams(grams: number): string {
  const kilos = grams >= 1000
  const value = kilos ? grams / 1000 : grams
  const maxDecimals = kilos ? (value < 10 ? 2 : 1) : value >= 100 ? 0 : 1
  return `${value.toLocaleString('fr-FR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  })} ${kilos ? 'kg' : 'g'}`
}

/**
 * Contenance nette d'un produit emballe, ramenee en grammes.
 *
 * Vit ici, teste, parce qu'elle interprete des donnees EXTERIEURES et
 * incoherentes. OpenFoodFacts rend les deux formes selon le point d'acces :
 * `product_quantity: 400` accompagne de `product_quantity_unit: 'g'`, ou
 * `product_quantity: "360 g"` unite comprise dans la chaine. Le repli sur le
 * libelle humain (`quantity: "360 g"`) rattrape les fiches ou seul lui est
 * renseigne.
 *
 * Les millilitres comptent 1 g pour 1 ml. C'est faux pour l'huile (0,92) et le
 * miel (1,4), mais cette valeur ne sert qu'a proposer « 1 pièce = X g » : une
 * approximation utile vaut mieux qu'un champ vide, et l'utilisateur la voit
 * avant de l'accepter.
 *
 * Rend `null` plutot qu'une valeur douteuse — au-dela de 20 kg on tient une
 * erreur de saisie, pas un produit de course.
 */
export function parseQuantityToGrams(
  value: unknown,
  unit?: unknown,
  fallbackText?: unknown,
): number | null {
  const factors: Record<string, number> = {
    mg: 0.001,
    g: 1,
    kg: 1000,
    ml: 1,
    cl: 10,
    dl: 100,
    l: 1000,
  }

  const fromParts = (amount: unknown, rawUnit: unknown): number | null => {
    const n = typeof amount === 'number' ? amount : Number.parseFloat(String(amount ?? '').replace(',', '.'))
    if (!Number.isFinite(n) || n <= 0) return null
    const factor = factors[String(rawUnit ?? 'g').trim().toLowerCase()]
    return factor === undefined ? null : n * factor
  }

  const fromText = (text: unknown): number | null => {
    const match = /(\d+(?:[.,]\d+)?)\s*(mg|kg|g|ml|cl|dl|l)\b/i.exec(String(text ?? ''))
    return match ? fromParts(match[1], match[2]) : null
  }

  const grams =
    (typeof value === 'number' ? fromParts(value, unit) : fromText(value)) ?? fromText(fallbackText)

  if (grams === null || grams <= 0 || grams > 20_000) return null
  return Math.round(grams * 100) / 100
}
