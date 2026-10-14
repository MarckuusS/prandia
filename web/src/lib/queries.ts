/**
 * Acces aux donnees de l'API, via TanStack Query.
 *
 * Un principe tenu partout ici : apres une ecriture, on invalide les listes
 * qui en DEPENDENT, pas seulement celle qu'on vient de modifier. Changer une
 * recette change la liste de courses ; vider un jour change le cout de la
 * semaine. Le desktop avait le meme probleme et le reglait par des signaux
 * Qt — ici c'est `invalidateQueries`.
 *
 * Les routes qui renvoient l'etat complet apres ecriture (calendrier, frigo)
 * alimentent directement le cache : sur un reseau de magasin, economiser un
 * aller-retour se voit a l'oeil nu.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import {
  currentIsoWeek,
  type ArticleLu,
  type PreparationWrite,
  type Ingredient,
  type MealPlanEntry,
  type NutritionTotal,
  type PantryStock,
  type PantryMovementReason,
  type PantryStockWrite,
  type StorageSpace,
  type Recipe,
  type RecipeWrite,
  type SessionItem,
  type ShoppingSession,
  type ShoppingList,
  formatCriteria,
  type Completion,
  type Criterion,
  type RecettePourIA,
  type ScanKind,
  type ScanResult,
  type TicketReading,
  type WeighIn,
} from '@prandia/shared'

import { ApiError, apiFetch } from './api.js'
import { queryClient } from './clientRequetes.js'

// ---------------------------------------------------------------------------
// Cles et invalidation
// ---------------------------------------------------------------------------

export const keys = {
  ingredients: (q: string) => ['ingredients', q] as const,
  ingredient: (id: number | null) => ['ingredient', id] as const,
  catalog: (q: string, source: string | null, category: string | null) =>
    ['catalog', q, source, category] as const,
  categories: ['categories'] as const,
  prices: (id: number) => ['prices', id] as const,
  recipes: (q: string, tagId: number | null) => ['recipes', q, tagId] as const,
  recipe: (id: number | null) => ['recipe', id] as const,
  cooking: (id: number) => ['cooking', id] as const,
  tags: ['tags'] as const,
  rayons: ['rayons'] as const,
  customIcons: ['custom-icons'] as const,
  profile: ['profile'] as const,
  hydration: (day: string) => ['hydration', day] as const,
  weight: ['weight'] as const,
  calendar: (week: string) => ['calendar', week] as const,
  templates: ['templates'] as const,
  pantry: ['pantry'] as const,
  shopping: (week: string) => ['shopping', week] as const,
  shoppingHistory: ['shopping-history'] as const,
  activity: ['activity'] as const,
  session: ['shopping-session'] as const,
}

/**
 * Ce que touche indirectement une ecriture.
 *
 * La liste de courses derive du calendrier, des recettes, des ingredients ET
 * du frigo : elle est invalidee par a peu pres tout. Le journal d'activite
 * aussi, puisque chaque ecriture y laisse une ligne.
 */
function invalidateDerived(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: ['shopping'] })
  void client.invalidateQueries({ queryKey: keys.activity })
}

const post = <T,>(path: string, body: unknown): Promise<T> =>
  apiFetch<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * Un envoi multipart.
 *
 * AUCUN `content-type` N'EST POSE, et c'est le point : le navigateur est le
 * seul a connaitre la frontiere multipart qu'il vient de fabriquer, et
 * l'ecrire a la main produit un corps que le serveur ne sait pas decouper. On
 * contourne donc `post`, qui pose du JSON, mais PAS `apiFetch`, qui n'impose
 * rien sur le corps et garde la gestion d'erreur commune.
 */
const postForm = <T,>(path: string, body: FormData): Promise<T> =>
  apiFetch<T>(path, { method: 'POST', body })

/**
 * `ifMatch` transporte le `updatedAt` lu au chargement, pour une ecriture
 * conditionnelle : le serveur refuse en 409 si la ressource a bouge entre-temps.
 * Omis, l'ecriture reste inconditionnelle, conformement a la semantique HTTP.
 */
const put = <T,>(path: string, body: unknown, ifMatch?: string | null): Promise<T> =>
  apiFetch<T>(path, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(ifMatch ? { 'if-match': ifMatch } : {}),
    },
    body: JSON.stringify(body),
  })

const patch = <T,>(path: string, body: unknown): Promise<T> =>
  apiFetch<T>(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const del = <T,>(path: string): Promise<T> => apiFetch<T>(path, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Ingredients
// ---------------------------------------------------------------------------

export interface IngredientList {
  readonly items: Ingredient[]
  readonly totalCount: number
}

export function useIngredients(query: string) {
  return useQuery({
    queryKey: keys.ingredients(query),
    queryFn: () =>
      apiFetch<IngredientList>(`/api/ingredients${query ? `?q=${encodeURIComponent(query)}` : ''}`),
    // Garde la liste precedente affichee pendant la frappe, au lieu de
    // repasser par un squelette a chaque lettre.
    placeholderData: (previous) => previous,
  })
}

export function useIngredient(id: number | null) {
  return useQuery({
    queryKey: keys.ingredient(id),
    queryFn: () => apiFetch<Ingredient>(`/api/ingredients/${id}`),
    enabled: id !== null,
  })
}

export function useCreateIngredient() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (payload: Partial<Ingredient> & { name: string }) =>
      post<Ingredient>('/api/ingredients', payload),
    onSuccess: (created) => {
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      void client.invalidateQueries({ queryKey: ['catalog'] })
      client.setQueryData(keys.ingredient(created.id), created)
      invalidateDerived(client)
    },
  })
}

export function useUpdateIngredient() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Ingredient> & { id: number }) =>
      patch<Ingredient>(`/api/ingredients/${id}`, body),
    onSuccess: (updated) => {
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      client.setQueryData(keys.ingredient(updated.id), updated)
      // Les macros et le prix d'un ingredient traversent recettes, semaine et
      // courses : tout ce qui l'affiche doit repartir de la base.
      void client.invalidateQueries({ queryKey: ['recipe'] })
      void client.invalidateQueries({ queryKey: ['calendar'] })
      void client.invalidateQueries({ queryKey: keys.pantry })
      invalidateDerived(client)
    },
  })
}

export interface DeleteIngredientResult {
  readonly removed: 'library' | 'permanent'
  readonly id?: number
  readonly ingredient?: Ingredient
}

