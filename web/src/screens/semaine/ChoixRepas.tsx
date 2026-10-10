/**
 * Choisir ce qu'on mange : la bibliotheque entiere, en tuiles.
 *
 * Remplace deux choix qui se faisaient a l'etroit. Pour une recette, un menu
 * deroulant natif : la roue d'iOS, sans photo ni calories. Pour un ingredient,
 * une liste de suggestions coincee entre le champ et le clavier. Ici tout est
 * visible d'emblee sur deux colonnes, et la recherche filtre les deux a la
 * fois : "oeuf" ramene la recette de tartinable ET les oeufs.
 *
 * LA RECHERCHE EST EN HAUT, et collante. En bas, elle aurait du remonter
 * au-dessus du clavier, ce qu'iOS ne fait pas pour un element fixe d'une
 * application installee : sans pouvoir le verifier sur l'appareil, on ne parie
 * pas dessus.
 *
 * PAS DE MISE AU POINT A L'OUVERTURE : le clavier masquerait la moitie des
 * tuiles, alors que parcourir est justement ce que cet ecran apporte.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatGrams, photoPath, type Ingredient } from '@prandia/shared'

import { Icon, RayonIcon } from '../../icons/index.js'
import { useIngredients, useRecipes, type RecipeSummary } from '../../lib/queries.js'
import { useRayonStyle } from '../../lib/useRayonStyle.js'

type Filtre = 'tout' | 'recettes' | 'ingredients'

const FILTRES: ReadonlyArray<{ readonly cle: Filtre; readonly label: string }> = [
  { cle: 'tout', label: 'Tout' },
  { cle: 'recettes', label: 'Recettes' },
  { cle: 'ingredients', label: 'Ingrédients' },
]

export interface ChoixRepasProps {
  readonly onRecette: (recette: RecipeSummary) => void
  readonly onIngredient: (ingredient: Ingredient) => void
}

export function ChoixRepas({ onRecette, onIngredient }: ChoixRepasProps) {
  const [texte, setTexte] = useState('')
  const [differe, setDiffere] = useState('')
  const [filtre, setFiltre] = useState<Filtre>('tout')

  // 200 ms, comme partout ailleurs : sans ce delai, chaque lettre part en
  // requete reseau.
  useEffect(() => {
    const t = setTimeout(() => setDiffere(texte.trim()), 200)
    return () => clearTimeout(t)
  }, [texte])

  const recettes = useRecipes(differe)
  const ingredients = useIngredients(differe)

  const listeRecettes = recettes.data?.items ?? []
  const listeIngredients = useMemo(
    () => (ingredients.data?.items ?? []).filter((item) => item.id !== null),
    [ingredients.data],
  )

  const voirRecettes = filtre !== 'ingredients'
  const voirIngredients = filtre !== 'recettes'

  return (
    <div className="choix">
      <div className="choix__haut">
        <label className="choix__recherche">
          <Icon name="ui-search" size={18} className="choix__loupe" />
          <input
            type="search"
            className="choix__champ"
            value={texte}
            onChange={(event) => setTexte(event.target.value)}
            placeholder="Rechercher une recette ou un ingrédient"
            aria-label="Rechercher une recette ou un ingrédient"
            autoComplete="off"
            autoCorrect="off"
            enterKeyHint="search"
          />
          {texte !== '' && (
            <button
              type="button"
              className="choix__effacer"
              onClick={() => setTexte('')}
              aria-label="Effacer la recherche"
            >
              <Icon name="ui-close" size={16} />
            </button>
          )}
        </label>

        <div className="segmented" role="group" aria-label="Afficher">
          {FILTRES.map(({ cle, label }) => (
            <button
              key={cle}
              type="button"
              className={`segmented__tab${filtre === cle ? ' segmented__tab--active' : ''}`}
              aria-pressed={filtre === cle}
              onClick={() => setFiltre(cle)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {voirRecettes && (
        <Section
          titre="Recettes"
          nombre={listeRecettes.length}
          chargement={recettes.isPending}
          erreur={recettes.isError ? recettes.error.message : null}
          vide={differe ? 'Aucune recette ne correspond.' : 'Aucune recette enregistrée pour l’instant.'}
        >
          {listeRecettes.map((recette) => (
            <TuileRecette key={recette.id} recette={recette} onChoisir={onRecette} />
          ))}
        </Section>
      )}

      {voirIngredients && (
        <Section
          titre="Ingrédients"
          nombre={listeIngredients.length}
          chargement={ingredients.isPending}
          erreur={ingredients.isError ? ingredients.error.message : null}
          vide={differe ? 'Aucun ingrédient de ta bibliothèque ne correspond.' : 'Ta bibliothèque est vide.'}
        >
          {listeIngredients.map((ingredient) => (
            <TuileIngredient key={ingredient.id} ingredient={ingredient} onChoisir={onIngredient} />
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({
  titre,
  nombre,
  chargement,
  erreur,
  vide,
  children,
}: {
  readonly titre: string
  readonly nombre: number
  readonly chargement: boolean
  readonly erreur: string | null
  readonly vide: string
  readonly children: ReactNode
}) {
  return (
    <section className="choix__section" aria-label={titre}>
      <h3 className="choix__titre">
        {titre}
        {!chargement && erreur === null && <span className="choix__nombre">{nombre}</span>}
      </h3>
      {erreur !== null ? (
        <p className="text-error" role="alert">
          {erreur}
        </p>
      ) : chargement ? (
        <p className="choix__etat">Chargement…</p>
      ) : nombre === 0 ? (
        <p className="choix__etat">{vide}</p>
      ) : (
        <ul className="choix__grille">{children}</ul>
      )}
    </section>
  )
}

function TuileRecette({
  recette,
  onChoisir,
}: {
  readonly recette: RecipeSummary
  readonly onChoisir: (recette: RecipeSummary) => void
}) {
  const [echecPhoto, setEchecPhoto] = useState(false)
  const kcalPortion = recette.nutrition.kcal / Math.max(recette.defaultPortions, 1)

  return (
    <li>
      <button type="button" className="tuile" onClick={() => onChoisir(recette)}>
        {/* Meme regle que le repertoire : la pastille est l'aspect normal d'une
            recette sans photo, et le repli sur erreur ramene la meme pastille
            plutot que le carre casse du navigateur. */}
        {recette.imageKey === null || echecPhoto ? (
          <span className="tuile__visuel tuile__visuel--pastille" data-rayon="autre" aria-hidden="true">
            <Icon name="ui-utensils" size={30} strokeWidth={1.5} />
          </span>
        ) : (
          <img
            className="tuile__visuel tuile__photo"
            src={photoPath(recette.id, recette.imageKey, 'thumb')}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setEchecPhoto(true)}
          />
        )}
        <span className="tuile__nom">{recette.name}</span>
        <span className="tuile__meta">
          {kcalPortion > 0 ? `${Math.round(kcalPortion)} kcal / portion` : 'Sans ingrédient'}
          {recette.prepTimeMin !== null && ` · ${recette.prepTimeMin} min`}
        </span>
      </button>
    </li>
  )
}

function TuileIngredient({
  ingredient,
  onChoisir,
}: {
  readonly ingredient: Ingredient
  readonly onChoisir: (ingredient: Ingredient) => void
}) {
  const styleOf = useRayonStyle()
  const rayon = styleOf(ingredient.categoryL1)

  return (
    <li>
      <button type="button" className="tuile" onClick={() => onChoisir(ingredient)}>
        <span className="tuile__visuel tuile__visuel--pastille" {...rayon.tint} aria-hidden="true">
          <RayonIcon glyph={rayon.glyph} size={34} strokeWidth={1.5} />
        </span>
        <span className="tuile__nom">{ingredient.name}</span>
        <span className="tuile__meta">
          {ingredient.kcal !== null ? `${Math.round(ingredient.kcal)} kcal / 100 g` : 'Calories inconnues'}
        </span>
        {ingredient.pieceWeightG !== null && (
          <span className="tuile__meta tuile__piece">1 pièce = {formatGrams(ingredient.pieceWeightG)}</span>
        )}
      </button>
    </li>
  )
}
