/**
 * Le repertoire de recettes.
 *
 * Ce n'est pas un livre de cuisine, c'est la matiere premiere du planning :
 * chaque carte est un raccourci vers un repas de la semaine. D'ou des filtres
 * qui servent la decision (proteines, rapide, batch, vege) plutot que des
 * categories de magazine, et un bandeau qui croise le repertoire avec le frigo.
 *
 * ---------------------------------------------------------------------------
 * DEUX NATURES DE FILTRE, ET C'EST LE PIEGE
 * ---------------------------------------------------------------------------
 * « Batch » et « Végé » sont des TAGS enregistres. « Riches en protéines » et
 * « Rapides » se CALCULENT. Les quatre se dessinent pareil, mais le parametre
 * d'URL ne pouvait porter qu'un identifiant de tag : `?tag=3`. Un second
 * parametre `?f=` porte donc les filtres calcules, ce qui garde les deux
 * lisibles dans l'adresse et partageables.
 *
 * « Rapides » lit `prepTimeMin`, jamais le tag `rapide` : une mesure vaut
 * mieux qu'une declaration. Consequence assumee, et tranchee explicitement :
 * une recette dont le temps n'est pas saisi ne parait pas dans ce filtre.
 *
 * « Riches en protéines » se juge en PART DE L'ENERGIE, pas en grammes par
 * portion. Un plat de 1 200 kcal a 60 g de proteines n'est pas riche en
 * proteines, il est gros ; le rapporter a l'energie traite les portions de
 * toutes tailles de la meme facon.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  SEASONING_MAX_G,
  energyBreakdown,
  feasibility,
  pantryTotals,
  photoPath,
  type NutritionTotal,
} from '@prandia/shared'

import { MacroBar } from '../../components/MacrosDonut.js'
import { EmptyState, ErrorState, LoadingRows } from '../../components/States.js'
import { Icon } from '../../icons/index.js'
import { usePantry, useRecipes, useTags, type RecipeSummary } from '../../lib/queries.js'
import { NewRecipeSheet } from '../RecipesScreen.js'
import '../../styles/repertoire.css'

/** Part de l'energie en proteines a partir de laquelle on parle de « riche ». */
const SEUIL_PROTEINES = 25

/** Duree, en minutes, sous laquelle une recette est dite rapide. */
const SEUIL_RAPIDE = 20

/** Les deux filtres qui se calculent, par opposition aux tags enregistres. */
const CALCULES = [
  { cle: 'proteines', label: 'Riches en protéines' },
  { cle: 'rapides', label: 'Rapides' },
] as const

type FiltreCalcule = (typeof CALCULES)[number]['cle']

/** Les tags a mettre en avant, dans cet ordre. Les autres restent accessibles. */
const TAGS_EN_AVANT = ['batch-cooking', 'végétarien']

const partProteines = (n: NutritionTotal): number => {
  const e = energyBreakdown(n)
  return e.atwaterKcal <= 0 ? 0 : (e.proteinsKcal / e.atwaterKcal) * 100
}