export function useDeleteIngredient() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => del<DeleteIngredientResult>(`/api/ingredients/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      void client.invalidateQueries({ queryKey: ['catalog'] })
      invalidateDerived(client)
    },
  })
}

// ------------------------------------------------------------------ catalogue

export interface CatalogPage extends IngredientList {
  readonly limit: number
  readonly offset: number
}

/**
 * Le catalogue, page par page.
 *
 * `useInfiniteQuery` et non une limite qui grandit : demander 10, puis 20,
 * puis 30 retelechargerait a chaque fois ce qu'on a deja. Ici chaque page est
 * une requete de dix lignes, et les pages s'empilent.
 *
 * Les bornes partent au SERVEUR. Filtrer les dix lignes recues cote client
 * dirait « aucun resultat » alors que le onzieme convenait.
 */
export function useCatalog(
  query: string,
  options: {
    source?: string | null
    category?: string | null
    criteria?: readonly Criterion[]
    enabled?: boolean
    pageSize?: number
  } = {},
) {
  const { source = null, category = null, criteria = [], enabled = true, pageSize = 10 } = options
  const bornes = formatCriteria(criteria)

  return useInfiniteQuery({
    queryKey: [...keys.catalog(query, source, category), bornes, pageSize],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams()
      if (query) search.set('q', query)
      if (source) search.set('source', source)
      if (category) search.set('category', category)
      if (bornes) search.set('bornes', bornes)
      search.set('limit', String(pageSize))
      search.set('offset', String(pageParam))
      return apiFetch<CatalogPage>(`/api/catalog?${search.toString()}`)
    },
    initialPageParam: 0,
    // `undefined` arrete la pagination : c'est ce que lit `hasNextPage`.
    getNextPageParam: (last: CatalogPage, pages: CatalogPage[]) => {
      const charges = pages.reduce((n, p) => n + p.items.length, 0)
      return charges < last.totalCount ? charges : undefined
    },
    // Sans requete ni filtre, le catalogue rendrait ses 4 000 premieres lignes
    // par ordre alphabetique — inexploitable et couteux sur un telephone.
    enabled:
      enabled && (query.trim().length > 0 || source !== null || category !== null || bornes !== ''),
    placeholderData: (previous) => previous,
  })
}

export const useCategories = () =>
  useQuery({
    queryKey: keys.categories,
    queryFn: () => apiFetch<{ items: Array<{ l1: string; count: number }> }>('/api/categories'),
  })

export function useAddToLibrary() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => put<Ingredient>(`/api/ingredients/${id}/library`, {}),
    onSuccess: (ingredient) => {
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      void client.invalidateQueries({ queryKey: ['catalog'] })
      client.setQueryData(keys.ingredient(ingredient.id), ingredient)
      void client.invalidateQueries({ queryKey: keys.activity })
    },
  })
}

/**
 * Recherche OpenFoodFacts, relayee par le Worker (CORS + User-Agent).
 *
 * Paginee comme le catalogue, mais pour une raison de plus : OpenFoodFacts
 * limite le debit des clients anonymes. Charger dix resultats a la demande
 * plutot que cinquante d'office menage la source autant que le forfait.
 */
export function useOffSearch(
  query: string,
  enabled: boolean,
  criteria: readonly Criterion[] = [],
  pageSize = 10,
) {
  const bornes = formatCriteria(criteria)

  return useInfiniteQuery({
    queryKey: ['off-search', query, bornes, pageSize],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({
        q: query,
        page: String(pageParam),
        limit: String(pageSize),
      })
      if (bornes) search.set('bornes', bornes)
      return apiFetch<OffSearchPage>(`/api/off/search?${search.toString()}`)
    },
    initialPageParam: 1,
    getNextPageParam: (last: OffSearchPage, pages: OffSearchPage[]) => {
      const charges = pages.reduce((n, p) => n + p.items.length, 0)
      // Une page vide arrete tout : OpenFoodFacts annonce parfois un total
      // superieur a ce qu'il sait reellement rendre.
      if (last.items.length === 0) return undefined
      return charges < last.totalCount ? pages.length + 1 : undefined
    },
    // Pas de debounce ici : OpenFoodFacts limite les clients anonymes, la
    // recherche est declenchee par un bouton explicite.
    enabled: enabled && query.trim().length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

export interface OffSearchPage extends IngredientList {
  readonly page: number
  readonly limit: number
}

export type BarcodeResult = Ingredient & {
  /** Vrai quand la fiche existait deja en base : c'est ELLE qui est rendue. */
  readonly alreadyKnown?: boolean
}

export const lookupBarcode = (ean: string): Promise<BarcodeResult> =>
  apiFetch(`/api/off/barcode/${encodeURIComponent(ean)}`)

/**
 * Produit derriere un code-barres.
 *
 * Passe par `/api/off/barcode/:ean` et non par la recherche texte : le point
 * d'acces produit d'OpenFoodFacts repond sur le code exact, la recherche
 * plein-texte peut rendre autre chose ou rien. En magasin, viser juste compte
 * plus que ratisser large.
 *
 * Le resultat est garde 30 minutes : rescanner le meme produit — ce qui arrive
 * quand on hesite devant un rayon — ne doit pas repartir sur le reseau.
 */
export function useBarcode(ean: string | null) {
  return useQuery({
    queryKey: ['barcode', ean],
    queryFn: () => lookupBarcode(ean ?? ''),
    enabled: ean !== null && ean.length >= 8,
    staleTime: 30 * 60 * 1000,
    // Un code inconnu d'OpenFoodFacts rend 404. Reessayer trois fois ne le
    // fera pas apparaitre, et fait patienter pour rien devant le rayon.
    retry: false,
  })
}

// ------------------------------------------------------------------ prix

export interface PriceEntry {
  readonly id: number
  readonly ingredientId: number
  readonly priceEur: string
  readonly quantityG: number
  readonly store: string | null
  readonly recordedAt: string
  readonly notes: string | null
  readonly createdAt: string
}

export function usePriceHistory(ingredientId: number | null) {
  return useQuery({
    queryKey: keys.prices(ingredientId ?? 0),
    queryFn: () => apiFetch<{ items: PriceEntry[] }>(`/api/ingredients/${ingredientId}/prices`),
    enabled: ingredientId !== null,
  })
}

/**
 * Prix constate pour un code-barres, d'apres Open Prices.
 *
 * Une INDICATION, jamais une verite : les releves viennent de contributeurs,
 * d'enseignes et de periodes differentes. L'interface doit montrer l'etendue
 * et le nombre de releves a cote du montant, sans quoi elle presenterait une
 * mediane comme un prix officiel.
 */
export interface ObservedPrice {
  readonly ean: string
  readonly found: boolean
  readonly priceEur?: string
  readonly minEur?: string
  readonly maxEur?: string
  readonly sampleCount: number
  readonly totalCount?: number
  /** Contenance du produit, quand Open Prices la connait. */
  readonly quantityG?: number | null
  readonly lastSeen?: string | null
}

export function useObservedPrice(ean: string | null) {
  return useQuery({
    queryKey: ['observed-price', ean],
    queryFn: () => apiFetch<ObservedPrice>(`/api/prices/observed/${ean}`),
    enabled: ean !== null && ean.length >= 8,
    // Les prix bougent lentement : une heure de cache evite de reinterroger
    // en boucle quand on hesite devant un rayon.
    staleTime: 60 * 60 * 1000,
    retry: false,
  })
}

/**
 * Enregistre un prix pour un ingredient connu seulement a l'envoi.
 *
 * `useAddPrice` fige l'identifiant a la creation du hook, ce qui ne convient
 * pas quand l'ingredient vient d'etre CREE dans la meme action — le cas du
 * scan : on ajoute le produit a la bibliotheque, et son identifiant n'existe
 * qu'ensuite. Ici il voyage avec la mutation.
 */
export function useRecordPrice() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      ingredientId,
      ...entry
    }: Omit<PriceEntry, 'id' | 'ingredientId' | 'createdAt'> & { ingredientId: number }) =>
      post<{ items: PriceEntry[]; ingredient: Ingredient }>(
        `/api/ingredients/${ingredientId}/prices`,
        entry,
      ),
    onSuccess: (result, vars) => {
      client.setQueryData(keys.prices(vars.ingredientId), { items: result.items })
      client.setQueryData(keys.ingredient(vars.ingredientId), result.ingredient)
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      invalidateDerived(client)
    },
  })
}

export function useAddPrice(ingredientId: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (entry: Omit<PriceEntry, 'id' | 'ingredientId' | 'createdAt'>) =>
      post<{ items: PriceEntry[]; ingredient: Ingredient }>(`/api/ingredients/${ingredientId}/prices`, entry),
    onSuccess: (result) => {
      client.setQueryData(keys.prices(ingredientId), { items: result.items })
      client.setQueryData(keys.ingredient(ingredientId), result.ingredient)
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      invalidateDerived(client)
    },
  })
}

/**
 * Supprime un releve.
 *
 * L'identifiant de l'ingredient part en parametre pour que le serveur puisse
 * rendre le prix RECALCULE : effacer le releve le plus recent change le prix
 * courant de la fiche, et l'ecran doit le refleter sans relire.
 */
export function useDeletePrice(ingredientId: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      del<{ id: number; items?: PriceEntry[]; ingredient?: Ingredient }>(
        `/api/prices/${id}?ingredient=${ingredientId}`,
      ),
    onSuccess: (result) => {
      if (result.items) client.setQueryData(keys.prices(ingredientId), { items: result.items })
      if (result.ingredient) client.setQueryData(keys.ingredient(ingredientId), result.ingredient)
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      invalidateDerived(client)
    },
  })
}

// ---------------------------------------------------------------------------
// Recettes
// ---------------------------------------------------------------------------

export interface RecipeSummary {
  readonly id: number
  readonly name: string
  readonly defaultPortions: number
  readonly imageKey: string | null
  readonly lineCount: number
  readonly prepTimeMin: number | null
  readonly tags: ReadonlyArray<{ id: number; name: string; colorHex: string }>
  /** Derniere fois que la recette a ete cuisinee, `null` si jamais. */
  readonly lastCookedAt: string | null
  /** Nombre de cuissons sur les 30 derniers jours glissants. */
  readonly cookCount30d: number
  /** Nutrition de la recette entiere, agregee cote Worker. */
  readonly nutrition: NutritionTotal
  /** Les lignes reduites a ce que le croisement avec le frigo demande. */
  readonly lines: ReadonlyArray<{ readonly ingredientId: number; readonly quantityG: number }>
}

export function useRecipes(query = '', tagId: number | null = null) {
  const search = new URLSearchParams()
  if (query) search.set('q', query)
  if (tagId !== null) search.set('tag', String(tagId))

  return useQuery({
    queryKey: keys.recipes(query, tagId),
    queryFn: () =>
      apiFetch<{ items: RecipeSummary[]; totalCount: number }>(
        `/api/recipes${search.toString() ? `?${search.toString()}` : ''}`,
      ),
    placeholderData: (previous) => previous,
  })
}

export function useRecipe(id: number | null) {
  return useQuery({
    queryKey: keys.recipe(id),
    queryFn: () => apiFetch<Recipe>(`/api/recipes/${id}`),
    enabled: id !== null,
  })
}

/**
 * Creation et modification partagent le meme formulaire : un seul hook.
 *
 * `expectedUpdatedAt` est le `updatedAt` de la recette au moment ou l'editeur
 * l'a chargee. Il part en `If-Match` et fait echouer l'enregistrement en 409
 * `stale_recipe` si un autre appareil a enregistre entre-temps, au lieu
 * d'ecraser son travail sans un mot. `null` = enregistrement inconditionnel,
 * ce que l'utilisateur choisit explicitement apres avoir vu le conflit.
 */
export function useSaveRecipe() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      expectedUpdatedAt = null,
      ...body
    }: RecipeWrite & { id: number | null; expectedUpdatedAt?: string | null }) =>
      id === null
        ? post<Recipe>('/api/recipes', body)
        : put<Recipe>(`/api/recipes/${id}`, body, expectedUpdatedAt),
    onSuccess: (recipe) => {
      void client.invalidateQueries({ queryKey: ['recipes'] })
      client.setQueryData(keys.recipe(recipe.id), recipe)
      void client.invalidateQueries({ queryKey: ['calendar'] })
      invalidateDerived(client)
    },
  })
}

/**
 * Deposer ou remplacer la photo de garde.
 *
 * LA REPONSE NE PORTE QUE LA CLE, pas la recette relue : la relire couterait
 * quatre requetes D1 pour un seul champ. On RAPIECE donc le cache au lieu de le
 * remplacer, contrairement a `useSaveRecipe`.
 */
export function useSetRecipePhoto(recipeId: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (parts: { cover: Blob; thumb: Blob }) => {
      const form = new FormData()
      // Les noms de fichier ne servent a rien au serveur, qui ne lit que les
      // octets ; ils evitent qu'un intermediaire nomme la partie "blob".
      form.append('cover', parts.cover, 'cover.jpg')
      form.append('thumb', parts.thumb, 'thumb.jpg')
      return postForm<{ id: number; imageKey: string }>(
        `/api/recipes/${recipeId}/image`,
        form,
      )
    },
    onSuccess: ({ imageKey }) => rafraichirPhoto(client, recipeId, imageKey),
  })
}

// ---------------------------------------------------------------------------
// Importer une recette par lien
// ---------------------------------------------------------------------------

/** Une ligne lue sur le site, et ce que le serveur propose pour elle. */
export interface ImportLine {
  readonly raw: string
  readonly quantity: number | null
  readonly unit: string | null
  readonly name: string
  /** Mot de portion lu ("gousse", "feuille"), pour estimer une masse sans unite. */
  readonly portion: string | null
  /** Du meilleur au moins bon, bibliotheque et catalogue confondus. */
  readonly candidates: readonly Ingredient[]
  /** `null` : rien d'assez proche, la ligne arrive "a choisir". */
  readonly choiceId: number | null
  /** La correspondance est nette ; sinon l'ecran dit "a verifier". */
  readonly sure: boolean
}

export interface ImportProposal {
  readonly recipe: {
    readonly name: string
    readonly portions: number
    readonly prepTimeMin: number | null
    readonly steps: readonly string[]
    readonly imageUrl: string | null
    /** Bloc recette puis image de partage : l'ecran garde la premiere assez grande. */
    readonly imageUrls: readonly string[]
    readonly sourceUrl: string
  }
  readonly lines: readonly ImportLine[]
}

/**
 * Estimer en grammes, par l'IA et d'apres la recette entiere, les quantites
 * que le site ne donne pas en poids ("1/2 sachet", "1/4 de pot"). Rien n'est
 * ecrit : la revue les affiche, encadrees, et la personne les corrige.
 */
export const estimerQuantites = (recette: RecettePourIA) =>
  post<{ readonly estimations: ReadonlyArray<{ readonly index: number; readonly grammes: number }> }>(
    '/api/recipe-import/quantites',
    recette,
  )

/** Lire une page de recette. Rien n'est ecrit : c'est une proposition. */
export const useReadRecipeLink = () =>
  useMutation({ mutationFn: (url: string) => post<ImportProposal>('/api/recipe-import', { url }) })

/**
 * La photo du site, relayee par le serveur : le site interdit au navigateur de
 * la lire lui-meme. Elle repart ensuite par `reduirePhoto`, comme une photo
 * prise au telephone.
 */
/**
 * Faire lire une photo d'etiquette (date, prix, quantite) par le serveur.
 * Rien n'est ecrit : la reponse va dans un champ, que l'utilisateur valide.
 */
export const scanEtiquette = (quoi: ScanKind, image: Blob): Promise<ScanResult> =>
  apiFetch<ScanResult>(`/api/scan?quoi=${quoi}`, {
    method: 'POST',
    headers: { 'content-type': image.type || 'image/jpeg' },
    body: image,
  })

/**
 * Plusieurs photos d'un meme article, lues d'un coup. Mises bout a bout dans
 * un seul corps, leurs tailles dans `x-photos` (worker/src/imageRecue.ts) :
 * pas de multipart, que le serveur ne saurait pas borner.
 */
export const lireArticle = (photos: readonly Blob[]): Promise<ArticleLu> =>
  apiFetch<ArticleLu>('/api/scan/article', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-photos': photos.map((p) => p.size).join(',') },
    body: new Blob([...photos]),
  })

export async function fetchImportPhoto(url: string): Promise<Blob> {
  let reponse: Response
  try {
    reponse = await fetch('/api/recipe-import/photo', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
  } catch {
    throw new ApiError(0, 'network', 'Pas de connexion. Vérifie ton réseau.')
  }
  if (!reponse.ok) throw new ApiError(reponse.status, 'import_photo', 'La photo n’a pas pu être récupérée.')
  return reponse.blob()
}

/** Les adresses des photos d'une page de recette, sans relire tout l'import. */
export const fetchImagesDuSite = (sourceUrl: string) =>
  post<{ readonly imageUrls: readonly string[] }>('/api/recipe-import/images', { url: sourceUrl })

/**
 * Deposer la photo d'une recette qui vient d'etre creee. `useSetRecipePhoto`
 * veut l'identifiant a la creation du hook ; ici il n'existe qu'apres.
 */
export function useUploadRecipePhoto() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ recipeId, cover, thumb }: { recipeId: number; cover: Blob; thumb: Blob }) => {
      const form = new FormData()
      form.append('cover', cover, 'cover.jpg')
      form.append('thumb', thumb, 'thumb.jpg')
      return postForm<{ id: number; imageKey: string }>(`/api/recipes/${recipeId}/image`, form)
    },
    onSuccess: ({ id, imageKey }) => rafraichirPhoto(client, id, imageKey),
  })
}

export function useDeleteRecipePhoto(recipeId: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => del<{ id: number; imageKey: null }>(`/api/recipes/${recipeId}/image`),
    onSuccess: () => rafraichirPhoto(client, recipeId, null),
  })
}

function rafraichirPhoto(
  client: ReturnType<typeof useQueryClient>,
  recipeId: number,
  imageKey: string | null,
): void {
  client.setQueryData(keys.recipe(recipeId), (old?: Recipe) =>
    old === undefined ? old : { ...old, imageKey },
  )
  // La carte du repertoire porte la vignette.
  void client.invalidateQueries({ queryKey: ['recipes'] })
  void client.invalidateQueries({ queryKey: keys.activity })
  /*
   * PAS `invalidateDerived` : une photo ne change ni les quantites, ni les
   * prix, ni la nutrition. Le declencher relancerait la liste de courses et le
   * frigo pour une image.
   */
}

export function useDeleteRecipe() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      del<{ id: number; plannedEntriesRemoved: number }>(`/api/recipes/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['recipes'] })
      // Les repas planifies tombent en cascade cote base.
      void client.invalidateQueries({ queryKey: ['calendar'] })
      invalidateDerived(client)
    },
  })
}

