import { describe, expect, it } from 'vitest'

import {
  cueSegments,
  extractDurations,
  isHeading,
  parseSteps,
  splitSentences,
  splitSteps,
  stepParts,
  stepRanks,
} from './steps.js'

describe('parseSteps', () => {
  it('numerote une etape par ligne', () => {
    const s = parseSteps('Rince les lentilles.\nEmince l’oignon.\nMijote a couvert.')
    expect(s.map((e) => e.index)).toEqual([1, 2, 3])
    expect(s[0]?.text).toBe('Rince les lentilles.')
  })

  it('avale les lignes vides et les retours Windows', () => {
    // Un texte colle depuis un site en porte, et une ligne finissant par \r se
    // verrait a l'ecran.
    const s = parseSteps('Un.\r\n\r\n\r\nDeux.\r\n')
    expect(s).toHaveLength(2)
    expect(s[1]?.text).toBe('Deux.')
  })

  it('retire une numerotation deja tapee a la main', () => {
    // Sans cela, l'ecran afficherait « 2. 2) Ajoute les lentilles ».
    const s = parseSteps('1. Rince.\n2) Emince.\n3 - Mijote.\nÉtape 4 : Sers.')
    expect(s.map((e) => e.text)).toEqual(['Rince.', 'Emince.', 'Mijote.', 'Sers.'])
    expect(s.map((e) => e.index)).toEqual([1, 2, 3, 4])
  })

  it('renumerote juste meme quand la main a saute un chiffre', () => {
    const s = parseSteps('1. Un.\n3. Deux.\n7. Trois.')
    expect(s.map((e) => e.index)).toEqual([1, 2, 3])
  })

  it('ne confond pas une quantite avec un numero d’etape', () => {
    // « 2 cuillères » commence par un chiffre mais n'est pas une numerotation :
    // le motif exige un separateur, pas un espace seul.
    const s = parseSteps('2 cuillères de curry, puis remuer.')
    expect(s[0]?.text).toBe('2 cuillères de curry, puis remuer.')
  })

  it('traite un intertitre comme un titre, sans numero ni decalage', () => {
    const s = parseSteps('Pour la sauce :\nMelange le yaourt.\nPour le plat :\nCuis le riz.')
    expect(s.map((e) => [e.index, e.heading])).toEqual([
      [null, true],
      [1, false],
      [null, true],
      [2, false],
    ])
  })

  it('ne prend pas une longue phrase finissant par deux-points pour un titre', () => {
    const longue =
      'Melange le tout dans un saladier en veillant a ne pas ecraser les morceaux, puis reserve au frais :'
    const s = parseSteps(longue)
    expect(s[0]?.heading).toBe(false)
    expect(s[0]?.index).toBe(1)
  })

  it('rend une seule etape sur un paragraphe unique, et c’est le bon comportement', () => {
    const s = parseSteps('Fais tout cuire ensemble pendant vingt minutes puis sers.')
    expect(s).toHaveLength(1)
    expect(s[0]?.index).toBe(1)
  })

  it('rend une liste vide sur des instructions vides', () => {
    expect(parseSteps('')).toEqual([])
    expect(parseSteps('   \n\n  ')).toEqual([])
  })
})

describe('extractDurations', () => {
  it('lit les durees dont l’unite est ECRITE', () => {
    expect(extractDurations('Mijote 15 min a couvert.')).toEqual([15])
    expect(extractDurations('Laisse reposer 2 h.')).toEqual([120])
    expect(extractDurations('Cuire 45 minutes.')).toEqual([45])
    expect(extractDurations('Attendre 30mn.')).toEqual([30])
  })

  it('ignore un nombre sans unite de temps', () => {
    // C'est tout l'objet du module : le nombre serait facile a prendre, sa
    // NATURE est ce qu'on inventerait.
    expect(extractDurations('Prechauffe le four a 180 °C.')).toEqual([])
    expect(extractDurations('Ajoute 10 cl de creme.')).toEqual([])
    expect(extractDurations('Casse 4 oeufs.')).toEqual([])
  })

  it('rend TOUTES les durees d’une etape, jamais une seule', () => {
    // « Fais revenir 3 min puis laisse reposer 30 min » n'a pas de duree
    // principale : en choisir une reviendrait a choisir pour le lecteur.
    expect(extractDurations('Fais revenir 3 min puis laisse reposer 30 min.')).toEqual([3, 30])
  })

  it('ne retient pas une duree nulle', () => {
    expect(extractDurations('0 min')).toEqual([])
  })
})