export function Repertoire() {
  const [params, setParams] = useSearchParams()
  const tagParam = params.get('tag')
  const tagId = tagParam !== null && /^\d+$/.test(tagParam) ? Number(tagParam) : null
  const calcule = (params.get('f') ?? null) as FiltreCalcule | null
  const frigoSeul = params.get('frigo') === '1'

  const [nouvelle, setNouvelle] = useState(false)
  const [texte, setTexte] = useState(() => params.get('q') ?? '')
  const [differe, setDiffere] = useState(() => params.get('q') ?? '')

  // 200 ms, comme partout ailleurs : sans ce delai, chaque lettre part en
  // requete reseau.
  useEffect(() => {
    const t = setTimeout(() => setDiffere(texte.trim()), 200)
    return () => clearTimeout(t)
  }, [texte])

  useEffect(() => {
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (differe) n.set('q', differe)
        else n.delete('q')
        return n
      },
      // `replace` : sans cela chaque lettre ajouterait une entree d'historique
      // et le bouton retour deviendrait inutilisable.
      { replace: true },
    )
  }, [differe, setParams])

  const poser = (cles: Record<string, string | null>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        for (const [k, v] of Object.entries(cles)) {
          if (v === null) n.delete(k)
          else n.set(k, v)
        }
        return n
      },
      { replace: true },
    )

  const liste = useRecipes(differe, tagId)
  const tags = useTags()
  const frigo = usePantry()

  const stock = useMemo(
    () => (frigo.data === undefined ? null : pantryTotals(frigo.data.items)),
    [frigo.data],
  )

  /** La faisabilite de chaque recette, calculee une fois pour toutes. */
  const faisables = useMemo(() => {
    if (stock === null || liste.data === undefined) return null
    const m = new Map<number, boolean>()
    for (const r of liste.data.items) {
      // `feasibility` attend des lignes completes ; la liste n'en transporte
      // que l'essentiel, d'ou cette forme reduite. Le calcul, lui, est le
      // meme que sur la fiche.
      const lignes = r.lines.map((l) => ({
        ingredient: { id: l.ingredientId } as never,
        quantityG: l.quantityG,
      }))
      m.set(r.id, feasibility({ lines: lignes as never, defaultPortions: r.defaultPortions }, stock).feasible)
    }
    return m
  }, [stock, liste.data])

  const visibles = useMemo(() => {
    let items = liste.data?.items ?? []
    if (calcule === 'proteines') items = items.filter((r) => partProteines(r.nutrition) >= SEUIL_PROTEINES)
    if (calcule === 'rapides') {
      items = items.filter((r) => r.prepTimeMin !== null && r.prepTimeMin <= SEUIL_RAPIDE)
    }
    if (frigoSeul && faisables !== null) items = items.filter((r) => faisables.get(r.id) === true)

    /*
     * TRI PAR USAGE REEL, et non par ordre alphabetique : on ouvre ce
     * repertoire pour remplir une semaine, et ce qu'on cuisine souvent est ce
     * qu'on recuisinera. Les ex aequo retombent sur le nom, sinon l'ordre
     * changerait a chaque rendu.
     */
    return [...items].sort(
      (a, b) => b.cookCount30d - a.cookCount30d || a.name.localeCompare(b.name, 'fr'),
    )
  }, [liste.data, calcule, frigoSeul, faisables])

  const nbFaisables = faisables === null ? null : [...faisables.values()].filter(Boolean).length
  const filtre = differe !== '' || tagId !== null || calcule !== null || frigoSeul

  const tagsAffiches = (tags.data?.items ?? [])
    .filter((t) => TAGS_EN_AVANT.includes(t.name) || t.id === tagId)
    .sort((a, b) => TAGS_EN_AVANT.indexOf(a.name) - TAGS_EN_AVANT.indexOf(b.name))

  return (
    <section className="screen screen--repertoire">
      <header className="repertoire-entete">
        <div>
          <p className="repertoire-entete__surtitre">
            {liste.data === undefined
              ? ' '
              : `${liste.data.items.length} recette${liste.data.items.length > 1 ? 's' : ''} · triées par les plus cuisinées`}
          </p>
          <h2>Mes recettes</h2>
        </div>
        <button
          type="button"
          className="repertoire-plus"
          onClick={() => setNouvelle(true)}
          aria-label="Nouvelle recette"
        >
          <Icon name="ui-plus" size={20} />
        </button>
      </header>

      <input
        type="search"
        className="search-field"
        placeholder="Rechercher une recette, un ingrédient…"
        value={texte}
        onChange={(e) => setTexte(e.target.value)}
        enterKeyHint="search"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Rechercher une recette ou un ingrédient"
      />

      <div className="filtres" role="group" aria-label="Filtrer les recettes">
        <button
          type="button"
          className={`filtre${!filtre || (tagId === null && calcule === null && !frigoSeul) ? ' filtre--on' : ''}`}
          aria-pressed={tagId === null && calcule === null && !frigoSeul}
          onClick={() => poser({ tag: null, f: null, frigo: null })}
        >
          Toutes
        </button>
        {CALCULES.map((c) => (
          <button
            key={c.cle}
            type="button"
            className={`filtre${calcule === c.cle ? ' filtre--on' : ''}`}
            aria-pressed={calcule === c.cle}
            onClick={() => poser({ f: calcule === c.cle ? null : c.cle, tag: null, frigo: null })}
          >
            {c.label}
          </button>
        ))}
        {tagsAffiches.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`filtre${tagId === t.id ? ' filtre--on' : ''}`}
            aria-pressed={tagId === t.id}
            onClick={() => poser({ tag: tagId === t.id ? null : String(t.id), f: null, frigo: null })}
          >
            {t.name}
          </button>
        ))}
      </div>

      {/* Le bandeau ne parait que s'il a quelque chose a annoncer : « 0 recette
          faisable » repete chaque jour n'apprend rien et occupe une carte. */}
      {nbFaisables !== null && nbFaisables > 0 && !frigoSeul && (
        <button type="button" className="bandeau-frigo" onClick={() => poser({ frigo: '1', tag: null, f: null })}>
          <Icon name="ui-fridge" size={20} className="bandeau-frigo__icone" />
          <span>
            <b>
              {nbFaisables} recette{nbFaisables > 1 ? 's' : ''} faisable{nbFaisables > 1 ? 's' : ''}
            </b>{' '}
            avec ton frigo. Les lignes de moins de {SEASONING_MAX_G} g sont supposées présentes.
          </span>
          <span className="bandeau-frigo__lien">Voir</span>
        </button>
      )}

      {liste.isPending && <LoadingRows />}
      {liste.isError && <ErrorState error={liste.error} onRetry={() => void liste.refetch()} />}

      {liste.isSuccess && visibles.length === 0 && (
        <EmptyState title={filtre ? 'Aucun résultat' : 'Aucune recette'}>
          {filtre ? (
            <>
              Rien ne correspond à ce filtre.{' '}
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setTexte('')
                  poser({ tag: null, f: null, frigo: null })
                }}
              >
                Tout afficher
              </button>
            </>
          ) : (
            'Ta bibliothèque de recettes est vide. Crée la première avec le bouton en haut.'
          )}
        </EmptyState>
      )}

      {visibles.length > 0 && (
        <ul className="recettes">
          {visibles.map((r) => (
            <CarteRecette key={r.id} recette={r} faisable={faisables?.get(r.id) ?? null} />
          ))}
        </ul>
      )}

      <NewRecipeSheet open={nouvelle} onClose={() => setNouvelle(false)} />
    </section>
  )
}

