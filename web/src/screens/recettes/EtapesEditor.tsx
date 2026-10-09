/**
 * Les etapes d'une recette, saisies une par une.
 *
 * ELLES RESTENT UNE SEULE CHAINE EN BASE. `recipe.instructions` ne change pas
 * de type : les etapes sont ses blocs, separes par une ligne vide a
 * l'enregistrement et redecoupes par `splitSteps` a l'ouverture. Aucune
 * migration, et aucune recette existante a ressaisir.
 *
 * IL ECRIT AVEC UNE LIGNE VIDE, TOUJOURS. Un simple retour a la ligne serait
 * ambigu : les textes importes sont enveloppes a quatre-vingts caracteres, et
 * leurs retours ne separent rien du tout. En ecrivant une ligne vide entre les
 * blocs, l'editeur produit un texte que `splitSteps` redecoupe a l'identique,
 * quel que soit le contenu.
 *
 * ENTREE CREE UNE ETAPE, elle n'insere pas de retour a la ligne. C'est le geste
 * qu'on attend d'une liste, et cela garantit qu'aucune etape ne contient de
 * retour qui la couperait en deux au rechargement. Maj+Entree reste libre pour
 * qui en veut vraiment un.
 *
 * LES INTERTITRES SE SAISISSENT COMME LES ETAPES. Une ligne finissant par deux
 * points (« Pour la sauce : ») est rendue comme un titre a la lecture, sans
 * numero, et ne decale pas la numerotation. Rien a cocher : on l'ecrit.
 */

import { useMemo } from 'react'
import { splitSteps, stepRanks } from '@prandia/shared'

import { TextArea } from '../../components/Field.js'
import { Icon } from '../../icons/index.js'

/** Le separateur ecrit entre deux etapes. Une ligne vide, jamais un simple saut. */
const SEPARATEUR = '\n\n'

export function EtapesEditor({
  instructions,
  onChange,
}: {
  readonly instructions: string
  readonly onChange: (instructions: string) => void
}) {
  /*
   * LE MEME DECOUPAGE QUE LA LECTURE, par la meme fonction. Un decoupage
   * maison ici afficherait des champs que la fiche ne montrerait pas, ou
   * l'inverse. Une recette sans instruction ouvre sur un champ vide plutot que
   * sur rien.
   */
  const etapes = useMemo(() => {
    const blocs = splitSteps(instructions)
    return blocs.length === 0 ? [''] : blocs
  }, [instructions])

  /** Les rangs tels que la fiche les affichera, intertitres non numerotes. */
  const rangs = useMemo(() => stepRanks(etapes), [etapes])

  /** Ecrit la liste telle quelle, champs vides compris : la saisie en cours. */
  const ecrire = (suivantes: string[]) => onChange(suivantes.join(SEPARATEUR))

  /** Ecrit en retirant les champs vides. Pour les gestes qui finissent une action. */
  const ranger = (suivantes: string[]) => {
    const gardees = suivantes.map((s) => s.trim()).filter((s) => s !== '')
    onChange(gardees.join(SEPARATEUR))
  }

  const changer = (i: number, valeur: string) =>
    ecrire(etapes.map((s, k) => (k === i ? valeur : s)))

  const inserer = (apres: number) => {
    const suivantes = [...etapes]
    suivantes.splice(apres + 1, 0, '')
    ecrire(suivantes)
  }

  const retirer = (i: number) => ranger(etapes.filter((_, k) => k !== i))

  const deplacer = (i: number, sens: -1 | 1) => {
    const j = i + sens
    if (j < 0 || j >= etapes.length) return
    const suivantes = [...etapes]
    const a = suivantes[i] as string
    suivantes[i] = suivantes[j] as string
    suivantes[j] = a
    ecrire(suivantes)
  }

  return (
    <div className="etapes-editor">
      <p className="field__label">Étapes</p>

      <ol className="etapes-editor__liste">
        {etapes.map((etape, i) => {
          const rang = rangs[i] ?? null
          const intertitre = etape.trim() !== '' && rang === null
          return (
            <li key={i} className="etape-champ">
              <span
                className={`etape-champ__rang${intertitre ? ' etape-champ__rang--titre' : ''}`}
                aria-hidden="true"
              >
                {rang ?? '§'}
              </span>

              <div className="etape-champ__corps">
                <TextArea
                  label={`Étape ${i + 1}`}
                  className="field--sans-libelle"
                  value={etape}
                  onChange={(v) => changer(i, v)}
                  placeholder={i === 0 ? 'Rince les lentilles à l’eau froide…' : 'Étape suivante…'}
                  minRows={2}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      inserer(i)
                    }
                  }}
                />

                {/* Les outils SOUS le champ, et non a sa droite. En colonne de
                    droite ils prenaient cent dix pixels sur un telephone : le
                    texte tombait a quatre mots par ligne, et une etape
                    ordinaire s'etalait sur cinq lignes. */}
                <div className="etape-champ__outils">
                  <button
                    type="button"
                    className="etape-champ__outil"
                    onClick={() => deplacer(i, -1)}
                    disabled={i === 0}
                    aria-label={`Monter l’étape ${i + 1}`}
                  >
                    <Icon name="ui-chevron-up" size={16} />
                  </button>
                  <button
                    type="button"
                    className="etape-champ__outil"
                    onClick={() => deplacer(i, 1)}
                    disabled={i === etapes.length - 1}
                    aria-label={`Descendre l’étape ${i + 1}`}
                  >
                    <Icon name="ui-chevron-down" size={16} />
                  </button>
                  <button
                    type="button"
                    className="etape-champ__outil etape-champ__outil--retirer"
                    onClick={() => retirer(i)}
                    disabled={etapes.length === 1 && etape === ''}
                    aria-label={`Retirer l’étape ${i + 1}`}
                  >
                    <Icon name="ui-trash" size={16} />
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ol>

      <button
        type="button"
        className="button button--secondary"
        onClick={() => inserer(etapes.length - 1)}
      >
        <Icon name="ui-plus" size={16} className="icon--inline" /> Ajouter une étape
      </button>

      <p className="field__hint">
        Entrée crée l’étape suivante. Une ligne qui se termine par deux points, comme «&nbsp;Pour
        la sauce&nbsp;:&nbsp;», devient un intertitre : elle ne prend pas de numéro et ne décale
        pas les étapes suivantes.
      </p>
    </div>
  )
}
