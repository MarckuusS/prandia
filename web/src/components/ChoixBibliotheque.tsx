/**
 * Choisir dans la bibliotheque entiere, en tuiles.
 *
 * Deux usages. L'ajout d'un repas au planning (recettes ET ingredients, filtres
 * par la meme recherche : "oeuf" ramene la recette de tartinable et les oeufs)
 * et l'editeur de recette (ingredients seuls). Il remplace des choix qui se
 * faisaient a l'etroit : un menu deroulant natif, sans photo ni calories, et
 * une liste de suggestions coincee entre le champ et le clavier.
 *
 * LA RECHERCHE EST EN HAUT, et collante. En bas, elle aurait du remonter
 * au-dessus du clavier, ce qu'iOS ne fait pas pour un element fixe d'une
 * application installee : sans pouvoir le verifier sur l'appareil, on ne parie
 * pas dessus.
 *
 * PAS DE MISE AU POINT A L'OUVERTURE : le clavier masquerait la moitie des
 * tuiles, alors que parcourir est justement ce que cet ecran apporte.
 *
 * DOUBLON INTERDIT : un ingredient deja present (`ingredientsPris`) garde sa
 * tuile, pour qu'on voie qu'il est la, mais marquee et inerte. La disparaitre
 * ferait chercher un ingredient qu'on croit absent de la bibliotheque.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatGrams, photoPath, type Ingredient } from '@prandia/shared'

import { Icon, RayonIcon } from '../icons/index.js'
import { useIngredients, useRecipes, type RecipeSummary } from '../lib/queries.js'
import { useRayonStyle } from '../lib/useRayonStyle.js'
import '../styles/choix.css'

type Filtre = 'tout' | 'recettes' | 'ingredients'

const FILTRES: ReadonlyArray<{ readonly cle: Filtre; readonly label: string }> = [
  { cle: 'tout', label: 'Tout' },
  { cle: 'recettes', label: 'Recettes' },
  { cle: 'ingredients', label: 'Ingrédients' },
]

export interface ChoixBibliothequeProps {
  /** Absent : seuls les ingredients sont proposes (editeur de recette). */
  readonly onRecette?: ((recette: RecipeSummary) => void) | undefined
  readonly onIngredient: (ingredient: Ingredient) => void
  /** Ingredients deja presents : marques "Deja ajoute" et impossibles a rechoisir. */
  readonly ingredientsPris?: ReadonlySet<number> | undefined
}

export function ChoixBibliotheque({ onRecette, onIngredient, ingredientsPris }: ChoixBibliothequeProps) {
  const avecRecettes = onRecette !== undefined
  const [texte, setTexte] = useState('')
  const [differe, setDiffere] = useState('')
  const [filtre, setFiltre] = useState<Filtre>(avecRecettes ? 'tout' : 'ingredients')

  // 200 ms, comme partout ailleurs : sans ce delai, chaque lettre part en
  // requete reseau.
  useEffect(() => {
    const t = setTimeout(() => setDiffere(texte.trim()), 200)
    return () => clearTimeout(t)
  }, [texte])

  const recettes = useRecipes(differe)
  const ingredients = useIngredients(differe)

  const listeRecettes = avecRecettes ? (recettes.data?.items ?? []) : []
  const listeIngredients = useMemo(
    () => (ingredients.data?.items ?? []).filter((item) => item.id !== null),
    [ingredients.data],
  )

  const voirRecettes = avecRecettes && filtre !== 'ingredients'
  const voirIngredients = filtre !== 'recettes'
  const libelle = avecRecettes ? 'Rechercher une recette ou un ingrédient' : 'Rechercher un ingrédient'

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
            placeholder={libelle}
            aria-label={libelle}
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

        {avecRecettes && (
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
        )}
      </div>

      {voirRecettes && onRecette && (
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
            <TuileIngredient
              key={ingredient.id}
              ingredient={ingredient}
              pris={ingredient.id !== null && (ingredientsPris?.has(ingredient.id) ?? false)}
              onChoisir={onIngredient}
            />
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
  pris,
  onChoisir,
}: {
  readonly ingredient: Ingredient
  readonly pris: boolean
  readonly onChoisir: (ingredient: Ingredient) => void
}) {
  const styleOf = useRayonStyle()
  const rayon = styleOf(ingredient.categoryL1)

  return (
    <li>
      <button
        type="button"
        className={`tuile${pris ? ' tuile--pris' : ''}`}
        onClick={() => onChoisir(ingredient)}
        // `disabled` et non un simple style : un tap ne doit RIEN faire, et le
        // lecteur d'ecran doit annoncer la tuile comme indisponible.
        disabled={pris}
        aria-label={pris ? `${ingredient.name}, déjà ajouté` : undefined}
      >
        <span className="tuile__visuel tuile__visuel--pastille" {...rayon.tint} aria-hidden="true">
          <RayonIcon glyph={rayon.glyph} size={34} strokeWidth={1.5} />
          {pris && (
            <span className="tuile__pris">
              <Icon name="ui-check" size={14} strokeWidth={2} /> Déjà ajouté
            </span>
          )}
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