// -------------------------------------------------------- journal de cuisson

export interface CookingEntry {
  readonly id: number
  readonly recipeId: number
  readonly cookedAt: string
  readonly rating: number | null
  readonly notes: string | null
  readonly createdAt: string
}

/** Ce que rend la cuisson d'un plat : de quoi dire ce qui est sorti du frigo. */
export interface PlatCuisine {
  readonly preparationId: number
  readonly ingredientId: number
  readonly sorties: ReadonlyArray<{ readonly name: string; readonly quantityG: number }>
}

/**
 * Cuisiner un plat (shared/src/preparation.ts). Une ecriture qui touche le
 * planning (le repas devient une part), le frigo (ce qui sort, le plat qui
 * entre), les fiches (celle du plat) et le journal de la recette : tout est
 * invalide.
 */
export function useCuisiner() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (plat: PreparationWrite) => post<PlatCuisine>('/api/preparations', plat),
    onSuccess: (_, plat) => {
      void client.invalidateQueries({ queryKey: ['calendar'] })
      void client.invalidateQueries({ queryKey: keys.pantry })
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      if (plat.recipeId !== null) void client.invalidateQueries({ queryKey: keys.cooking(plat.recipeId) })
      invalidateDerived(client)
    },
  })
}

export function useCookingLog(recipeId: number | null) {
  return useQuery({
    queryKey: keys.cooking(recipeId ?? 0),
    queryFn: () => apiFetch<{ items: CookingEntry[] }>(`/api/recipes/${recipeId}/cooking`),
    enabled: recipeId !== null,
  })
}

