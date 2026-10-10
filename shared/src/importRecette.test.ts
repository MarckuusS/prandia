/**
 * Import de recette par lien. Les cas de `parseIngredientLine` reprennent un
 * par un ceux de tests/test_recipe_url_quantity_parser.py (desktop), puis les
 * ajouts du portage. Attendus ecrits a la main.
 */

import { describe, expect, it } from 'vitest'

import {
  PIECE_SUPPOSEE_G,
  SEUIL_RETENU,
  SEUIL_SUR,
  dureeEnMinutes,
  extractJsonLdBlocks,
  extractOgImage,
  importAmount,
  lienRecette,
  matchScore,
  parseIngredientLine,
  parseRecipeJsonLd,
  searchTerms,
  texteBrut,
} from './importRecette.js'

const lire = (texte: string) => {
  const { quantity, unit, name } = parseIngredientLine(texte)
  return [quantity, unit, name]
}

describe('lienRecette', () => {
  it('prend l’adresse seule, ou la premiere d’un texte partage', () => {
    expect(lienRecette('https://www.marmiton.org/recettes/gratin.aspx')).toBe('https://www.marmiton.org/recettes/gratin.aspx')
    expect(lienRecette('Gratin de courgettes - Marmiton https://www.marmiton.org/recettes/gratin.aspx')).toBe(
      'https://www.marmiton.org/recettes/gratin.aspx',
    )
  })

  it('complete un domaine colle sans https, et retire l’ancre et la ponctuation finale', () => {
    expect(lienRecette('cuisineaz.com/recettes/soupe-1234.aspx')).toBe('https://cuisineaz.com/recettes/soupe-1234.aspx')
    expect(lienRecette('(voir https://exemple.fr/tarte#commentaires).')).toBe('https://exemple.fr/tarte')
  })

  it('refuse ce qui n’est pas un site public', () => {
    expect(lienRecette('')).toBeNull()
    expect(lienRecette('gratin de courgettes')).toBeNull()
    expect(lienRecette('http://localhost:8787/recettes')).toBeNull()
    expect(lienRecette('http://192.168.1.10/recette')).toBeNull()
    expect(lienRecette('http://10.0.0.1/')).toBeNull()
    expect(lienRecette('http://[::1]/')).toBeNull()
    expect(lienRecette('https://moi:secret@exemple.fr/')).toBeNull()
    expect(lienRecette('ftp://exemple.fr/recette')).toBeNull()
  })
})

describe('parseIngredientLine, cas repris du desktop', () => {
  it.each([
    ['200 g de tomates cerises', 200, 'g', 'tomates cerises'],
    ["30 g d'huile d'olive", 30, 'g', "huile d'olive"],
    ['500 gr de farine', 500, 'g', 'farine'],
    ['1 kg de pommes de terre', 1, 'kg', 'pommes de terre'],
    ['300 ml de lait', 300, 'ml', 'lait'],
    ['25 cl de vin blanc', 25, 'cl', 'vin blanc'],
    ["1 l d'eau", 1, 'L', 'eau'],
    ["1 c. à soupe d'huile d'olive", 1, 'c_soupe', "huile d'olive"],
    ['2 cas de sucre', 2, 'c_soupe', 'sucre'],
    ['1,5 cuillères à café de sel', 1.5, 'c_cafe', 'sel'],
    ['3 cc de cumin', 3, 'c_cafe', 'cumin'],
    ['1 pincée de poivre', 1, 'pincee', 'poivre'],
    ['2 tasses de riz', 2, 'tasse', 'riz'],
    ['1/2 oignon', 0.5, null, 'oignon'],
    ['1/4 c. à café de muscade', 0.25, 'c_cafe', 'muscade'],
    ['Sel, poivre', null, null, 'Sel, poivre'],
    ['1 oignon', 1, null, 'oignon'],
    ['3 carottes', 3, null, 'carottes'],
    ['50ml de crème', 50, 'ml', 'crème'],
    ['  200  g   de  tomates  ', 200, 'g', 'tomates'],
    ['100 G de chocolat', 100, 'g', 'chocolat'],
    ['1 pièce(s) Oignon', 1, null, 'Oignon'],
    ['1 paquet(s) Crème liquide', 1, null, 'Crème liquide'],
    ['1 sachet(s) Épinards', 1, null, 'Épinards'],
    ['2 pièce(s) Cuisse de poulet', 2, null, 'Cuisse de poulet'],
    ['2 pieces de tomate', 2, null, 'tomate'],
  ])('%s', (texte, quantite, unite, nom) => {
    expect(lire(texte)).toEqual([quantite, unite, nom])
  })

  it('lit les deux ecritures du nombre decimal', () => {
    expect(parseIngredientLine('1,5 kg de carottes').quantity).toBe(1.5)
    expect(parseIngredientLine('0.5 kg de farine').quantity).toBe(0.5)
  })

  it('garde "gousse" dans le nom : c’est un ingredient, pas une unite', () => {
    expect(lire("1 gousse d'ail")).toEqual([1, null, "gousse d'ail"])
  })

  it('rend une ligne vide pour une entree vide', () => {
    expect(lire('')).toEqual([null, null, ''])
    expect(lire('   ')).toEqual([null, null, ''])
  })
})