function CarteRecette({
  recette,
  faisable,
}: {
  readonly recette: RecipeSummary
  readonly faisable: boolean | null
}) {
  const [echecPhoto, setEchecPhoto] = useState(false)

  const parPortion = useMemo<NutritionTotal>(() => {
    const p = Math.max(recette.defaultPortions, 1)
    const n = recette.nutrition
    return {
      kcal: n.kcal / p,
      proteins: n.proteins / p,
      carbs: n.carbs / p,
      sugars: n.sugars / p,
      fats: n.fats / p,
      saturatedFats: n.saturatedFats / p,
      fiber: n.fiber / p,
      salt: n.salt / p,
    }
  }, [recette])

  return (
    <li className="recette">
      <Link to={`/recettes/${recette.id}`} className="recette__lien lien-surface">
        {/* LA PASTILLE N'EST PAS UN SUPPLEANT D'IMAGE MANQUANTE, c'est
            l'aspect normal d'une recette sans photo, et la plupart n'en auront
            jamais. Les couverts et non une teinte de macro : un rond framboise
            pose au hasard apprendrait que ces couleurs ne veulent rien dire,
            juste au-dessus d'une tri-barre ou elles veulent dire quelque chose.

            Le repli sur erreur ramene la meme pastille, et c'est voulu : une
            cle peut designer un objet absent, et une session expiree rend un
            401. Dans les deux cas un <img> affiche le carre casse du
            navigateur, et l'utilisateur croit avoir perdu sa photo. */}
        {recette.imageKey === null || echecPhoto ? (
          <span className="icon-chip" data-rayon="autre">
            <Icon name="ui-utensils" size={22} strokeWidth={1.8} />
          </span>
        ) : (
          <img
            className="recette__photo"
            src={photoPath(recette.id, recette.imageKey, 'thumb')}
            /* `alt` vide : le nom de la recette est juste a cote. "Photo de
               Gratin de courgettes" n'apprendrait rien a un lecteur d'ecran et
               allongerait chacune des trente lignes. */
            alt=""
            width={54}
            height={54}
            loading="lazy"
            decoding="async"
            onError={() => setEchecPhoto(true)}
          />
        )}

        <span className="recette__corps">
          <span className="recette__nom">
            {recette.name}
            {faisable === true && <span className="badge-frigo">Frigo OK</span>}
          </span>
          <span className="recette__meta">
            {recette.prepTimeMin !== null && <span>{recette.prepTimeMin} min</span>}
            {parPortion.kcal > 0 && <span>{Math.round(parPortion.kcal)} kcal / portion</span>}
            {/* La FENETRE est dite : « 14 fois » se lit comme une habitude
                installee, « 14 fois ces 30 jours » comme ce que c'est. */}
            {recette.cookCount30d > 0 && <span>cuisinée {recette.cookCount30d}× ces 30 j</span>}
          </span>
          <MacroBar total={parPortion} />
        </span>

        <span className="recette__chevron" aria-hidden="true">
          <Icon name="ui-chevron-right" size={18} />
        </span>
      </Link>
    </li>
  )
}