export function useAddCooking(recipeId: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (entry: { cookedAt: string; rating: number | null; notes: string | null }) =>
      post<{ items: CookingEntry[] }>(`/api/recipes/${recipeId}/cooking`, entry),
    onSuccess: (result) => {
      client.setQueryData(keys.cooking(recipeId), result)
      // Le compteur « ces 30 derniers jours » vit dans la liste des recettes.
      void client.invalidateQueries({ queryKey: ['recipes'] })
      void client.invalidateQueries({ queryKey: keys.activity })
    },
  })
}

export function useDeleteCooking(recipeId: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => del<{ id: number }>(`/api/cooking/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.cooking(recipeId) })
      void client.invalidateQueries({ queryKey: ['recipes'] })
      void client.invalidateQueries({ queryKey: keys.activity })
    },
  })
}

// ------------------------------------------------------------------ tags

export interface TagItem {
  readonly id: number
  readonly name: string
  readonly colorHex: string
  readonly recipeCount: number
}

export const useTags = () =>
  useQuery({ queryKey: keys.tags, queryFn: () => apiFetch<{ items: TagItem[] }>('/api/tags') })

export function useCreateTag() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (tag: { name: string; colorHex: string }) => post<TagItem>('/api/tags', tag),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.tags }),
  })
}

export function useUpdateTag() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...tag }: { id: number; name: string; colorHex: string }) =>
      put<TagItem>(`/api/tags/${id}`, tag),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.tags })
      void client.invalidateQueries({ queryKey: ['recipes'] })
    },
  })
}

export function useDeleteTag() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => del<{ id: number }>(`/api/tags/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.tags })
      void client.invalidateQueries({ queryKey: ['recipes'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Rayons
// ---------------------------------------------------------------------------

export interface RayonItem {
  readonly id: number
  readonly name: string
  /** Nom d'icone, ou `null` : l'aspect est alors deduit du nom du rayon. */
  readonly icon: string | null
  readonly colorHex: string | null
  readonly ordinal: number
  readonly ingredientCount: number
}

export const useRayons = () =>
  useQuery({ queryKey: keys.rayons, queryFn: () => apiFetch<{ items: RayonItem[] }>('/api/rayons') })

export type RayonWrite = Pick<RayonItem, 'name' | 'icon' | 'colorHex' | 'ordinal'>

/**
 * Toute ecriture sur un rayon touche les ingredients.
 *
 * Renommer repercute le nouveau nom sur `ingredient.category_l1`, supprimer
 * l'efface : les listes qui groupent par rayon deviennent fausses tant qu'elles
 * n'ont pas ete relues. On invalide donc large — c'est une action rare, faite
 * depuis un ecran de reglages, jamais dans un geste repete.
 */
const rayonTouches = (client: QueryClient) => {
  void client.invalidateQueries({ queryKey: keys.rayons })
  void client.invalidateQueries({ queryKey: ['ingredients'] })
  void client.invalidateQueries({ queryKey: ['ingredient'] })
  void client.invalidateQueries({ queryKey: keys.categories })
  void client.invalidateQueries({ queryKey: ['shopping'] })
  void client.invalidateQueries({ queryKey: keys.activity })
}

export function useCreateRayon() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (rayon: RayonWrite) => post<RayonItem>('/api/rayons', rayon),
    onSuccess: () => rayonTouches(client),
  })
}