describe('stepRanks', () => {
  it('aligne un rang par ligne brute, sans rien filtrer', () => {
    // Le point du separer de `parseSteps` : l'editeur a un champ par ligne, y
    // compris vide, et doit poser le bon numero en face du bon champ.
    expect(stepRanks(['Un.', 'Deux.', 'Trois.'])).toEqual([1, 2, 3])
  })

  it('numerote une ligne dont le numero est deja tape a la main', () => {
    // Le defaut qui a motive cette fonction : « 4) Ajuste le sel » etait
    // indexee sans son « 4) » et passait pour un intertitre.
    expect(stepRanks(['Un.', '4) Ajuste le sel, un trait de citron.'])).toEqual([1, 2])
  })

  it('ne numerote ni les intertitres ni les lignes vides', () => {
    expect(stepRanks(['Pour la sauce :', 'Melange.', '', 'Pour le plat :', 'Cuis.'])).toEqual([
      null, 1, null, null, 2,
    ])
  })

  it('donne le meme rang que parseSteps sur un texte sans ligne vide', () => {
    const texte = 'Un.\nPour la sauce :\n2) Deux.\nTrois.'
    const parLignes = stepRanks(texte.split('\n'))
    expect(parseSteps(texte).map((e) => e.index)).toEqual(parLignes)
  })
})

describe('isHeading', () => {
  it('reconnait une ligne de section', () => {
    expect(isHeading('Pour la sauce :')).toBe(true)
    expect(isHeading('  Pour le plat:  ')).toBe(true)
  })

  it('refuse une phrase longue qui finit par deux-points', () => {
    expect(
      isHeading(
        'Melange le tout dans un saladier en veillant a ne pas ecraser les morceaux, puis reserve :',
      ),
    ).toBe(false)
  })

  it('refuse une instruction ordinaire', () => {
    expect(isHeading('Rince les lentilles.')).toBe(false)
  })
})

describe('splitSteps, sur des donnees reelles', () => {
  /*
   * Le texte qui a revele le defaut : une recette importee, enveloppee a
   * quatre-vingts caracteres, paragraphes separes par une ligne vide. Le
   * decoupage par ligne en faisait six etapes dont quatre commencaient au
   * milieu d'une phrase.
   */
  const IMPORTEE = [
    'Pour 4 personnes - environ 50 minutes.',
    '',
    '1. Preparation. Emincer l’oignon, ecraser les gousses d’ail, couper le poivron en',
    'petits des. Concasser les tomates pelees a la fourchette dans leur jus. Ecraser',
    'les graines de cumin au mortier (ou utiliser le dos d’une casserole sur une',
    'planche).',
    '',
    '2. Suer les legumes. Faire chauffer l’huile d’olive dans une cocotte.',
  ].join('\n')

  it('recolle un paragraphe enveloppe en UNE etape', () => {
    const blocs = splitSteps(IMPORTEE)
    expect(blocs).toHaveLength(3)
    expect(blocs[1]).toContain('couper le poivron en petits des')
    expect(blocs[1]).toContain('sur une planche).')
  })

  it('numerote ces trois blocs et rien de plus', () => {
    const s = parseSteps(IMPORTEE)
    expect(s.map((e) => e.index)).toEqual([1, 2, 3])
    // La numerotation tapee a la main est retiree, comme partout.
    expect(s[1]?.text.startsWith('Preparation.')).toBe(true)
  })

  it('retombe sur une etape par ligne quand le texte n’a AUCUNE ligne vide', () => {
    // C'est ce qu'on tape pour enumerer des gestes courts, et le format que
    // l'editeur ecrivait avant ce correctif.
    expect(splitSteps('Un.\nDeux.\nTrois.')).toEqual(['Un.', 'Deux.', 'Trois.'])
  })

  it('avale les lignes vides multiples et les retours Windows', () => {
    expect(splitSteps('Un.\r\n\r\n\r\n\r\nDeux.\r\n')).toEqual(['Un.', 'Deux.'])
  })

  it('avale une ligne qui ne contient que des espaces', () => {
    // Un « paragraphe » separe par une ligne d'espaces est le cas courant d'un
    // copier-coller depuis un traitement de texte.
    expect(splitSteps('Un.\n   \nDeux.')).toEqual(['Un.', 'Deux.'])
  })

  it('rend une liste vide sur du vide', () => {
    expect(splitSteps('')).toEqual([])
    expect(splitSteps('  \n\n  ')).toEqual([])
  })
})

/** Une etape telle que HelloFresh la publie, puces recollees par l'import. */
const HELLOFRESH =
  'Faites chauffer une poêle à feu moyen-vif. Faites-y dorer les lardons, l’oignon et les cuisses de poulet (côté peau vers le bas) à sec 4-5 min. Disposez les cuisses de poulet dans une plaque de cuisson. Enfournez-les 28-35 min, ou jusqu’à ce qu’elles soient cuites à cœur.'