describe('parseIngredientLine, ajouts du portage', () => {
  it('lit les fractions ecrites en un seul signe', () => {
    expect(lire('½ citron')).toEqual([0.5, null, 'citron'])
    expect(lire('1½ c. à soupe de miel')).toEqual([1.5, 'c_soupe', 'miel'])
  })

  it('prend la moyenne d’une fourchette', () => {
    expect(lire('2 à 3 carottes')).toEqual([2.5, null, 'carottes'])
    expect(lire('1-2 c. à café de paprika')).toEqual([1.5, 'c_cafe', 'paprika'])
  })

  it('n’avale pas un mot qui commence par "a" apres le nombre', () => {
    expect(lire('2 abricots')).toEqual([2, null, 'abricots'])
  })

  it('prend la contenance entre parentheses d’un contenant', () => {
    expect(lire('1 boîte de tomates concassées (400 g)')).toEqual([400, 'g', 'tomates concassées'])
    expect(lire('2 pots (125 g) de yaourt nature')).toEqual([250, 'g', 'yaourt nature'])
  })

  it('reconnait les abreviations courantes des cuilleres', () => {
    expect(parseIngredientLine('1 c. à s. de vinaigre').unit).toBe('c_soupe')
    expect(parseIngredientLine('2 càc de cannelle').unit).toBe('c_cafe')
    expect(parseIngredientLine('1 cuil. à soupe de moutarde').unit).toBe('c_soupe')
  })

  it('ne confond pas une unite avec le debut d’un mot', () => {
    expect(parseIngredientLine('2 gros oignons').unit).toBeNull()
    expect(parseIngredientLine('1 litre de lait').unit).toBe('L')
    expect(parseIngredientLine('3 carottes').unit).toBeNull()
  })
})