/** Un rayon que Savarin propose, avec les produits de la bibliotheque qui y passeraient. */
export interface RayonPropose {
  readonly nom: string
  readonly raison: string
  readonly produits: ReadonlyArray<{ readonly id: number; readonly nom: string; readonly rayon: string | null }>
}

const CLE_SUGGESTIONS = ['rayons', 'suggestions'] as const

/**
 * Les idees de rayons de Savarin. Le serveur s'en souvient et ne reinterroge
 * Claude que quand la cuisine a change : relire a chaque ouverture ne coute
 * presque rien, mais il n'y a aucune raison de relire au retour sur l'onglet.
 */
export const useRayonsProposes = () =>
  useQuery({
    queryKey: CLE_SUGGESTIONS,
    queryFn: () =>
      apiFetch<{ disponible: boolean; propositions: RayonPropose[] }>('/api/rayons/suggestions'),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  })

export function useCreerRayonPropose() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (choix: { proposition: string; nom: string; produits: number[] }) =>
      post<{ id: number; nom: string; ranges: number }>('/api/rayons/suggestions/creer', choix),
    onSuccess: () => {
      rayonTouches(client)
      void client.invalidateQueries({ queryKey: CLE_SUGGESTIONS })
    },
  })
}

export function useRefuserRayonPropose() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (nom: string) => post<{ nom: string }>('/api/rayons/suggestions/refuser', { nom }),
    onSuccess: () => void client.invalidateQueries({ queryKey: CLE_SUGGESTIONS }),
  })
}

export function useUpdateRayon() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...rayon }: RayonWrite & { id: number }) =>
      put<RayonItem>(`/api/rayons/${id}`, rayon),
    onSuccess: () => rayonTouches(client),
  })
}

/** Les fiches de la bibliotheque que l'IA n'a jamais completees, et si elle est configuree. */
export function useCompletionEtat() {
  return useQuery({
    queryKey: ['completion'],
    queryFn: () => apiFetch<{ restants: number; disponible: boolean }>('/api/completion'),
  })
}

/** Ce qu'un lot de completion a ajoute, et ce qui reste a soumettre. */
export interface BilanCompletion {
  readonly traites: number
  readonly rayons: number
  readonly poidsCuits: number
  readonly saisons: number
  readonly restants: number
}

/**
 * Completer par Claude un lot de fiches de la bibliotheque : rayon, poids cuit,
 * saison, dans les champs vides. Un appel traite un lot ; `restants` dit s'il
 * faut relancer.
 */
export function useCompleterBibliotheque() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => post<BilanCompletion>('/api/completion', {}),
    onSuccess: () => {
      rayonTouches(client)
      void client.invalidateQueries({ queryKey: ['completion'] })
    },
  })
}

/** Ce que l'IA propose pour une fiche ouverte. Rien n'est ecrit. */
export const proposerCompletion = (nom: string, marque: string | null): Promise<Completion> =>
  post<Completion>('/api/completion/proposition', { nom, marque })

export function useDeleteRayon() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => del<{ id: number; movedToNoRayon: number }>(`/api/rayons/${id}`),
    onSuccess: () => rayonTouches(client),
  })
}

// ---------------------------------------------------------------------------
// Icones personnelles
// ---------------------------------------------------------------------------

export interface CustomIconItem {
  readonly id: number
  readonly name: string
  /** Contenu du `<svg>`, deja assaini par le serveur. */
  readonly markup: string
  readonly viewBox: string
  readonly keepColors: boolean
}

export interface ProfileResponse {
  readonly profile: {
    readonly sex: 'f' | 'm' | null
    readonly birthYear: number | null
    readonly heightCm: number | null
    readonly weightKg: number | null
    readonly activity: string | null
    readonly goal: string | null
    /** Repartition des macros. `null` = celle que propose l'objectif. */
    readonly split: string | null
    readonly splitProteins: number | null
    readonly splitCarbs: number | null
    readonly splitFats: number | null
    readonly targetWeightKg: number | null
    readonly paceKgPerWeek: number | null
    readonly kcalTarget: number | null
    /**
     * Tour de taille, en centimetres. Il n'entre dans aucun calcul de cible :
     * il se lit seul, a cote de l'IMC, parce que la balance seule ne dit pas
     * ou sont partis les kilos.
     */
    readonly waistCm: number | null
  }
  /** Propriete du FOYER : les deux membres lisent le meme nombre. */
  readonly eaters: number
}