describe('splitSentences', () => {
  it('rend une phrase par geste', () => {
    expect(splitSentences(HELLOFRESH)).toEqual([
      'Faites chauffer une poêle à feu moyen-vif.',
      'Faites-y dorer les lardons, l’oignon et les cuisses de poulet (côté peau vers le bas) à sec 4-5 min.',
      'Disposez les cuisses de poulet dans une plaque de cuisson.',
      'Enfournez-les 28-35 min, ou jusqu’à ce qu’elles soient cuites à cœur.',
    ])
  })

  it('ne coupe pas apres une abreviation de recette', () => {
    // Ni "c. à s.", ni "env.", ni "th." ne sont suivies d'une capitale.
    expect(splitSentences('Ajoutez 1 c. à s. de sel et env. 5 cl d’eau, th. 6.')).toHaveLength(1)
  })

  it('ne coupe pas un nombre decimal', () => {
    expect(splitSentences('Versez 1.5 L de bouillon.')).toEqual(['Versez 1.5 L de bouillon.'])
  })

  it('coupe apres un point d’exclamation precede d’une espace, et une majuscule accentuee', () => {
    expect(splitSentences('Goûtez ! Égouttez. Réservez.')).toEqual(['Goûtez !', 'Égouttez.', 'Réservez.'])
  })

  it('garde une parenthese fermante avec sa phrase', () => {
    expect(splitSentences('Salez (sans excès.) Poivrez.')).toEqual(['Salez (sans excès.)', 'Poivrez.'])
  })

  it('rend le texte exact une fois recolle', () => {
    expect(splitSentences(HELLOFRESH).join(' ')).toBe(HELLOFRESH)
  })
})

describe('stepParts', () => {
  it('rend les gestes, sans astuce', () => {
    expect(stepParts(HELLOFRESH)).toEqual({ gestures: splitSentences(HELLOFRESH), tip: null })
  })

  it('met a part l’astuce du site, sans son etiquette, jusqu’a la fin de l’etape', () => {
    const p = stepParts(
      'Faites dorer les nuggets 3-4 min. L’ASTUCE DU CHEF : Vous ne voulez pas d’ustensile de plus ? Enfournez-les avec les potatoes.',
    )
    expect(p.gestures).toEqual(['Faites dorer les nuggets 3-4 min.'])
    expect(p.tip).toBe('Vous ne voulez pas d’ustensile de plus ? Enfournez-les avec les potatoes.')
  })

  it('reconnait les etiquettes courantes', () => {
    expect(stepParts('Servez. Astuce : ajoutez du persil.').tip).toBe('ajoutez du persil.')
    expect(stepParts('Servez. Conseil du chef : servez chaud.').tip).toBe('servez chaud.')
    expect(stepParts('Servez. Bon à savoir : se congèle.').tip).toBe('se congèle.')
  })

  it('exige le deux-points : un mot en tete de phrase ne suffit pas', () => {
    expect(stepParts('Servez. Astucieux, ce plat se réchauffe.').tip).toBeNull()
    expect(stepParts('Servez. Conseil de saison, prenez des tomates mûres.').tip).toBeNull()
  })

  it('rend une astuce nulle quand l’etiquette est seule', () => {
    expect(stepParts('Servez. Astuce :')).toEqual({ gestures: ['Servez.'], tip: null })
  })
})

describe('cueSegments', () => {
  const reperes = (texte: string) => cueSegments(texte).filter((m) => m.cue).map((m) => m.text)

  it('fait ressortir durees et fourchettes', () => {
    expect(reperes(HELLOFRESH)).toEqual(['4-5 min', '28-35 min'])
    expect(reperes('Laissez reposer 1 h 30, puis 2 heures au frais.')).toEqual(['1 h 30', '2 heures'])
    expect(reperes('Mixez 45 secondes puis 3 à 4 minutes.')).toEqual(['45 secondes', '3 à 4 minutes'])
    expect(reperes(`Cuire 15${String.fromCharCode(0x2013)}20 min.`)).toEqual([`15${String.fromCharCode(0x2013)}20 min`])
  })

  it('fait ressortir temperatures et thermostat', () => {
    expect(reperes('Préchauffez le four à 220°C (200 °C chaleur tournante).')).toEqual(['220°C', '200 °C'])
    expect(reperes('Enfournez th. 6.')).toEqual(['th. 6'])
  })

  it('laisse en texte un nombre sans unite de temps ni de chaleur', () => {
    // La regle de `extractDurations` : l'unite doit etre ECRITE.
    expect(reperes('Ajoutez 10 cl de crème, 4 œufs et 1 cm de gingembre.')).toEqual([])
    expect(reperes('Coupez 3 mini-poivrons et 2 hampes.')).toEqual([])
  })

  it('rend le texte exact une fois recolle', () => {
    const texte = 'Préchauffez à 180 °C, puis enfournez 25-30 min.'
    expect(cueSegments(texte).map((m) => m.text).join('')).toBe(texte)
    expect(cueSegments('')).toEqual([])
  })
})