describe('importAmount', () => {
  it('convertit une unite lue', () => {
    expect(importAmount({ quantity: 2, unit: 'c_soupe' }, { pieceWeightG: null })).toEqual({
      grams: 30,
      unit: 'c_soupe',
      estimated: false,
    })
  })

  it('pese des pieces avec le poids de l’ingredient', () => {
    expect(importAmount({ quantity: 3, unit: null }, { pieceWeightG: 60 })).toEqual({
      grams: 180,
      unit: '_piece',
      estimated: false,
    })
  })

  it('suppose cent grammes la piece quand l’ingredient n’en dit rien, et le signale', () => {
    expect(importAmount({ quantity: 2, unit: null }, { pieceWeightG: null })).toEqual({
      grams: 2 * PIECE_SUPPOSEE_G,
      unit: 'g',
      estimated: true,
    })
  })

  it('fait d’un assaisonnement sans quantite une pincee a verifier', () => {
    expect(importAmount({ quantity: null, unit: null, name: 'Sel, poivre' }, { pieceWeightG: null })).toEqual({
      grams: 1,
      unit: 'pincee',
      estimated: true,
    })
  })

  it('compte une piece pour un ingredient sans quantite qui n’est pas un assaisonnement', () => {
    expect(importAmount({ quantity: null, unit: null, name: 'Échalote' }, { pieceWeightG: 30 })).toEqual({
      grams: 30,
      unit: '_piece',
      estimated: true,
    })
  })

  it('donne un ordre de grandeur aux mots de portion', () => {
    // Sans lui : 15 feuilles de persil a cent grammes la piece, 1,5 kg.
    const persil = parseIngredientLine('15 feuilles Persil')
    expect(persil.portion).toBe('feuille')
    expect(importAmount(persil, { pieceWeightG: null })).toEqual({ grams: 7.5, unit: 'g', estimated: true })
    const ail = parseIngredientLine("2 gousses d'ail")
    expect(ail.portion).toBe('gousse')
    // Le mot de portion passe avant le poids d'une piece : une "piece" d'ail
    // dans la bibliotheque est souvent la tete entiere.
    expect(importAmount(ail, { pieceWeightG: 50 })).toEqual({ grams: 10, unit: 'g', estimated: true })
  })

  it('dose un assaisonnement compte en pincees', () => {
    expect(importAmount(parseIngredientLine('1 Sel poivre'), { pieceWeightG: null })).toEqual({
      grams: 1,
      unit: 'pincee',
      estimated: true,
    })
  })

  it('lit un nombre nu en grammes pour un aliment qu’on ne compte pas', () => {
    // "20 Beurre" : le site a oublie l'unite, pas vingt plaquettes.
    expect(importAmount(parseIngredientLine('20 Beurre'), { pieceWeightG: null, categoryL1: 'matières grasses' })).toEqual({
      grams: 20,
      unit: 'g',
      estimated: true,
    })
    // Le beurre du catalogue n'a pas de rayon : il ne se compte pas pour autant.
    expect(importAmount(parseIngredientLine('20 Beurre'), { pieceWeightG: null, categoryL1: null }).grams).toBe(20)
    // Mais 12 oeufs restent douze pieces.
    expect(importAmount(parseIngredientLine('12 oeufs'), { pieceWeightG: null, categoryL1: 'viandes, oeufs, poissons et assimilés' })).toEqual({
      grams: 12 * PIECE_SUPPOSEE_G,
      unit: 'g',
      estimated: true,
    })
    // Et au-dela de cinquante, n'importe quel aliment se lit en grammes.
    expect(importAmount(parseIngredientLine('200 farine'), { pieceWeightG: null, categoryL1: 'fruits' }).grams).toBe(200)
  })
})