/** Ce que l'ecran envoie : le profil, plus le reglage du foyer. */
export type ProfilePayload = ProfileResponse['profile'] & { eaters: number }

export const useProfile = () =>
  useQuery({ queryKey: keys.profile, queryFn: () => apiFetch<ProfileResponse>('/api/profile') })

/** Jour LOCAL au format AAAA-MM-JJ. `toISOString()` decalerait la date le soir. */
export function todayIso(now: Date = new Date()): string {
  const mois = String(now.getMonth() + 1).padStart(2, '0')
  const jour = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mois}-${jour}`
}

export interface HydrationDay {
  readonly day: string
  readonly ml: number
}

export const useHydration = (day: string) =>
  useQuery({
    queryKey: keys.hydration(day),
    queryFn: () => apiFetch<HydrationDay>(`/api/hydration?day=${encodeURIComponent(day)}`),
  })

/**
 * Ajoute (ou retranche) des millilitres.
 *
 * ON ENVOIE UN DELTA, pas un total : deux appareils peuvent ajouter un verre
 * dans la meme minute, et le second effacerait le premier. Le serveur additionne
 * et rend le nouveau total, qu'on pose tel quel — inutile de redemander ce
 * qu'on vient d'ecrire.
 */
export function useDrink(day: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (deltaMl: number) => post<HydrationDay>('/api/hydration', { day, deltaMl }),
    onSuccess: (data) => client.setQueryData(keys.hydration(day), data),
  })
}

export interface WeightResponse {
  readonly weighIns: readonly WeighIn[]
}

/**
 * L'historique de pesees.
 *
 * UNE SEULE requete pour toute la serie, et non une par plage d'affichage : le
 * selecteur "4 sem. / 8 sem. / 6 mois / Tout" ne fait que decouper ce qui est
 * deja charge. Deux ans de pesees quotidiennes tiennent en une quinzaine de
 * kilo-octets.
 */
export const useWeightLog = () =>
  useQuery({ queryKey: keys.weight, queryFn: () => apiFetch<WeightResponse>('/api/weight') })

/**
 * Enregistre la pesee du jour.
 *
 * Elle met AUSSI a jour le poids du profil cote serveur, puisque c'est de lui
 * que la cible se calcule : on invalide donc le profil, sans quoi l'ecran
 * continuerait d'afficher un objectif fonde sur l'ancien poids.
 */
export function useSaveWeighIn() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (pesee: WeighIn) => put<WeightResponse>('/api/weight', pesee),
    onSuccess: (data) => {
      client.setQueryData(keys.weight, data)
      void client.invalidateQueries({ queryKey: keys.profile })
    },
  })
}

export function useSaveProfile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (payload: ProfilePayload) => put<ProfileResponse>('/api/profile', payload),
    onSuccess: (data) => {
      // La reponse EST l'etat relu : on la pose directement plutot que de
      // declencher une seconde requete pour apprendre ce qu'on vient d'ecrire.
      client.setQueryData(keys.profile, data)
      // Les ecrans de nutrition comparent desormais leurs totaux a la cible :
      // changer de poids change ce qu'ils affichent.
      void client.invalidateQueries({ queryKey: ['calendar'] })
    },
  })
}

export const useCustomIcons = () =>
  useQuery({
    queryKey: keys.customIcons,
    queryFn: () => apiFetch<{ items: CustomIconItem[] }>('/api/icons'),
    // La bibliotheque bouge rarement et elle est lue par TOUS les ecrans qui
    // affichent un rayon : la relire a chaque montage serait du bruit reseau
    // pur.
    staleTime: 5 * 60_000,
  })

/** Le serveur repond aussi ce qu'il a retire du SVG colle. */
export type CreatedIcon = CustomIconItem & { readonly removed: string[] }

export function useCreateIcon() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (icon: { name: string; svg: string; keepColors: boolean }) =>
      post<CreatedIcon>('/api/icons', icon),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.customIcons }),
  })
}

export function useDeleteIcon() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => del<{ id: number }>(`/api/icons/${id}`),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.customIcons })
      // Un rayon qui s'y referait retombe sur l'icone deduite : sa pastille
      // change, donc les listes qui l'affichent doivent etre relues.
      void client.invalidateQueries({ queryKey: keys.rayons })
    },
  })
}

// ---------------------------------------------------------------------------
// Calendrier
// ---------------------------------------------------------------------------

export interface CalendarResponse {
  readonly isoWeek: string
  readonly entries: readonly MealPlanEntry[]
  /** Recettes et ingredients references, indexes par identifiant. */
  readonly recipes: Record<string, Recipe>
  readonly ingredients: Record<string, Ingredient>
}

export function useCalendar(isoWeek: string) {
  return useQuery({
    queryKey: keys.calendar(isoWeek),
    queryFn: () => apiFetch<CalendarResponse>(`/api/calendar/${isoWeek}`),
  })
}

/**
 * Toutes les ecritures du calendrier rendent la semaine complete.
 *
 * Le cache est donc alimente directement, sans requete de relecture : sur un
 * telephone, chaque aller-retour evite est une demi-seconde gagnee.
 */
function useCalendarMutation<TVars>(
  isoWeek: string,
  fn: (vars: TVars) => Promise<CalendarResponse>,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (week) => {
      client.setQueryData(keys.calendar(week.isoWeek), week)
      if (week.isoWeek !== isoWeek) void client.invalidateQueries({ queryKey: keys.calendar(isoWeek) })
      invalidateDerived(client)
    },
  })
}

export interface EntryDraft {
  readonly dayOfWeek: number
  readonly slot: string
  readonly recipeId: number | null
  readonly ingredientId: number | null
  readonly quantityG: number | null
  readonly portions: number | null
  /** Unite d'affichage choisie a la saisie. Voir la migration 0011. */
  readonly unit?: string | null
}

export const useAddEntry = (isoWeek: string) =>
  useCalendarMutation<EntryDraft>(isoWeek, (entry) =>
    post<CalendarResponse>(`/api/calendar/${isoWeek}/entries`, entry),
  )

export const useUpdateEntryAmount = (isoWeek: string) =>
  useCalendarMutation<{
    id: number
    quantityG: number | null
    portions: number | null
    /** L'unite voyage avec la quantite : les deux se decident ensemble. */
    unit: string | null
  }>(isoWeek, ({ id, ...body }) => patch<CalendarResponse>(`/api/calendar/entries/${id}`, body))

export const useMoveEntry = (isoWeek: string) =>
  useCalendarMutation<{ id: number; dayOfWeek: number; slot: string }>(isoWeek, ({ id, ...body }) =>
    put<CalendarResponse>(`/api/calendar/entries/${id}/move`, body),
  )

export const useDeleteEntry = (isoWeek: string) =>
  useCalendarMutation<number>(isoWeek, (id) => del<CalendarResponse>(`/api/calendar/entries/${id}`))

export const useClearDay = (isoWeek: string) =>
  useCalendarMutation<number>(isoWeek, (day) =>
    del<CalendarResponse>(`/api/calendar/${isoWeek}/days/${day}`),
  )

export const useClearWeek = (isoWeek: string) =>
  useCalendarMutation<void>(isoWeek, () => del<CalendarResponse>(`/api/calendar/${isoWeek}`))

export const useCopyWeek = (isoWeek: string) =>
  useCalendarMutation<string>(isoWeek, (from) =>
    post<CalendarResponse>(`/api/calendar/${isoWeek}/copy-from`, { from }),
  )

// ------------------------------------------------------------- modeles

export interface TemplateItem {
  readonly id: number
  readonly name: string
  readonly entryCount: number
  readonly updatedAt: string
}

export const useTemplates = () =>
  useQuery({ queryKey: keys.templates, queryFn: () => apiFetch<{ items: TemplateItem[] }>('/api/templates') })

export function useSaveTemplate() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (vars: { name: string; isoWeek: string }) =>
      post<{ id: number; items: TemplateItem[] }>('/api/templates', vars),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.templates }),
  })
}

export function useApplyTemplate(isoWeek: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => put<CalendarResponse>(`/api/templates/${id}/apply`, { isoWeek }),
    onSuccess: (week) => {
      client.setQueryData(keys.calendar(week.isoWeek), week)
      invalidateDerived(client)
    },
  })
}

export function useDeleteTemplate() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => del<{ id: number }>(`/api/templates/${id}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.templates }),
  })
}

// ---------------------------------------------------------------------------
// Frigo
// ---------------------------------------------------------------------------

export interface PantryResponse {
  readonly items: readonly PantryStock[]
  readonly ingredients: Record<string, Ingredient>
}

export const usePantry = () =>
  useQuery({ queryKey: keys.pantry, queryFn: () => apiFetch<PantryResponse>('/api/pantry') })

function usePantryMutation<TVars, TResult extends PantryResponse = PantryResponse>(
  fn: (vars: TVars) => Promise<TResult>,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (pantry) => {
      client.setQueryData(keys.pantry, pantry)
      // Le frigo se retranche de la liste de courses : elle change forcement.
      invalidateDerived(client)
    },
  })
}

export const useAddStock = () =>
  usePantryMutation<PantryStockWrite>((stock) => post<PantryResponse>('/api/pantry', stock))

export const useUpdateStock = () =>
  usePantryMutation<PantryStockWrite & { id: number }>(({ id, ...body }) =>
    put<PantryResponse>(`/api/pantry/${id}`, body),
  )

/**
 * Consommation partielle.
 *
 * La reponse dit ce qu'est devenu le lot : `removed` quand la quantite le vide
 * (la table interdit un lot a zero), sinon `remainingG`. L'ecran a besoin de
 * cette distinction pour annoncer « lot terminé » plutot que « mis à jour ».
 */
export interface ConsumeResponse extends PantryResponse {
  readonly removed: boolean
  readonly remainingG: number | null
}

/**
 * Ranger un lot, et rien d'autre.
 *
 * Passe par la route dediee et non par `useUpdateStock` : depuis l'onglet
 * "A ranger" on donne une place a huit articles d'affilee, et renvoyer une
 * fiche entiere qu'on n'a pas modifiee ferait ecraser par le cache une saisie
 * faite ailleurs.
 */
export const useSetStorage = () =>
  usePantryMutation<{ id: number; storage: StorageSpace | null }>(({ id, storage }) =>
    put<PantryResponse>(`/api/pantry/${id}/storage`, { storage }),
  )

/**
 * "Ranger comme d'habitude" : chaque lot pas encore range rejoint la place
 * habituelle de son produit, la ou il a ete range la derniere fois.
 */
export const useRangerHabituel = () =>
  usePantryMutation<void, PantryResponse & { readonly ranges: number }>(() =>
    post<PantryResponse & { readonly ranges: number }>('/api/pantry/ranger-habituel', {}),
  )

/** Le bilan des sorties depuis une date. Deux nombres, une requete. */
export const useMovements = (since: string) =>
  useQuery({
    queryKey: [...keys.pantry, 'movements', since],
    queryFn: () => apiFetch<{ consommeG: number; jeteG: number }>(`/api/pantry/movements?since=${since}`),
  })

export const useConsumeStock = () =>
  usePantryMutation<{ id: number; quantityG: number; reason: PantryMovementReason }, ConsumeResponse>(({ id, quantityG, reason }) =>
    post<ConsumeResponse>(`/api/pantry/${id}/consume`, { quantityG, reason }),
  )

export const useDeleteStock = () =>
  usePantryMutation<number>((id) => del<PantryResponse>(`/api/pantry/${id}`))

// ---------------------------------------------------------------------------
// Liste de courses
// ---------------------------------------------------------------------------

export interface ShoppingListResponse extends ShoppingList {
  /** Cases cochees, persistees cote serveur. */
  readonly checkedIngredientIds: readonly number[]
}

export function useShoppingList(isoWeek: string) {
  return useQuery({
    queryKey: keys.shopping(isoWeek),
    queryFn: () => apiFetch<ShoppingListResponse>(`/api/shopping/${isoWeek}`),
  })
}

/**
 * Coche ou decoche un article.
 *
 * Mise a jour optimiste : en magasin le reseau est mauvais, attendre la
 * reponse du serveur avant de cocher rendrait la liste inutilisable. On
 * applique le changement immediatement et on revient en arriere si l'appel
 * echoue.
 */
export function useToggleChecked(isoWeek: string) {
  const client = useQueryClient()
  const key = keys.shopping(isoWeek)

  return useMutation({
    mutationFn: (ingredientIds: readonly number[]) =>
      put<{ checkedIngredientIds: number[] }>(`/api/shopping/${isoWeek}/checked`, { ingredientIds }),

    onMutate: async (ingredientIds) => {
      // Sans cette annulation, une lecture encore en vol pourrait ecraser
      // la mise a jour optimiste en arrivant apres elle.
      await client.cancelQueries({ queryKey: key })
      const previous = client.getQueryData<ShoppingListResponse>(key)
      if (previous) {
        client.setQueryData<ShoppingListResponse>(key, { ...previous, checkedIngredientIds: ingredientIds })
      }
      return { previous }
    },

    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(key, context.previous)
    },
  })
}

export interface WeekCost {
  readonly isoWeek: string
  readonly totalEur: string
  readonly missingCount: number
  readonly capturedAt: string
}