describe('extractJsonLdBlocks et parseRecipeJsonLd', () => {
  const page = (json: unknown, extra = '') => `<html><head>
    <script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script type='application/ld+json'>${JSON.stringify(json)}</script>${extra}
    </head><body><script>var x = 1</script></body></html>`

  it('trouve les blocs, et eux seuls', () => {
    const blocs = extractJsonLdBlocks(page({ a: 1 }))
    expect(blocs).toHaveLength(2)
    expect(blocs[1]).toBe('{"a":1}')
  })

  it('lit une recette complete', () => {
    const recette = parseRecipeJsonLd(
      extractJsonLdBlocks(
        page({
          '@context': 'https://schema.org',
          '@type': 'Recipe',
          name: 'Gratin de courgettes',
          recipeYield: '4 personnes',
          prepTime: 'PT15M',
          cookTime: 'PT45M',
          image: ['https://exemple.fr/gratin.jpg'],
          recipeIngredient: ['3 courgettes', "20 cl de cr&egrave;me", "1 c. à soupe d&#039;huile"],
          recipeInstructions: [
            { '@type': 'HowToStep', text: 'Laver les courgettes.' },
            { '@type': 'HowToStep', text: '<p>Enfourner 45&nbsp;min.</p>' },
          ],
        }),
      ),
    )
    expect(recette).toEqual({
      name: 'Gratin de courgettes',
      ingredients: ['3 courgettes', '20 cl de crème', "1 c. à soupe d'huile"],
      steps: ['Laver les courgettes.', 'Enfourner 45 min.'],
      portions: 4,
      prepTimeMin: 60,
      imageUrl: 'https://exemple.fr/gratin.jpg',
    })
  })

  it('traverse un @graph et un @type en liste', () => {
    const recette = parseRecipeJsonLd([
      JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, { '@type': ['Recipe', 'NewsArticle'], name: 'Soupe' }] }),
    ])
    expect(recette?.name).toBe('Soupe')
  })

  it('saute un bloc illisible sans renoncer aux suivants', () => {
    expect(parseRecipeJsonLd(['{ pas du json', JSON.stringify({ '@type': 'Recipe', name: 'Tarte' })])?.name).toBe('Tarte')
  })

  it('fait des sections des intertitres', () => {
    const recette = parseRecipeJsonLd([
      JSON.stringify({
        '@type': 'Recipe',
        name: 'Tarte',
        recipeInstructions: [
          { '@type': 'HowToSection', name: 'Pour la pâte', itemListElement: [{ '@type': 'HowToStep', text: 'Mélanger.' }] },
          { '@type': 'HowToSection', name: 'Garniture :', itemListElement: [{ '@type': 'HowToStep', text: 'Étaler.' }] },
        ],
      }),
    ])
    expect(recette?.steps).toEqual(['Pour la pâte :', 'Mélanger.', 'Garniture :', 'Étaler.'])
  })

  it('accepte des instructions en un seul texte, et une image objet', () => {
    const recette = parseRecipeJsonLd([
      JSON.stringify({
        '@type': 'Recipe',
        name: 'Riz',
        recipeYield: 2,
        totalTime: 'PT1H30M',
        image: { '@type': 'ImageObject', url: '/img/riz.jpg' },
        recipeInstructions: 'Rincer le riz.\nCuire 12 min.',
      }),
    ])
    expect(recette).toMatchObject({ portions: 2, prepTimeMin: 90, imageUrl: '/img/riz.jpg', steps: ['Rincer le riz.', 'Cuire 12 min.'] })
  })

  it('rend null sans recette', () => {
    expect(parseRecipeJsonLd([JSON.stringify({ '@type': 'Organization' })])).toBeNull()
    expect(parseRecipeJsonLd([])).toBeNull()
  })

  it('borne les portions entre 1 et 50', () => {
    expect(parseRecipeJsonLd([JSON.stringify({ '@type': 'Recipe', name: 'x', recipeYield: '120 biscuits' })])?.portions).toBe(50)
    expect(parseRecipeJsonLd([JSON.stringify({ '@type': 'Recipe', name: 'x' })])?.portions).toBe(1)
  })
})

describe('extractOgImage', () => {
  it('trouve l’image de partage, quel que soit l’ordre des attributs', () => {
    expect(extractOgImage('<meta property="og:image" content="https://exemple.fr/grande.jpg">')).toBe('https://exemple.fr/grande.jpg')
    expect(extractOgImage("<meta content='https://exemple.fr/a.jpg?w=1200&amp;h=630' property='og:image' />")).toBe(
      'https://exemple.fr/a.jpg?w=1200&h=630',
    )
    expect(extractOgImage('<meta name="og:image:secure_url" content="https://exemple.fr/b.jpg">')).toBe('https://exemple.fr/b.jpg')
  })

  it('rend null sans image de partage', () => {
    expect(extractOgImage('<meta property="og:title" content="Tarte">')).toBeNull()
  })
})

describe('dureeEnMinutes et texteBrut', () => {
  it('lit les durees ISO 8601', () => {
    expect(dureeEnMinutes('PT15M')).toBe(15)
    expect(dureeEnMinutes('PT1H30M')).toBe(90)
    expect(dureeEnMinutes('P0DT0H20M')).toBe(20)
    expect(dureeEnMinutes('PT0M')).toBeNull()
    expect(dureeEnMinutes('quinze minutes')).toBeNull()
  })

  it('decode les entites et retire les balises', () => {
    expect(texteBrut('l&#039;huile &amp; le <b>sel</b>')).toBe("l'huile & le sel")
    expect(texteBrut('cr&egrave;me&nbsp;fra&icirc;che')).toBe('crème fraîche')
  })
})