export function useSnapshotWeek(isoWeek: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => post<WeekCost>(`/api/shopping/${isoWeek}/snapshot`, {}),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.shoppingHistory }),
  })
}

export const useShoppingHistory = () =>
  useQuery({
    queryKey: keys.shoppingHistory,
    queryFn: () => apiFetch<{ items: WeekCost[] }>('/api/shopping-history'),
  })

/** Semaine ISO courante, calculee sur l'heure LOCALE du telephone. */
export const useCurrentWeek = () => currentIsoWeek()

// ---------------------------------------------------------------------------
// Session de courses
// ---------------------------------------------------------------------------

/**
 * Le chariot en cours.
 *
 * L'etat vit sur le SERVEUR, pas dans le navigateur : en magasin, iOS decharge
 * volontiers un onglet passe en arriere-plan, et un chariot garde en memoire
 * disparaitrait apres vingt articles scannes. Chaque mutation rend l'etat
 * complet, qu'on repose directement dans le cache — un aller-retour de moins a
 * chaque scan, ce qui se sent sur le reseau d'un supermarche.
 */
export interface SessionState {
  readonly active: boolean
  readonly session: ShoppingSession | null
  /** Ingredients du chariot deja connus : sert a marquer la liste de courses. */
  readonly matchedIngredientIds?: readonly number[]
  readonly totalEur?: string
  readonly itemCount?: number
}

export interface CommitResult extends SessionState {
  readonly store: string
  readonly createdCount: number
  readonly stockedCount: number
  readonly pricedCount: number
  readonly totalEur: string
}

export const useShoppingSession = () =>
  useQuery({
    queryKey: keys.session,
    queryFn: () => apiFetch<SessionState>('/api/courses'),
    // En magasin on scanne a deux, parfois dans deux rayons differents : le
    // chariot doit se rafraichir tout seul quand l'autre y ajoute quelque chose.
    refetchInterval: (query) => (query.state.data?.active === true ? 20_000 : false),
  })

/*
 * LES ECRITURES DU CHARIOT PASSENT UNE PAR UNE. La session vit en un seul
 * JSON (`app_setting`) que chaque route relit puis reecrit : deux ecritures
 * croisees, et la seconde efface la premiere. Depuis que Savarin lit en
 * arriere-plan (plusieurs articles a la fois, pendant qu'on en ajoute
 * d'autres), ce croisement n'est plus rare. Chaque ecriture attend la
 * precedente, et pose l'etat rendu dans le cache AVANT de laisser passer la
 * suivante, qui relit donc un chariot a jour.
 */
let fileSession: Promise<unknown> = Promise.resolve()

function enFileSession<T>(travail: () => Promise<T>): Promise<T> {
  const suite = fileSession.then(travail, travail)
  fileSession = suite.catch(() => undefined)
  return suite
}

function useSessionMutation<TVars, TResult extends SessionState = SessionState>(
  fn: (vars: TVars) => Promise<TResult>,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (vars: TVars) =>
      enFileSession(async () => {
        const state = await fn(vars)
        client.setQueryData(keys.session, state)
        return state
      }),
  })
}

/**
 * Reecrire un article du chariot SANS ecran : ce que Savarin a lu en
 * arriere-plan. `calcul` recoit l'article tel qu'il est AU MOMENT de
 * l'ecriture (pas tel qu'il etait a l'envoi des photos) et rend ce qui part,
 * ou `null` pour ne rien ecrire. `false` : l'article n'existe plus.
 */
export function modifierArticleEnFond(
  id: string,
  calcul: (item: SessionItem) => SessionItemWrite | null,
): Promise<boolean> {
  return enFileSession(async () => {
    const item = queryClient.getQueryData<SessionState>(keys.session)?.session?.items.find((i) => i.id === id)
    if (item === undefined) return false
    const ecrit = calcul(item)
    if (ecrit === null) return true
    queryClient.setQueryData(keys.session, await put<SessionState>(`/api/courses/items/${id}`, ecrit))
    return true
  })
}

export const useStartSession = () =>
  useSessionMutation<{ store: string; isoWeek: string }>((vars) =>
    post<SessionState>('/api/courses', vars),
  )

export const useAddSessionItem = () =>
  useSessionMutation<SessionItemWrite>((item) => post<SessionState>('/api/courses/items', item))

export const useUpdateSessionItem = () =>
  useSessionMutation<SessionItemWrite & { id: string }>(({ id, ...item }) =>
    put<SessionState>(`/api/courses/items/${id}`, item),
  )

export const useRemoveSessionItem = () =>
  useSessionMutation<string>((id) => del<SessionState>(`/api/courses/items/${id}`))

/**
 * Lire une photo du ticket contre le chariot. Rien n'est ecrit : la reponse
 * est une proposition (shared/src/ticket.ts), relue avant d'etre appliquee.
 */
export const lireTicket = (image: Blob): Promise<TicketReading> =>
  apiFetch<TicketReading>('/api/courses/ticket', {
    method: 'POST',
    headers: { 'content-type': image.type || 'image/jpeg' },
    body: image,
  })

/** Ce que la personne a retenu du ticket, en une seule ecriture de la session. */
export const useAppliquerTicket = () =>
  useSessionMutation<
    ReadonlyArray<{ id: string; quantityG: number | null; priceEur: string | null }>
  >((lignes) => patch<SessionState>('/api/courses/items', { lignes }))

export const useAbandonSession = () =>
  useSessionMutation<void>(() => del<SessionState>('/api/courses'))

/**
 * Validation — le seul moment ou l'on ecrit ailleurs.
 *
 * Invalide LARGEMENT : la validation cree des fiches, pose des lots, releve des
 * prix et coche la liste. Presque tout l'ecran a bouge.
 */
export function useCommitSession() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => post<CommitResult>('/api/courses/commit', {}),
    onSuccess: (result) => {
      client.setQueryData(keys.session, { active: false, session: null })
      void client.invalidateQueries({ queryKey: ['ingredients'] })
      void client.invalidateQueries({ queryKey: keys.pantry })
      void client.invalidateQueries({ queryKey: ['shopping'] })
      void client.invalidateQueries({ queryKey: keys.activity })
      void client.invalidateQueries({ queryKey: keys.shoppingHistory })
      return result
    },
  })
}
/** Article envoye au serveur : l'identifiant et l'horodatage viennent de lui. */
export type SessionItemWrite = Omit<SessionItem, 'id' | 'scannedAt'>

/**
 * Enseignes deja rencontrees, les plus frequentes d'abord.
 *
 * Alimente la suggestion de magasin a l'ouverture d'une session. La source est
 * l'historique de prix, donc PARTAGEE entre les deux telephones du foyer — un
 * stockage local ne proposerait que ce que cet appareil a saisi.
 */
export const useStores = () =>
  useQuery({
    queryKey: ['stores'],
    queryFn: () => apiFetch<{ items: Array<{ store: string; count: number }> }>('/api/stores'),
    staleTime: 10 * 60 * 1000,
  })