describe('searchTerms et matchScore', () => {
  it('garde l’aliment, au singulier, sans les mots vides ni la preparation', () => {
    expect(searchTerms('tomates cerises')).toEqual(['tomate', 'cerise'])
    expect(searchTerms("huile d'olive")).toEqual(['huile', 'olive'])
    expect(searchTerms('gros oignon, émincé')).toEqual(['oignon'])
    expect(searchTerms('Œufs frais')).toEqual(['oeuf'])
    expect(searchTerms('beurre (mou)')).toEqual(['beurre'])
  })

  it('classe la fiche exacte devant la fiche approchante', () => {
    const termes = searchTerms('tomates cerises')
    const exacte = matchScore('Tomate cerise, crue', termes)
    const approchante = matchScore('Tomate, crue', termes)
    expect(exacte).toBeGreaterThan(approchante)
    expect(exacte).toBeGreaterThanOrEqual(SEUIL_SUR)
    expect(approchante).toBeGreaterThanOrEqual(SEUIL_RETENU)
    expect(approchante).toBeLessThan(SEUIL_SUR)
  })

  it('prefere une fiche crue et courte a egalite', () => {
    const termes = searchTerms('oignon')
    expect(matchScore('Oignon, cru', termes)).toBeGreaterThan(matchScore('Oignon, cuit', termes))
    expect(matchScore('Oignon, cru', termes)).toBeGreaterThan(matchScore('Oignon rouge, cru', termes))
  })

  it('ne rapproche pas deux mots qui ne different que par la fin', () => {
    // "lait" ne doit pas trouver "laitue", ni "mort" "mortadelle".
    expect(matchScore('Laitue, crue', searchTerms('lait'))).toBeLessThan(SEUIL_RETENU)
    expect(matchScore('Mortadelle', searchTerms('trompettes de la mort'))).toBeLessThan(SEUIL_RETENU)
  })

  it('ne compte pas les qualificatifs techniques comme des mots de trop', () => {
    const termes = searchTerms('beurre')
    expect(matchScore('Beurre à 80% MG minimum, doux', termes)).toBeGreaterThan(matchScore('Beurre à 80% MG, salé', termes))
  })

  it('prend le sens par defaut d’un mot seul', () => {
    expect(matchScore('Lait demi-écrémé, UHT', searchTerms('lait'))).toBeGreaterThan(matchScore('Lait entier, UHT', searchTerms('lait')))
    expect(matchScore('Sel blanc alimentaire, non iodé, non fluoré', searchTerms('sel'))).toBeGreaterThan(
      matchScore('Sel au céleri', searchTerms('sel')),
    )
    expect(matchScore('Farine de blé tendre ou froment T55', searchTerms('farine'))).toBeGreaterThan(
      matchScore("Farine d'orge", searchTerms('farine')),
    )
  })

  it('ne prete pas le sens par defaut d’un aliment a un autre', () => {
    // Ligne "sel poivre" : le "blanc" attendu du sel ne doit pas servir au poivre.
    const termes = searchTerms('Sel poivre')
    expect(matchScore('Sel blanc alimentaire, non iodé, non fluoré', termes)).toBeGreaterThan(
      matchScore('Poivre blanc, poudre', termes),
    )
  })

  it('retient une fiche qui range l’aliment apres son morceau', () => {
    expect(matchScore('Dinde, escalope crue', searchTerms('Escalope de dinde'))).toBeGreaterThanOrEqual(SEUIL_SUR)
  })

  it('demande plutot que de prendre un sucre pour un autre', () => {
    // CIQUAL n'a pas de sucre glace : "Sucre roux" ne doit pas passer pour lui.
    expect(matchScore('Sucre roux', searchTerms('sucre glace'))).toBeLessThan(SEUIL_RETENU)
  })

  it('cherche sans les mots de portion, et traduit un nom commercial', () => {
    expect(searchTerms("gousse d'ail")).toEqual(['ail'])
    expect(searchTerms('pointe de colorant rouge')).toEqual(['colorant', 'rouge'])
    expect(searchTerms('maïzena')).toEqual(['amidon', 'mai'])
  })

  it('lit les marques de pluriel des sites sans couper le nom', () => {
    expect(parseIngredientLine('600 g Escalope(s) de dinde').name).toBe('Escalope de dinde')
    expect(parseIngredientLine('2 gousse(s) Ail')).toEqual({ quantity: 2, unit: null, name: 'gousse Ail', portion: 'gousse' })
  })

  it('ne retient pas une fiche sans rapport', () => {
    expect(matchScore('Lait demi-écrémé', searchTerms('huile d’olive'))).toBeLessThan(SEUIL_RETENU)
  })
})
